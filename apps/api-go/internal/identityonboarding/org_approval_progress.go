package identityonboarding

import (
	"encoding/json"
	"strings"
)

// This file holds the durable approval-progress model for new-organization
// applications. The four stages the product chain distinguishes are:
//
//   - review decision  -> RegistrationApplication.status + reviewedById/At
//   - created org      -> RegistrationApplication.orgId
//   - saved invite     -> RegistrationApplication.generatedInviteId
//   - delivery result  -> the approvalProgress sub-document of metadata
//
// Three of them are first-class columns, so this model only has to persist the
// delivery result plus enough context to resume safely. It never relies on the
// requested slug or the applicant email to guess an organization.

// deliveryStatus is the outcome of the generated invitation delivery attempt.
type deliveryStatus string

const (
	// deliveryStatusNone means the invitation row is committed but no SMTP
	// attempt has happened yet (first attempt pending, e.g. after a crash
	// between commit and send).
	deliveryStatusNone deliveryStatus = "none"
	// deliveryStatusSent means the last attempt reported success.
	deliveryStatusSent deliveryStatus = "sent"
	// deliveryStatusFailed means the last attempt returned an error.
	deliveryStatusFailed deliveryStatus = "failed"
	// deliveryStatusUnknown covers legacy rows and windows where delivery may
	// have happened but the result was not recorded. It is never a promise of
	// exactly-once delivery.
	deliveryStatusUnknown deliveryStatus = "unknown"
)

// applicationApprovalProgress is the JSON leaf stored in the metadata column
// under the approvalProgress key. Extending the leaf keeps the column generic
// while the value stays a named, strongly typed struct.
type applicationApprovalProgress struct {
	OrgCreated       bool           `json:"orgCreated"`
	InviteSaved      bool           `json:"inviteSaved"`
	DeliveryStatus   deliveryStatus `json:"deliveryStatus"`
	DeliveryAttempts int            `json:"deliveryAttempts"`
	LastDeliveryAt   *string        `json:"lastDeliveryAt,omitempty"`
	LastDeliveryErr  *string        `json:"lastDeliveryError,omitempty"`
}

// storedApprovalMetadata is the JSON document persisted in metadata. Only the
// approvalProgress key is written by this unit; an old row with other keys is
// left alone until it is rewritten by a real progress update.
type storedApprovalMetadata struct {
	ApprovalProgress *applicationApprovalProgress `json:"approvalProgress,omitempty"`
}

// approvalProgressView is the read projection exposed to the Web console. It
// merges the durable record with the current column and invitation state so a
// historical half-complete row is still actionable, and it carries the derived
// next-step flags the UI uses. It contains no secrets and no token material.
type approvalProgressView struct {
	OrgCreated          bool    `json:"orgCreated"`
	InviteSaved         bool    `json:"inviteSaved"`
	DeliveryStatus      string  `json:"deliveryStatus"`
	DeliveryAttempts    int     `json:"deliveryAttempts"`
	LastDeliveryAt      *string `json:"lastDeliveryAt"`
	LastDeliveryError   *string `json:"lastDeliveryError"`
	AssociationComplete bool    `json:"associationComplete"`
	NeedsRecovery       bool    `json:"needsRecovery"`
	NeedsDeliveryRetry  bool    `json:"needsDeliveryRetry"`
	InviteStatus        *string `json:"inviteStatus"`
}

// parseApprovalProgress decodes the approvalProgress leaf. A null, empty or
// unreadable document yields nil; the caller falls back to the column state.
func parseApprovalProgress(metadata json.RawMessage) *applicationApprovalProgress {
	if len(metadata) == 0 {
		return nil
	}
	var document storedApprovalMetadata
	if err := json.Unmarshal(metadata, &document); err != nil {
		return nil
	}
	return document.ApprovalProgress
}

// encodeApprovalMetadata serializes the progress leaf. The only failure mode is
// an unsupported type, which cannot happen for this struct; a nil result is
// treated as an empty metadata column by the caller.
func encodeApprovalMetadata(progress *applicationApprovalProgress) json.RawMessage {
	raw, err := json.Marshal(storedApprovalMetadata{ApprovalProgress: progress})
	if err != nil {
		return nil
	}
	return raw
}

// buildProgressView derives the response projection from the stored row and,
// when available, the generated invitation. It is nil for join applications.
func buildProgressView(application applicationRecord, invite *inviteRecord) *approvalProgressView {
	if application.Type != applicationTypeNewOrg {
		return nil
	}
	stored := parseApprovalProgress(application.Metadata)
	view := approvalProgressView{
		OrgCreated:       application.OrgID != nil,
		InviteSaved:      application.GeneratedInviteID != nil,
		DeliveryStatus:   string(deliveryStatusUnknown),
		DeliveryAttempts: 0,
	}
	if stored != nil {
		// The stored stage flags fill the window between the committed columns
		// and a metadata rewrite, but the columns remain authoritative.
		if !view.OrgCreated && stored.OrgCreated {
			view.OrgCreated = true
		}
		if !view.InviteSaved && stored.InviteSaved {
			view.InviteSaved = true
		}
		view.DeliveryStatus = string(stored.DeliveryStatus)
		view.DeliveryAttempts = stored.DeliveryAttempts
		view.LastDeliveryAt = stored.LastDeliveryAt
		view.LastDeliveryError = stored.LastDeliveryErr
	}
	if application.Status == applicationStatusPending || application.Status == applicationStatusRejected {
		view.DeliveryStatus = string(deliveryStatusNone)
	}
	view.AssociationComplete = view.OrgCreated && view.InviteSaved
	if invite != nil {
		status := string(invite.Status)
		view.InviteStatus = &status
	}
	if application.Status == applicationStatusApproved {
		view.NeedsRecovery = !view.AssociationComplete
		// "none" is the window between the committed database stage and the
		// first send attempt (a crash): the row is complete but never delivered,
		// so it is still a delivery-retry state rather than a finished approval.
		view.NeedsDeliveryRetry = view.AssociationComplete &&
			(view.DeliveryStatus == string(deliveryStatusFailed) ||
				view.DeliveryStatus == string(deliveryStatusUnknown) ||
				view.DeliveryStatus == string(deliveryStatusNone))
	}
	return &view
}

// sanitizeDeliveryError keeps a short, single-line diagnostic for the console.
// SMTP credentials never appear in these errors; the cap and newline folding
// still keep the stored value from growing without bound.
func sanitizeDeliveryError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.ReplaceAll(strings.ReplaceAll(err.Error(), "\n", " "), "\r", " ")
	message = strings.TrimSpace(message)
	if len(message) > 500 {
		message = message[:500]
	}
	return message
}

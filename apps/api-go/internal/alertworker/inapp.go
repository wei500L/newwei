package alertworker

import (
	"context"
	"encoding/json"
	"strings"
)

// resolveInAppRecipients is the port of resolveInAppRecipients plus
// filterRecipientsWithAlertReadAccess (O4).
//
// The NestJS implementation runs one membership query to collect the
// notifyAll recipients and a second one to filter them by alerts.read. Here the
// candidate set and the permission verdicts come from ONE query: the
// organization's memberships with their eligibility flags and permission names
// are read once, and the fallback between the linked roles and the primary role
// is applied in memory.
func (s *Service) resolveInAppRecipients(ctx context.Context, rule Rule) (RecipientResolution, error) {
	metadata, _ := parseJSONObject(rule.Metadata)
	recipients := newOrderedSet()
	if metadata != nil {
		for _, userID := range toStringArray(metadata, "notifyUserIds") {
			recipients.Add(userID)
		}
	}
	notifyAll := false
	if metadata != nil {
		if value, ok := boolField(metadata, "notifyAllMembers"); ok && value {
			notifyAll = true
		}
		if value, ok := boolField(metadata, "notifyAllUsers"); ok && value {
			notifyAll = true
		}
	}

	var entries []candidateMembership
	if notifyAll {
		rows, err := s.repo.listCandidateMemberships(ctx, s.db, rule.OrgID, nil)
		if err != nil {
			return RecipientResolution{}, err
		}
		entries = rows
		for _, row := range rows {
			recipients.Add(row.UserID)
		}
	}
	if recipients.Len() == 0 && rule.CreatedByID != nil {
		recipients.Add(*rule.CreatedByID)
	}
	candidateUserIDs := recipients.Values()
	if len(candidateUserIDs) == 0 {
		return RecipientResolution{}, nil
	}
	if entries == nil {
		rows, err := s.repo.listCandidateMemberships(ctx, s.db, rule.OrgID, candidateUserIDs)
		if err != nil {
			return RecipientResolution{}, err
		}
		entries = rows
	}
	verdicts := membershipPermissionVerdicts(entries)
	allowed := make([]string, 0, len(candidateUserIDs))
	missing := make([]string, 0, len(candidateUserIDs))
	for _, userID := range candidateUserIDs {
		verdict, ok := verdicts[userID]
		if !ok {
			continue
		}
		if verdict.allowed {
			allowed = append(allowed, userID)
			continue
		}
		if verdict.missing {
			missing = append(missing, userID)
		}
	}
	return RecipientResolution{
		CandidateUserIDs:         candidateUserIDs,
		AllowedUserIDs:           allowed,
		MissingPermissionUserIDs: missing,
	}, nil
}

// membershipVerdict is the permission outcome of one candidate.
type membershipVerdict struct {
	allowed bool
	missing bool
}

// membershipPermissionVerdicts applies collectMembershipPermissionSet's rule to
// the flat query rows: the linked MembershipRole roles win, and the primary role
// is only used when the membership has no link at all. A membership that is not
// eligible (inactive membership, inactive user, inactive org) produces no
// verdict, exactly like the NestJS query that simply does not return it.
func membershipPermissionVerdicts(entries []candidateMembership) map[string]membershipVerdict {
	hasLink := make(map[string]bool, len(entries))
	eligible := make(map[string]bool, len(entries))
	userOf := make(map[string]string, len(entries))
	allowed := make(map[string]bool, len(entries))
	for _, entry := range entries {
		userOf[entry.MembershipID] = entry.UserID
		if entry.FromLink {
			hasLink[entry.MembershipID] = true
		}
		if entry.Eligible {
			eligible[entry.MembershipID] = true
		}
	}
	for _, entry := range entries {
		if !entry.Eligible {
			continue
		}
		if entry.FromLink != hasLink[entry.MembershipID] {
			continue
		}
		if entry.PermissionName != nil && *entry.PermissionName == alertsReadPermission {
			allowed[entry.MembershipID] = true
		}
	}
	verdicts := make(map[string]membershipVerdict, len(eligible))
	for membershipID, isEligible := range eligible {
		if !isEligible {
			continue
		}
		userID := userOf[membershipID]
		if userID == "" {
			continue
		}
		if allowed[membershipID] {
			verdicts[userID] = membershipVerdict{allowed: true}
			continue
		}
		verdicts[userID] = membershipVerdict{missing: true}
	}
	return verdicts
}

// deliverInAppNotifications is the port of deliverInAppNotifications: it writes
// one Notification row per in-app delivery, marks the delivery sent or failed,
// asks NestJS to push the notification over its gateway and finally reconciles
// the event status.
func (s *Service) deliverInAppNotifications(ctx context.Context, rule Rule, event EventRow, contextObject *jsonObject, deliveries []InAppDelivery) {
	metricSlug := normalizeMetricSlug(rule.MetricSlug)
	title := "Alert triggered: " + rule.Name
	changeText := ""
	if event.ChangePercent != nil && isFinite(*event.ChangePercent) {
		changeText = " (" + FormatJSFixed(*event.ChangePercent, 2) + "%)"
	}
	body := ""
	if event.Message != nil {
		body = *event.Message
	} else {
		valueText := "N/A"
		if isFinite(event.MetricValue) {
			valueText = FormatJSNumber(event.MetricValue)
		}
		body = "Metric " + metricSlug + " triggered at " + valueText + changeText
	}
	contextSummary := buildNotificationContextSummary(contextObject)

	for _, delivery := range deliveries {
		userID := delivery.UserID
		notificationID, err := randomRowID()
		if err != nil {
			s.failInAppDelivery(ctx, delivery, userID, err.Error())
			continue
		}
		data := notificationData{
			AlertEventID:  event.ID,
			RuleID:        rule.ID,
			RuleName:      rule.Name,
			Severity:      event.Severity,
			MetricSlug:    metricSlug,
			MetricValue:   event.MetricValue,
			ChangePercent: event.ChangePercent,
			Context:       contextSummary,
			Presentation: notificationPresentation{
				Kind: presentationKindAlertTriggered,
				Params: notificationPresentationParams{
					AlertEventID:  event.ID,
					RuleID:        rule.ID,
					RuleName:      rule.Name,
					Severity:      event.Severity,
					MetricSlug:    metricSlug,
					MetricValue:   event.MetricValue,
					ChangePercent: event.ChangePercent,
					Context:       contextSummary,
				},
				TechnicalDetail: event.Message,
			},
		}
		encoded, err := json.Marshal(data)
		if err != nil {
			s.failInAppDelivery(ctx, delivery, userID, err.Error())
			continue
		}
		now := s.now()
		if err := s.repo.insertNotification(ctx, s.db, notificationID, rule.OrgID, userID, title, body, encoded, now); err != nil {
			s.failInAppDelivery(ctx, delivery, userID, err.Error())
			continue
		}
		snapshot, err := json.Marshal(inAppTargetSnapshot{UserID: userID, NotificationID: notificationID})
		if err != nil {
			s.failInAppDelivery(ctx, delivery, userID, err.Error())
			continue
		}
		if err := s.repo.writeInAppDelivery(ctx, s.db, delivery.ID, snapshot, now); err != nil {
			s.logf("alertworker: mark in-app delivery %s sent: %v", delivery.ID, err)
			continue
		}
		// The relay only asks NestJS to push the row over its Socket.IO gateway.
		// Feeding it back into the shared NotificationDispatcher would duplicate
		// every alert once per NestJS instance, because the Socket.IO Redis
		// adapter already broadcasts room emits.
		s.publishNotificationRelay(ctx, notificationID, rule.OrgID, userID)
	}
	s.reconcileEventStatus(ctx, event.ID)
}

// failInAppDelivery records one failed in-app delivery with the {userId}
// snapshot, like the NestJS catch branch.
func (s *Service) failInAppDelivery(ctx context.Context, delivery InAppDelivery, userID, message string) {
	snapshot, err := json.Marshal(inAppTargetSnapshot{UserID: userID})
	if err != nil {
		s.logf("alertworker: encode in-app failure snapshot: %v", err)
		return
	}
	if err := s.repo.writeInAppDeliveryFailure(ctx, s.db, delivery.ID, snapshot, message); err != nil {
		s.logf("alertworker: mark in-app delivery %s failed: %v", delivery.ID, err)
	}
}

// buildNotificationContextSummary copies the six string context fields the alert
// notification presentation carries. It is nil when the event has no context
// object; otherwise it is a (possibly empty) object, exactly like the NestJS
// contextSummary.
func buildNotificationContextSummary(contextObject *jsonObject) *notificationContextSummary {
	if contextObject == nil {
		return nil
	}
	summary := &notificationContextSummary{}
	summary.CountryCode = stringFieldPtr(contextObject, "countryCode")
	summary.CountryName = stringFieldPtr(contextObject, "countryName")
	summary.ItemName = stringFieldPtr(contextObject, "itemName")
	summary.SourceName = stringFieldPtr(contextObject, "sourceName")
	summary.RecordedAt = stringFieldPtr(contextObject, "recordedAt")
	summary.Unit = stringFieldPtr(contextObject, "unit")
	return summary
}

func stringFieldPtr(object *jsonObject, key string) *string {
	value, ok := stringField(object, key)
	if !ok {
		return nil
	}
	return &value
}

// toStringArray mirrors AlertsService.toStringArray: keep the array entries that
// are strings, trim them and drop the empty ones.
func toStringArray(object *jsonObject, key string) []string {
	raw, ok := object.Get(key)
	if !ok {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		var value string
		if err := json.Unmarshal(entry, &value); err != nil {
			continue
		}
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		result = append(result, trimmed)
	}
	return result
}

// orderedSet is an insertion-ordered string set, mirroring the JavaScript Set
// the recipient resolution builds.
type orderedSet struct {
	seen   map[string]struct{}
	values []string
}

func newOrderedSet() *orderedSet {
	return &orderedSet{seen: map[string]struct{}{}}
}

func (s *orderedSet) Add(value string) {
	if value == "" {
		return
	}
	if _, exists := s.seen[value]; exists {
		return
	}
	s.seen[value] = struct{}{}
	s.values = append(s.values, value)
}

func (s *orderedSet) Len() int {
	if s == nil {
		return 0
	}
	return len(s.values)
}

func (s *orderedSet) Values() []string {
	if s == nil {
		return nil
	}
	return s.values
}

// reconcileEventStatus is the port of reconcileEventStatus (O5): it reads only
// the status columns, keeps confirmed/ignored events untouched, leaves the event
// alone while any delivery is in flight and otherwise settles it as delivered
// when at least one delivery was sent and failed otherwise.
func (s *Service) reconcileEventStatus(ctx context.Context, eventID string) {
	status, err := s.repo.loadEventStatus(ctx, s.db, eventID)
	if err != nil {
		s.logf("alertworker: reconcile event %s: %v", eventID, err)
		return
	}
	if status == nil || *status == EventStatusConfirmed || *status == EventStatusIgnored {
		return
	}
	statuses, err := s.repo.listDeliveryStatuses(ctx, s.db, eventID)
	if err != nil {
		s.logf("alertworker: reconcile event %s: %v", eventID, err)
		return
	}
	if len(statuses) == 0 {
		return
	}
	anySent := false
	for _, deliveryStatus := range statuses {
		if deliveryStatus == DeliveryStatusPending || deliveryStatus == DeliveryStatusSending {
			return
		}
		if deliveryStatus == DeliveryStatusSent {
			anySent = true
		}
	}
	next := EventStatusFailed
	if anySent {
		next = EventStatusDelivered
	}
	if err := s.repo.updateEventStatus(ctx, s.db, eventID, next); err != nil {
		s.logf("alertworker: reconcile event %s: %v", eventID, err)
	}
}

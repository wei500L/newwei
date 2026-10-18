package workspacewrite

import (
	"encoding/json"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	alertEventStatusConfirmed = "confirmed"
	alertEventStatusIgnored   = "ignored"
)

// feedbackUpdate carries the context.feedback members one status update writes.
// NoteSet distinguishes an absent note (keep the stored one) from a supplied
// note, including an explicit null (write JSON null).
type feedbackUpdate struct {
	Status      string
	UpdatedAt   string
	Note        *string
	NoteSet     bool
	UpdatedByID *string
}

// members renders the feedback members in the order the NestJS merge writes
// them. A supplied note that trims to empty is written as JSON null.
func (u feedbackUpdate) members() ([]jsonMember, error) {
	members := make([]jsonMember, 0, 4)
	if u.NoteSet {
		if u.Note == nil || jsTrim(*u.Note) == "" {
			members = append(members, jsonMember{Key: "note", Value: json.RawMessage("null")})
		} else {
			encoded, err := json.Marshal(jsTrim(*u.Note))
			if err != nil {
				return nil, err
			}
			members = append(members, jsonMember{Key: "note", Value: encoded})
		}
	}
	if u.UpdatedByID != nil {
		encoded, err := json.Marshal(*u.UpdatedByID)
		if err != nil {
			return nil, err
		}
		members = append(members, jsonMember{Key: "updatedById", Value: encoded})
	}
	status, err := json.Marshal(u.Status)
	if err != nil {
		return nil, err
	}
	updatedAt, err := json.Marshal(u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	members = append(members, jsonMember{Key: "status", Value: status}, jsonMember{Key: "updatedAt", Value: updatedAt})
	return members, nil
}

// mergeEventFeedback rebuilds the event context with the merged feedback object.
//
// A context or feedback value that is not a JSON object is treated as an empty
// object, matching the NestJS `?? {}` spreads. Every other member is copied as
// an opaque JSON leaf, so metric snapshots and unknown feedback fields survive
// and the explicit note null is kept. nil means nothing should be written,
// which is the NestJS `nextContext === undefined` branch.
func mergeEventFeedback(rawContext json.RawMessage, update feedbackUpdate) (json.RawMessage, error) {
	if !update.NoteSet && update.UpdatedByID == nil {
		return nil, nil
	}
	members, err := update.members()
	if err != nil {
		return nil, err
	}
	base := json.RawMessage(nil)
	if existing, ok := jsonObjectMember(rawContext, "feedback"); ok && jsonShapeOf(existing) == jsonShapeObject {
		base = existing
	}
	merged, err := mergeJSONObject(base, members)
	if err != nil {
		return nil, err
	}
	return mergeJSONObject(rawContext, []jsonMember{{Key: "feedback", Value: merged}})
}

// updateAlertEventStatus writes the review status of one event of the caller's
// organization and merges the feedback fields into its context.
//
// Only confirmed and ignored are accepted; any other SDL enum member keeps the
// existing "Unsupported alert event status update" branch. AlertEvent has no
// orgId column, so the event is located and updated through its AlertRule
// relation. The returned model is reloaded with the same serializer the alert
// read roots use.
func (s *service) updateAlertEventStatus(ctx contract.Context, input updateAlertEventStatusInput) (alerts.AlertEventModel, error) {
	if s == nil || s.db == nil {
		return alerts.AlertEventModel{}, errDatabaseUnavailable
	}
	if input.Status != alertEventStatusConfirmed && input.Status != alertEventStatusIgnored {
		// NestJS raises an ordinary Error here, which the global filter reports
		// as 500 / Internal server error.
		return alerts.AlertEventModel{}, errors.New("Unsupported alert event status update")
	}
	callCtx := callContext(ctx)
	orgID := ctx.Identity.OrgID
	rawContext, found, err := alerts.EventContextForOrg(callCtx, s.db, orgID, input.EventID)
	if err != nil {
		return alerts.AlertEventModel{}, err
	}
	if !found {
		return alerts.AlertEventModel{}, errors.New("Alert event not found for this org")
	}
	update := feedbackUpdate{Status: input.Status, UpdatedAt: contract.FormatDateTime(nowMillis()), Note: input.Note, NoteSet: input.NoteSet}
	if ctx.Identity.UserID != "" {
		actorID := ctx.Identity.UserID
		update.UpdatedByID = &actorID
	}
	nextContext, err := mergeEventFeedback(rawContext, update)
	if err != nil {
		return alerts.AlertEventModel{}, err
	}
	if nextContext == nil {
		if _, err := s.db.ExecContext(callCtx,
			"UPDATE `AlertEvent` AS e INNER JOIN `AlertRule` AS r ON r.`id` = e.`ruleId` "+
				"SET e.`status` = ? WHERE e.`id` = ? AND r.`orgId` = ?",
			input.Status, input.EventID, orgID); err != nil {
			return alerts.AlertEventModel{}, err
		}
	} else {
		if _, err := s.db.ExecContext(callCtx,
			"UPDATE `AlertEvent` AS e INNER JOIN `AlertRule` AS r ON r.`id` = e.`ruleId` "+
				"SET e.`status` = ?, e.`context` = CAST(? AS JSON) WHERE e.`id` = ? AND r.`orgId` = ?",
			input.Status, string(nextContext), input.EventID, orgID); err != nil {
			return alerts.AlertEventModel{}, err
		}
	}
	model, err := alerts.LoadEventModel(callCtx, s.db, orgID, input.EventID)
	if err != nil {
		return alerts.AlertEventModel{}, err
	}
	if model == nil {
		return alerts.AlertEventModel{}, errors.New("Alert event not found for this org")
	}
	return *model, nil
}

// updateAlertEventStatusResolver returns the complete alert event model.
func (s *service) updateAlertEventStatusResolver(ctx contract.Context) (alerts.AlertEventModel, error) {
	input, err := parseUpdateAlertEventStatusInput(ctx.Args)
	if err == nil {
		var model alerts.AlertEventModel
		if model, err = s.updateAlertEventStatus(ctx, input); err == nil {
			return model, nil
		}
	}
	return alerts.AlertEventModel{}, graphqlFailure(err)
}

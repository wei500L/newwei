package userdigest

import (
	"context"
	"log"
	"strings"
	"time"
)

const (
	statusIdle         = "idle"
	statusSent         = "sent"
	statusEmpty        = "empty_notified"
	statusFailed       = "failed"
	unverifiedEmailErr = "Email is no longer verified for this user"
	deliveryFailedErr  = "Digest email delivery failed"
)

// runDueDeliveriesForOrg scans one organization's due schedules page by page and
// processes them sequentially, matching the NestJS per-organization order. The
// cutoff is fixed for the whole organization run. Pagination uses the original
// nextRunAt/updatedAt/id cursor so a write-back cannot skip or duplicate a later
// row.
func (s *DeliveryScheduler) runDueDeliveriesForOrg(ctx context.Context, orgID string, now time.Time) (DigestDeliveryOrgRunSummary, error) {
	summary := DigestDeliveryOrgRunSummary{}
	var cursor *DeliveryCursor
	for {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		records, err := s.deps.Repository.ListDueSchedules(ctx, orgID, now, cursor, deliveryScanBatchSize)
		if err != nil {
			return summary, err
		}
		if len(records) == 0 {
			return summary, nil
		}
		for index := range records {
			summary.DueCount++
			switch s.processDueScheduleSafely(ctx, records[index], now) {
			case statusSent:
				summary.SentCount++
			case statusEmpty:
				summary.EmptyCount++
			case statusFailed:
				summary.FailedCount++
			}
		}
		last := records[len(records)-1]
		cursor = &DeliveryCursor{NextRunAt: last.NextRunAt, UpdatedAt: last.UpdatedAt, ID: last.ID}
		if len(records) < deliveryScanBatchSize {
			return summary, nil
		}
	}
}

// processDueScheduleSafely keeps one failing schedule from aborting the
// organization run. The returned status is the delivery status written for the
// row, matching UserDigestDeliveryStatus.
func (s *DeliveryScheduler) processDueScheduleSafely(ctx context.Context, record DeliveryScheduleRecord, now time.Time) string {
	status, err := s.processDueSchedule(ctx, record, now)
	if err != nil {
		log.Printf("userdigest: process delivery schedule failed scheduleId=%s orgId=%s userId=%s err=%v", record.ID, record.OrgID, record.UserID, err)
		return statusFailed
	}
	return status
}

// processDueSchedule implements the NestJS branch order: unverified email,
// digest generation, empty digest, then email delivery. Generation and SMTP
// failures both advance the slot before writing failed, and a lost CAS claim
// returns idle without email or notification.
func (s *DeliveryScheduler) processDueSchedule(ctx context.Context, record DeliveryScheduleRecord, now time.Time) (string, error) {
	config := deliveryScheduleConfig{Timezone: record.Timezone, SendHour: record.SendHour, SendMinute: record.SendMinute}
	nextRunAt, err := computeNextRunAt(config.Timezone, config.SendHour, config.SendMinute, now)
	if err != nil {
		return "", err
	}

	if !record.EmailVerified {
		message := unverifiedEmailErr
		claimed, err := s.deps.Repository.ClaimDueSlot(ctx, record, DeliverySlotClaim{
			Enabled:      false,
			NextRunAt:    nil,
			LastStatus:   statusFailed,
			LastStatusAt: now,
			LastError:    &message,
		})
		if err != nil {
			return "", err
		}
		if !claimed {
			return statusIdle, nil
		}
		s.notifyFailure(ctx, record, message)
		return statusFailed, nil
	}

	digest, err := s.deps.Digest.GenerateDigest(ctx, record.OrgID, record.UserID)
	if err != nil {
		message := deliveryErrorMessage(err)
		claimed, claimErr := s.deps.Repository.ClaimDueSlot(ctx, record, DeliverySlotClaim{
			Enabled:      true,
			NextRunAt:    &nextRunAt,
			LastStatus:   statusFailed,
			LastStatusAt: now,
			LastError:    &message,
		})
		if claimErr != nil {
			return "", claimErr
		}
		if !claimed {
			return statusIdle, nil
		}
		s.notifyFailure(ctx, record, message)
		return statusFailed, nil
	}

	if len(digest.Events) == 0 {
		claimed, err := s.deps.Repository.ClaimDueSlot(ctx, record, DeliverySlotClaim{
			Enabled:      true,
			NextRunAt:    &nextRunAt,
			LastStatus:   statusEmpty,
			LastStatusAt: now,
			LastError:    nil,
		})
		if err != nil {
			return "", err
		}
		if !claimed {
			return statusIdle, nil
		}
		s.notifyEmpty(ctx, record, nextRunAt)
		return statusEmpty, nil
	}

	// Claim the slot by advancing nextRunAt before touching SMTP. The previous
	// lastStatus/lastError are preserved exactly like the NestJS update that
	// only writes nextRunAt and lastStatusAt at this point.
	lastStatus := record.LastStatus
	if lastStatus == "" {
		lastStatus = statusIdle
	}
	claimed, err := s.deps.Repository.ClaimDueSlot(ctx, record, DeliverySlotClaim{
		Enabled:      true,
		NextRunAt:    &nextRunAt,
		LastStatus:   lastStatus,
		LastStatusAt: now,
		LastError:    record.LastError,
	})
	if err != nil {
		return "", err
	}
	if !claimed {
		return statusIdle, nil
	}

	message := buildDigestEmail(digest, config, record.FirstName, record.Email, s.deps.ConsoleBaseURL)
	if err := s.deps.Mail.Send(ctx, message); err != nil {
		return s.failClaimedSlot(ctx, record, now, err)
	}
	sentAt := now
	if err := s.deps.Repository.UpdateClaimedSlot(ctx, record, DeliveryClaimedUpdate{
		LastSentAt:   &sentAt,
		LastStatus:   statusSent,
		LastStatusAt: now,
		LastError:    nil,
	}); err != nil {
		return "", err
	}
	s.notifyReady(ctx, record, digest, nextRunAt)
	return statusSent, nil
}

// failClaimedSlot writes the failure result for a slot this process already
// claimed. It never advances nextRunAt a second time and never re-claims the
// slot.
func (s *DeliveryScheduler) failClaimedSlot(ctx context.Context, record DeliveryScheduleRecord, now time.Time, cause error) (string, error) {
	message := deliveryErrorMessage(cause)
	if err := s.deps.Repository.UpdateClaimedSlot(ctx, record, DeliveryClaimedUpdate{
		LastSentAt:   nil,
		LastStatus:   statusFailed,
		LastStatusAt: now,
		LastError:    &message,
	}); err != nil {
		return "", err
	}
	s.notifyFailure(ctx, record, message)
	return statusFailed, nil
}

// deliveryErrorMessage mirrors the NestJS toErrorMessage: a non-empty trimmed
// message is sliced to 191 UTF-16 units, otherwise the generic failure text is
// used.
func deliveryErrorMessage(err error) string {
	if err != nil {
		trimmed := strings.TrimSpace(err.Error())
		if trimmed != "" {
			return jsSlice(trimmed, 191)
		}
	}
	return deliveryFailedErr
}

// notifyReady is best effort: a notification failure is logged and never changes
// a successfully sent email into a delivery failure.
func (s *DeliveryScheduler) notifyReady(ctx context.Context, record DeliveryScheduleRecord, digest Digest, nextRunAt time.Time) {
	if s.deps.Notifier == nil {
		return
	}
	if err := s.deps.Notifier.NotifyReady(ctx, record.OrgID, record.UserID, DigestReadyParams{
		Link:        notificationLinkToday,
		EventCount:  len(digest.Events),
		GeneratedAt: digest.GeneratedAt,
		NextRunAt:   isoTime(nextRunAt),
	}); err != nil {
		log.Printf("userdigest: notify digest ready failed scheduleId=%s orgId=%s userId=%s err=%v", record.ID, record.OrgID, record.UserID, err)
	}
}

// notifyEmpty is best effort.
func (s *DeliveryScheduler) notifyEmpty(ctx context.Context, record DeliveryScheduleRecord, nextRunAt time.Time) {
	if s.deps.Notifier == nil {
		return
	}
	if err := s.deps.Notifier.NotifyEmpty(ctx, record.OrgID, record.UserID, DigestEmptyParams{
		Link:      notificationLinkToday,
		NextRunAt: isoTime(nextRunAt),
	}); err != nil {
		log.Printf("userdigest: notify digest empty failed scheduleId=%s orgId=%s userId=%s err=%v", record.ID, record.OrgID, record.UserID, err)
	}
}

// notifyFailure is best effort.
func (s *DeliveryScheduler) notifyFailure(ctx context.Context, record DeliveryScheduleRecord, message string) {
	if s.deps.Notifier == nil {
		return
	}
	if err := s.deps.Notifier.NotifyFailure(ctx, record.OrgID, record.UserID, DigestFailureParams{
		Link:        notificationLinkToday,
		TargetEmail: record.Email,
		Message:     message,
	}); err != nil {
		log.Printf("userdigest: notify digest failure failed scheduleId=%s orgId=%s userId=%s err=%v", record.ID, record.OrgID, record.UserID, err)
	}
}

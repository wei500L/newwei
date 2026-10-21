package crawlexecution

// Crawl completion notifications (CrawlExecutionResultsService.safeNotifyCrawl).
//
// A notification is a MySQL Notification row plus one identifiers-only relay
// message on notification:events:v1. The row is the source of truth: the
// subscriber re-reads it by id + orgId (+ userId) before pushing, so the relay
// payload never carries the body. When notifications are disabled in the Go
// worker (no relay publisher injected) the row is still written and only the
// relay is skipped, exactly like NotificationsService.notify with a disabled
// realtime relay.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
)

// Notification type values (Prisma NotificationType).
const (
	notificationTypeCrawlCompleted = "crawl_completed"
	notificationTypeCrawlFailed    = "crawl_failed"

	// notificationStatusCompleted/notificationStatusFailed are the summary
	// status values safeNotifyCrawl accepts.
	notificationStatusCompleted = "completed"
	notificationStatusFailed    = "failed"

	// notificationPresentationKindCrawlCompleted/Failed are the presentation
	// kinds the console renders.
	presentationKindCrawlCompleted = "crawl_completed"
	presentationKindCrawlFailed    = "crawl_failed"

	// notificationMaxAttempts and notificationBackoffBaseMs are the delivery
	// retry policy: three attempts, min(250 * 2^(n-1), 2000) ms apart.
	notificationMaxAttempts   = 3
	notificationBackoffBaseMs = 250
	notificationBackoffCapMs  = 2_000
)

// NotificationRelayPublisher publishes the identifiers-only notification relay
// message after a row is committed. An empty userID means an organization-wide
// row (userId NULL); the publisher then omits the member.
type NotificationRelayPublisher func(ctx context.Context, notificationID, orgID, userID string) error

// crawlNotificationParams is presentation.params.
type crawlNotificationParams struct {
	TaskID            string  `json:"taskId"`
	TaskLabel         string  `json:"taskLabel"`
	Inserted          int     `json:"inserted"`
	Skipped           int     `json:"skipped"`
	RetryableFailures *int    `json:"retryableFailures,omitempty"`
	LastResultAt      *string `json:"lastResultAt,omitempty"`
}

// crawlNotificationPresentation is data.presentation.
type crawlNotificationPresentation struct {
	Kind            string                  `json:"kind"`
	Params          crawlNotificationParams `json:"params"`
	TechnicalDetail string                  `json:"technicalDetail,omitempty"`
}

// crawlNotificationData is the Notification.data payload. lastResultAt is always
// present and null when the summary has no fetch time, matching the NestJS
// object which sets the member to null.
type crawlNotificationData struct {
	TaskID       string                        `json:"taskId"`
	Status       string                        `json:"status"`
	LastResultAt *string                       `json:"lastResultAt"`
	Presentation crawlNotificationPresentation `json:"presentation"`
}

// crawlNotificationPayload is one rendered notification ready to persist.
type crawlNotificationPayload struct {
	Type  string
	Title string
	Body  string
	Data  crawlNotificationData
}

// safeNotifyCrawl is safeNotifyCrawl: render, then deliver with up to three
// attempts and the fixed exponential backoff. A delivery that never succeeds
// writes one notify-stage TaskLog entry; it never fails the crawl.
func (s *Service) safeNotifyCrawl(
	ctx context.Context,
	task *taskRow,
	summary FullSummary,
	triggeredByID, status, errorMessage string,
) {
	if s == nil || s.db == nil || task == nil || triggeredByID == "" {
		return
	}
	payload := buildCrawlNotificationPayload(task, summary, status, errorMessage)
	var lastErr error
	for attempt := 1; attempt <= notificationMaxAttempts; attempt++ {
		if err := s.writeCrawlNotification(ctx, task.OrgID, triggeredByID, payload); err != nil {
			lastErr = err
			if attempt == notificationMaxAttempts {
				break
			}
			delayMs := notificationBackoffDelayMs(attempt)
			log.Printf("crawlexecution: failed to send crawl notification, retrying taskId=%s attempt=%d maxAttempts=%d delayMs=%d: %v",
				task.ID, attempt, notificationMaxAttempts, delayMs, err)
			s.sleepNotify(ctx, time.Duration(delayMs)*time.Millisecond)
			continue
		}
		return
	}
	log.Printf("crawlexecution: failed to send crawl notification after retries taskId=%s attempts=%d: %v",
		task.ID, notificationMaxAttempts, lastErr)
	message := "crawl notification delivery failed"
	errorMessageText := ""
	if lastErr != nil {
		errorMessageText = strings.TrimSpace(lastErr.Error())
	}
	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   task.ID,
		OrgID:   task.OrgID,
		Stage:   "notify",
		Status:  "failed",
		Message: &message,
		Data: map[string]any{
			"taskId":           task.ID,
			"status":           status,
			"notificationType": payload.Type,
		},
		Error: map[string]any{"message": errorMessageText},
	})
}

// notificationBackoffDelayMs is min(250 * 2^(n-1), 2000) for a 1-based attempt.
func notificationBackoffDelayMs(attempt int) int {
	if attempt < 1 {
		attempt = 1
	}
	delay := notificationBackoffBaseMs * (1 << (attempt - 1))
	if delay > notificationBackoffCapMs {
		delay = notificationBackoffCapMs
	}
	return delay
}

// buildCrawlNotificationPayload renders title, body and data. It is a pure
// function so the wire shape is testable without MySQL.
func buildCrawlNotificationPayload(task *taskRow, summary FullSummary, status, errorMessage string) crawlNotificationPayload {
	taskLabel := task.TargetURL
	if task.DisplayName != nil {
		taskLabel = *task.DisplayName
	}
	var lastResultAt *string
	if summary.LastFetchedAt != nil {
		value := isoMillisJS(*summary.LastFetchedAt)
		lastResultAt = &value
	}

	title := truncateVarchar191Text(notificationTitle(status) + ": " + taskLabel)
	var body string
	if status == notificationStatusCompleted {
		body = fmt.Sprintf("Inserted %d, skipped %d", summary.Inserted, summary.Skipped)
		if summary.RetryableFailures != nil && *summary.RetryableFailures != 0 {
			body += fmt.Sprintf(", retryable %d", *summary.RetryableFailures)
		}
		body = truncateVarchar191Text(body)
	} else if errorMessage != "" {
		body = truncateVarchar191Text(errorMessage)
	} else {
		body = "Crawl task failed"
	}

	params := crawlNotificationParams{
		TaskID:       task.ID,
		TaskLabel:    taskLabel,
		Inserted:     summary.Inserted,
		Skipped:      summary.Skipped,
		LastResultAt: lastResultAt,
	}
	if summary.RetryableFailures != nil && *summary.RetryableFailures != 0 {
		value := *summary.RetryableFailures
		params.RetryableFailures = &value
	}
	presentation := crawlNotificationPresentation{
		Kind:   presentationKindCrawlCompleted,
		Params: params,
	}
	if status == notificationStatusFailed {
		presentation.Kind = presentationKindCrawlFailed
		if errorMessage != "" {
			presentation.TechnicalDetail = errorMessage
		}
	}
	notificationType := notificationTypeCrawlCompleted
	if status == notificationStatusFailed {
		notificationType = notificationTypeCrawlFailed
	}
	return crawlNotificationPayload{
		Type:  notificationType,
		Title: title,
		Body:  body,
		Data: crawlNotificationData{
			TaskID:       task.ID,
			Status:       status,
			LastResultAt: lastResultAt,
			Presentation: presentation,
		},
	}
}

// notificationTitle is the status half of the truncated title.
func notificationTitle(status string) string {
	if status == notificationStatusFailed {
		return "Crawl failed"
	}
	return "Crawl completed"
}

// writeCrawlNotification persists one Notification row and publishes the relay.
// The row is the source of truth, so a relay failure is logged and swallowed:
// retrying would insert a duplicate row.
func (s *Service) writeCrawlNotification(ctx context.Context, orgID, userID string, payload crawlNotificationPayload) error {
	if s == nil || s.db == nil {
		return errNotConfigured("crawlexecution: mysql is not configured")
	}
	notificationID, err := newNotificationID()
	if err != nil {
		return err
	}
	data, err := json.Marshal(payload.Data)
	if err != nil {
		return err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `Notification` (`id`, `orgId`, `userId`, `type`, `title`, `body`, `data`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		notificationID, orgID, nullableString(stringPtrOrNil(userID)), payload.Type,
		payload.Title, payload.Body, string(data), now, now); err != nil {
		return fmt.Errorf("crawlexecution: insert crawl notification: %w", err)
	}
	if s.relay != nil {
		if relayErr := s.relay(ctx, notificationID, orgID, userID); relayErr != nil {
			log.Printf("crawlexecution: failed to publish crawl notification relay notificationId=%s orgId=%s: %v",
				notificationID, orgID, relayErr)
		}
	}
	return nil
}

// schedulerRelay adapts the injected relay publisher to the scheduler's relay
// function type. A nil publisher stays nil, which makes NotifySystemGeneric
// write the org-wide row and skip the generic relay.
func (s *Service) schedulerRelay() newssourcescheduler.NotificationRelayFunc {
	if s == nil || s.relay == nil {
		return nil
	}
	relay := s.relay
	return func(ctx context.Context, notificationID, orgID, userID string) error {
		return relay(ctx, notificationID, orgID, userID)
	}
}

// sleepNotify is the inter-attempt delay, overridable in tests.
func (s *Service) sleepNotify(ctx context.Context, delay time.Duration) {
	if s != nil && s.sleep != nil {
		s.sleep(ctx, delay)
		return
	}
	sleepWithContext(ctx, delay)
}

// newNotificationID mints a cuid-shaped primary key, matching the id format the
// other Go notification writers use for the same table.
func newNotificationID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// truncateVarchar191Text is the safeNotifyCrawl local truncateVarchar191:
// trim, keep values of at most 191 UTF-16 code units, otherwise cut to 190 code
// units, trim the trailing whitespace and append an ellipsis.
func truncateVarchar191Text(value string) string {
	trimmed := trimJSWhitespace(value)
	if utf16Length(trimmed) <= 191 {
		return trimmed
	}
	units := utf16.Encode([]rune(trimmed))[:190]
	// JS keeps a lone high surrogate when the cut splits a pair; a Go string
	// cannot represent one, so the orphaned half is dropped instead.
	if len(units) > 0 {
		last := units[len(units)-1]
		if last >= 0xD800 && last <= 0xDBFF {
			units = units[:len(units)-1]
		}
	}
	return string(utf16.Decode(trimEndUTF16Whitespace(units))) + "…"
}

// utf16Length is String.prototype.length.
func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// trimJSWhitespace is String.prototype.trim.
func trimJSWhitespace(value string) string {
	return strings.TrimFunc(value, isJSWhitespaceRune)
}

// trimEndUTF16Whitespace is String.prototype.trimEnd over UTF-16 code units.
func trimEndUTF16Whitespace(units []uint16) []uint16 {
	end := len(units)
	for end > 0 && isJSWhitespaceRune(rune(units[end-1])) {
		end--
	}
	return units[:end]
}

// isJSWhitespaceRune is the ECMAScript WhiteSpace + LineTerminator set.
func isJSWhitespaceRune(value rune) bool {
	switch value {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF':
		return true
	}
	return value >= '\u2000' && value <= '\u200A'
}

// truncate191 is truncateVarchar191Text under the name the NestJS service uses.
func truncate191(value string) string { return truncateVarchar191Text(value) }

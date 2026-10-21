package crawlworker

// Error classification for the crawl queues. This file ports the pure
// helpers of crawl.processor.ts (isRetryableError, extractErrorText,
// extractMemoryPressurePercent, isMemoryPressureError) plus the BullMQ
// UnrecoverableError semantics the handler uses to skip the retry budget.
//
// The classification decides two different things and they must not be
// conflated:
//   - isRetryableError only decides whether this process retries the BullMQ
//     attempt or fails it immediately (UnrecoverableError);
//   - the CrawlTask/PipelineJob status writes of a retryable failure are
//     performed by crawlexecution, not here.

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

const (
	// maxErrorText is MAX_ERROR_TEXT: the longest lastError value the failed
	// side effect stores before shrinking further for the VARCHAR(191) column.
	maxErrorText = 4000
	// mysqlVarchar191 is MYSQL_VARCHAR_191, the legacy CrawlTask.lastError
	// column width the fallback write targets.
	mysqlVarchar191 = 191

	memoryPressureCooldownMinMs     = 5_000
	memoryPressureCooldownMaxMs     = 10 * 60 * 1000
	memoryPressureDefaultCooldownMs = 30_000

	// stalledRequeueMessage is the lastError of a re-queued stalled job.
	stalledRequeueMessage = "crawl job stalled; re-queued by bullmq"
	// failedLastErrorFallback is the lastError used when the job carries no
	// failure text at all.
	failedLastErrorFallback = "crawl job failed"
)

// retryableStatusCodes is RETRYABLE_STATUS_CODES: the crawl4ai HTTP statuses
// the handler retries.
var retryableStatusCodes = map[int]struct{}{
	408: {},
	423: {},
	425: {},
	429: {},
	500: {},
	502: {},
	503: {},
	504: {},
}

// retryableMessageHints is RETRYABLE_MESSAGE_HINTS (already lower case; the
// classifier lower cases the message before matching).
var retryableMessageHints = []string{
	"timeout",
	"temporarily",
	"rate limit",
	"connection reset",
	"connection refused",
}

// memoryPressureHints is MEMORY_PRESSURE_HINTS.
var memoryPressureHints = []string{
	"refusing new browser",
	"memory at",
	"insufficient memory",
	"out of memory",
	"not enough memory",
	"cannot allocate memory",
}

// memoryPressurePercentPattern is MEMORY_PRESSURE_PERCENT_PATTERN. The matched
// text is already lower case, so the case-insensitive flag only documents the
// JavaScript regexp.
var memoryPressurePercentPattern = regexp.MustCompile(`(?i)memory\s+at\s+(\d+(?:\.\d+)?)%`)

// unrecoverableError is BullMQ's UnrecoverableError. The attempt performs the
// moveToFinished("failed") transition directly when it sees one; the retry
// budget is not consumed and no delayed/retry entry is written.
//
// The failedReason stored in Redis is Message (the original error text), and
// Cause keeps the wrapped error for logging, matching `new
// UnrecoverableError(message).cause = error` in crawl.processor.ts.
type unrecoverableError struct {
	message string
	cause   error
}

func (e *unrecoverableError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func (e *unrecoverableError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// newUnrecoverableError builds the UnrecoverableError equivalent of the NestJS
// handler.
func newUnrecoverableError(cause error) *unrecoverableError {
	return &unrecoverableError{message: errorMessage(cause), cause: cause}
}

// errorMessage is `error instanceof Error ? error.message : String(error)`.
func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// isRetryableError is isRetryableError. A crawl4ai error is retryable when its
// status is in the retryable set or its own message carries a transient hint;
// any other error only matches the message hints.
func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	var crawlErr *crawl4ai.Error
	if errors.As(err, &crawlErr) {
		if _, ok := retryableStatusCodes[crawlErr.Status]; ok {
			return true
		}
		return containsAnyHint(strings.ToLower(crawlErr.Message), retryableMessageHints)
	}
	return containsAnyHint(strings.ToLower(err.Error()), retryableMessageHints)
}

// errorResponsePayload is the axios `error.response.data` a client error can
// expose. The Go upstream clients do not share one error type, so the
// classifier asks through this interface; an error that does not implement it
// contributes only its own message, exactly like a plain JavaScript Error.
type errorResponsePayload interface {
	ResponsePayload() json.RawMessage
}

// extractErrorText is extractErrorText: collect the error message and the
// response payload (string body, or the message/detail/error fields of a JSON
// object and of a nested error object), de-duplicate them keeping the first
// occurrence, join with newlines and lower-case the result.
func extractErrorText(err error) string {
	if err == nil {
		return ""
	}
	parts := make([]string, 0, 4)
	seen := make(map[string]struct{}, 4)
	add := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return
		}
		if _, exists := seen[trimmed]; exists {
			return
		}
		seen[trimmed] = struct{}{}
		parts = append(parts, trimmed)
	}

	// NestJS adds error.message twice for a real Error (once from the
	// `instanceof Error` branch, once from the `typeof error === "object"`
	// branch); the Set collapses the duplicate.
	add(err.Error())
	var carrier errorResponsePayload
	if errors.As(err, &carrier) {
		addErrorPayload(add, carrier.ResponsePayload())
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

// addErrorPayload ports the `response.data` branch of extractErrorText.
func addErrorPayload(add func(string), payload json.RawMessage) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" || trimmed == "null" {
		return
	}
	switch trimmed[0] {
	case '"':
		add(jsonString(payload))
		return
	case '{':
	default:
		return
	}
	var record struct {
		Message json.RawMessage `json:"message"`
		Detail  json.RawMessage `json:"detail"`
		Error   json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return
	}
	add(jsonString(record.Message))
	add(jsonString(record.Detail))
	add(jsonString(record.Error))
	nested := strings.TrimSpace(string(record.Error))
	if len(nested) == 0 || nested[0] != '{' {
		return
	}
	var nestedRecord struct {
		Message json.RawMessage `json:"message"`
		Detail  json.RawMessage `json:"detail"`
		Error   json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal([]byte(nested), &nestedRecord); err != nil {
		return
	}
	add(jsonString(nestedRecord.Message))
	add(jsonString(nestedRecord.Detail))
	add(jsonString(nestedRecord.Error))
}

// extractMemoryPressurePercent is extractMemoryPressurePercent: the first
// `memory at <n>%` match in the error text, clamped to [0,100]. A missing or
// unparsable value reports nil.
func extractMemoryPressurePercent(err error) *float64 {
	text := extractErrorText(err)
	if text == "" {
		return nil
	}
	match := memoryPressurePercentPattern.FindStringSubmatch(text)
	if match == nil {
		return nil
	}
	parsed, parseErr := strconv.ParseFloat(match[1], 64)
	if parseErr != nil || !finiteNumber(parsed) {
		return nil
	}
	if parsed < 0 {
		parsed = 0
	}
	if parsed > 100 {
		parsed = 100
	}
	return &parsed
}

// isMemoryPressureError is isMemoryPressureError: the combined
// memory/refusing/browser wording, or one of the fixed hints, in the lower-cased
// error text.
func isMemoryPressureError(err error) bool {
	text := extractErrorText(err)
	if text == "" {
		return false
	}
	if strings.Contains(text, "memory") && strings.Contains(text, "refusing") && strings.Contains(text, "browser") {
		return true
	}
	return containsAnyHint(text, memoryPressureHints)
}

// containsAnyHint reports whether the lower-cased text contains any hint.
func containsAnyHint(text string, hints []string) bool {
	for _, hint := range hints {
		if strings.Contains(text, hint) {
			return true
		}
	}
	return false
}

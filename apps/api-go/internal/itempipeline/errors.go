package itempipeline

// This file ports apps/api/src/modules/queue/queue.error-handling.ts. The
// classifications decide whether the worker retries a failed attempt (transient)
// or moves the job straight to the failed set and the dead-letter queue
// (permanent, the UnrecoverableError semantics). The serialized error is the
// failedReason context the 'failed' listener writes to TaskLog and the DLQ
// payload, so its member names match the JavaScript SerializedQueueError.

import (
	"database/sql"
	"errors"
	"math"
	"net"
	"strings"
	"syscall"

	"github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// ErrorKind is QueueErrorKind.
type ErrorKind string

// Classified error kinds.
const (
	ErrorKindTransient ErrorKind = "transient"
	ErrorKindPermanent ErrorKind = "permanent"
)

// SerializedQueueError is SerializedQueueError.
type SerializedQueueError struct {
	Name    string                `json:"name"`
	Message string                `json:"message"`
	Stack   *string               `json:"stack,omitempty"`
	Code    *string               `json:"code,omitempty"`
	Status  *int                  `json:"status,omitempty"`
	Cause   *SerializedQueueError `json:"cause,omitempty"`
}

// ClassifiedError is ClassifiedQueueError.
type ClassifiedError struct {
	Kind   ErrorKind
	Reason string
	Error  SerializedQueueError
}

// PermanentError is QueuePermanentError: the handler explicitly declares the
// failure unrecoverable.
type PermanentError struct {
	Message string
	Cause   error
}

// Error implements error.
func (e *PermanentError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Unwrap exposes the cause.
func (e *PermanentError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Name returns the QueuePermanentError marker used by classifyQueueError.
func (e *PermanentError) Name() string { return "QueuePermanentError" }

// NewPermanentError builds a QueuePermanentError.
func NewPermanentError(message string) *PermanentError { return &PermanentError{Message: message} }

// TransientError is QueueTransientError.
type TransientError struct {
	Message string
	Cause   error
}

// Error implements error.
func (e *TransientError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Unwrap exposes the cause.
func (e *TransientError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Name returns the QueueTransientError marker.
func (e *TransientError) Name() string { return "QueueTransientError" }

const defaultErrorMessage = "Unknown error"

var systemTransientCodes = map[string]bool{
	"ECONNRESET":   true,
	"ECONNREFUSED": true,
	"EPIPE":        true,
	"ETIMEDOUT":    true,
	"EAI_AGAIN":    true,
	"ENOTFOUND":    true,
	"ENETUNREACH":  true,
	"EHOSTUNREACH": true,
	"EADDRINUSE":   true,
}

var systemTransientErrnos = []syscall.Errno{
	syscall.ECONNRESET,
	syscall.ECONNREFUSED,
	syscall.EPIPE,
	syscall.ETIMEDOUT,
	syscall.ENETUNREACH,
	syscall.EHOSTUNREACH,
	syscall.EADDRINUSE,
}

var axiosTransientStatuses = map[int]bool{
	408: true, 409: true, 423: true, 425: true, 429: true,
	500: true, 502: true, 503: true, 504: true,
}

// mysqlTransientNumbers are the server/connection errors NestJS sees through
// Prisma's P1000-P1013 range; they are worth retrying. Unique/constraint and
// foreign-key violations are permanent (P2000-P2030 style).
var mysqlTransientNumbers = map[uint16]bool{
	1040: true, // too many connections
	1041: true, // out of memory
	1053: true, // server shutdown in progress
	1205: true, // lock wait timeout
	1213: true, // deadlock
	2006: true, // server gone away
	2013: true, // lost connection during query
}

var mysqlPermanentNumbers = map[uint16]bool{
	1062: true, // duplicate entry (P2002)
	1048: true, // column cannot be null (P2011)
	1264: true, // out of range
	1265: true, // data truncated (P2000/P2005 family)
	1364: true, // field has no default (P2011/P2013 family)
	1406: true, // data too long (P2000)
	1451: true, // FK constraint on delete (P2003)
	1452: true, // FK constraint on insert (P2003)
}

type namedError interface {
	error
	Name() string
}

type codedError interface {
	error
	Code() string
}

// errorName is getErrorName: an explicit Name() wins, then the NestJS class
// name carried by the Go types, then "Error".
func errorName(err error) string {
	if err == nil {
		return "Error"
	}
	var named namedError
	if errors.As(err, &named) {
		if name := named.Name(); name != "" {
			return name
		}
	}
	switch err.(type) {
	case *crawl4ai.Error:
		return "Crawl4aiRequestException"
	case *litellmcompat.GuardrailViolationError:
		return "LiteLlmGuardrailViolationError"
	case *litellmcompat.CompatibilityError:
		return "LlmCompatibilityError"
	}
	return "Error"
}

func errorMessage(err error) string {
	if err == nil {
		return defaultErrorMessage
	}
	message := err.Error()
	if message == "" {
		return defaultErrorMessage
	}
	return message
}

func errorCode(err error) *string {
	var coded codedError
	if errors.As(err, &coded) {
		if code := coded.Code(); code != "" {
			return &code
		}
	}
	return nil
}

func errorStatus(err error) *int {
	var crawlErr *crawl4ai.Error
	if errors.As(err, &crawlErr) && crawlErr.Status > 0 {
		status := crawlErr.Status
		return &status
	}
	var guardrailErr *litellmcompat.GuardrailViolationError
	if errors.As(err, &guardrailErr) && guardrailErr.UpstreamStatus > 0 {
		status := guardrailErr.UpstreamStatus
		return &status
	}
	var compatibilityErr *litellmcompat.CompatibilityError
	if errors.As(err, &compatibilityErr) && compatibilityErr.Status > 0 {
		status := compatibilityErr.Status
		return &status
	}
	return nil
}

func errorCause(err error) error {
	var permanent *PermanentError
	if errors.As(err, &permanent) && permanent.Cause != nil {
		return permanent.Cause
	}
	var transient *TransientError
	if errors.As(err, &transient) && transient.Cause != nil {
		return transient.Cause
	}
	type unwrapper interface{ Unwrap() error }
	var wrapped unwrapper
	if errors.As(err, &wrapped) {
		if cause := wrapped.Unwrap(); cause != nil && cause != err {
			return cause
		}
	}
	return nil
}

// SerializeQueueError is serializeQueueError with the depth-3 cause cap.
func SerializeQueueError(err error) SerializedQueueError {
	return serializeQueueError(err, 0)
}

func serializeQueueError(err error, depth int) SerializedQueueError {
	serialized := SerializedQueueError{
		Name:    errorName(err),
		Message: errorMessage(err),
		Code:    errorCode(err),
		Status:  errorStatus(err),
	}
	if depth >= 3 {
		return serialized
	}
	if cause := errorCause(err); cause != nil {
		child := serializeQueueError(cause, depth+1)
		serialized.Cause = &child
	}
	return serialized
}

// ClassifyQueueError is classifyQueueError.
func ClassifyQueueError(err error) ClassifiedError {
	if err == nil {
		return ClassifiedError{Kind: ErrorKindTransient, Reason: "unknown", Error: SerializeQueueError(nil)}
	}

	var permanent *PermanentError
	if errors.As(err, &permanent) {
		return classified(ErrorKindPermanent, "explicit-permanent", err)
	}
	var transient *TransientError
	if errors.As(err, &transient) {
		return classified(ErrorKindTransient, "explicit-transient", err)
	}

	name := errorName(err)
	switch name {
	case "LiteLlmGuardrailViolationError":
		return classified(ErrorKindPermanent, "guardrail", err)
	case "UnrecoverableError":
		reason := "unrecoverable"
		if cause := errorCause(err); cause != nil {
			if causeReason := ClassifyQueueError(cause).Reason; causeReason != "" {
				reason = "unrecoverable:" + causeReason
			}
		}
		return classified(ErrorKindPermanent, reason, err)
	case "ZodError":
		return classified(ErrorKindPermanent, "validation", err)
	}

	var crawlErr *crawl4ai.Error
	if errors.As(err, &crawlErr) && crawlErr.Status > 0 {
		if crawlErr.Status >= 500 {
			return classified(ErrorKindTransient, "crawl4ai", err)
		}
		return classified(ErrorKindPermanent, "crawl4ai", err)
	}
	if status := errorStatus(err); status != nil {
		kind := ErrorKindPermanent
		if *status >= 500 || axiosTransientStatuses[*status] {
			kind = ErrorKindTransient
		}
		return classified(kind, "http", err)
	}

	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		kind := ErrorKindTransient
		if mysqlTransientNumbers[mysqlErr.Number] {
			kind = ErrorKindTransient
		} else if mysqlPermanentNumbers[mysqlErr.Number] {
			kind = ErrorKindPermanent
		}
		return classified(kind, "prisma", err)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return classified(ErrorKindPermanent, "prisma", err)
	}

	if code := errorCode(err); code != nil {
		if systemTransientCodes[*code] {
			return classified(ErrorKindTransient, "system", err)
		}
	}
	for _, errno := range systemTransientErrnos {
		if errors.Is(err, errno) {
			return classified(ErrorKindTransient, "system", err)
		}
	}
	var netErr *net.DNSError
	if errors.As(err, &netErr) {
		return classified(ErrorKindTransient, "system", err)
	}

	message := strings.ToLower(errorMessage(err))
	if strings.Contains(message, "throttled") || strings.Contains(message, "rate limit") {
		return classified(ErrorKindTransient, "rate-limit", err)
	}
	return classified(ErrorKindTransient, "unknown", err)
}

func classified(kind ErrorKind, reason string, err error) ClassifiedError {
	return ClassifiedError{Kind: kind, Reason: reason, Error: SerializeQueueError(err)}
}

// JitterBackoff is computeExponentialBackoffDelay:
//
//	round(min(base * 2^(attempt-1), max) * (0.75 + random*0.5))
//
// The random source is injected so tests can pin the jitter factor.
func JitterBackoff(baseDelayMs int, attempt int, maxDelayMs int, random func() float64) int64 {
	normalized := attempt
	if normalized < 1 {
		normalized = 1
	}
	exponent := normalized - 1
	if exponent < 0 {
		exponent = 0
	}
	if exponent > 62 {
		exponent = 62
	}
	exponential := float64(baseDelayMs) * math.Pow(2, float64(exponent))
	capped := math.Min(exponential, float64(maxDelayMs))
	if random == nil {
		random = func() float64 { return 0.5 }
	}
	jitter := 0.75 + random()*0.5
	return int64(math.Round(capped * jitter))
}

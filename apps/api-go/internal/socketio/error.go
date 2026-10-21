package socketio

// Realtime error codes mirror @modular/utils RealtimeSocketErrorCode. The
// browser already renders these codes, so the strings are part of the wire
// contract.
const (
	CodeUnauthorized             = "UNAUTHORIZED"
	CodeTooManyConnections       = "TOO_MANY_CONNECTIONS"
	CodeTooManyConnectionAttempt = "TOO_MANY_CONNECTION_ATTEMPTS"
	CodeRateLimitExceeded        = "RATE_LIMIT_EXCEEDED"
	CodeTooManyFailedAttempts    = "TOO_MANY_FAILED_ATTEMPTS"
)

// Error message constants are the exact inputs of the NestJS
// buildRealtimeSocketErrorPayload switch; every other message maps to the
// generic Unauthorized payload.
const (
	MessageRateLimitExceeded        = "Rate limit exceeded"
	MessageTooManyFailedAttempts    = "Too many failed attempts"
	MessageTooManyConnections       = "Too many connections"
	MessageTooManyConnectionAttempt = "Too many connection attempts"
)

// ErrorPayload is the body of a namespace <name>:error event. Field order and
// omission follow apps/api/src/modules/websocket/socket-error-payloads.ts:
// code, message, retryAfterMs (only when a retry-after is known).
type ErrorPayload struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	RetryAfterMS int64  `json:"retryAfterMs,omitempty"`
}

// NewErrorPayload maps a business error message to the exact payload the
// NestJS gateways emit. Unknown messages (including auth failures such as
// "Missing auth token") collapse to the generic Unauthorized payload, exactly
// like buildRealtimeSocketErrorPayload. A non-positive retryAfterMS is omitted
// from the JSON, and "Too many connections" never carries one.
func NewErrorPayload(message string, retryAfterMS int64) ErrorPayload {
	switch message {
	case MessageRateLimitExceeded:
		return ErrorPayload{
			Code:         CodeRateLimitExceeded,
			Message:      MessageRateLimitExceeded,
			RetryAfterMS: positiveRetryAfter(retryAfterMS),
		}
	case MessageTooManyFailedAttempts:
		return ErrorPayload{
			Code:         CodeTooManyFailedAttempts,
			Message:      MessageTooManyFailedAttempts,
			RetryAfterMS: positiveRetryAfter(retryAfterMS),
		}
	case MessageTooManyConnections:
		// The Nest builder ignores retryAfterMs for the connection caps.
		return ErrorPayload{Code: CodeTooManyConnections, Message: MessageTooManyConnections}
	case MessageTooManyConnectionAttempt:
		return ErrorPayload{
			Code:         CodeTooManyConnectionAttempt,
			Message:      MessageTooManyConnectionAttempt,
			RetryAfterMS: positiveRetryAfter(retryAfterMS),
		}
	default:
		return ErrorPayload{Code: CodeUnauthorized, Message: "Unauthorized"}
	}
}

func positiveRetryAfter(value int64) int64 {
	if value > 0 {
		return value
	}
	return 0
}

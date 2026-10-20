package socketio

import (
	"encoding/json"
	"testing"
)

func TestErrorCodeConstants(t *testing.T) {
	// The strings are consumed by the browser, so they must match #124 and
	// @modular/utils RealtimeSocketErrorCode exactly.
	cases := map[string]string{
		CodeUnauthorized:             "UNAUTHORIZED",
		CodeTooManyConnections:       "TOO_MANY_CONNECTIONS",
		CodeTooManyConnectionAttempt: "TOO_MANY_CONNECTION_ATTEMPTS",
		CodeRateLimitExceeded:        "RATE_LIMIT_EXCEEDED",
		CodeTooManyFailedAttempts:    "TOO_MANY_FAILED_ATTEMPTS",
	}
	for got, want := range cases {
		if got != want {
			t.Fatalf("error code constant = %q, want %q", got, want)
		}
	}
}

func TestNewErrorPayloadMapping(t *testing.T) {
	cases := []struct {
		name         string
		message      string
		retryAfterMS int64
		wantCode     string
		wantMessage  string
		wantRetry    int64
	}{
		{
			name: "rate limit", message: MessageRateLimitExceeded, retryAfterMS: 60_000,
			wantCode: CodeRateLimitExceeded, wantMessage: MessageRateLimitExceeded, wantRetry: 60_000,
		},
		{
			name: "failed attempts", message: MessageTooManyFailedAttempts, retryAfterMS: 4_000,
			wantCode: CodeTooManyFailedAttempts, wantMessage: MessageTooManyFailedAttempts, wantRetry: 4_000,
		},
		{
			name: "connections ignores retry", message: MessageTooManyConnections, retryAfterMS: 9_000,
			wantCode: CodeTooManyConnections, wantMessage: MessageTooManyConnections,
		},
		{
			name: "connection attempts", message: MessageTooManyConnectionAttempt, retryAfterMS: 60_000,
			wantCode: CodeTooManyConnectionAttempt, wantMessage: MessageTooManyConnectionAttempt, wantRetry: 60_000,
		},
		{
			name: "auth failure collapses to unauthorized", message: "Missing auth token",
			wantCode: CodeUnauthorized, wantMessage: "Unauthorized",
		},
		{
			name: "unknown message collapses to unauthorized", message: "Insufficient permissions",
			wantCode: CodeUnauthorized, wantMessage: "Unauthorized",
		},
		{
			name: "empty message collapses to unauthorized", message: "",
			wantCode: CodeUnauthorized, wantMessage: "Unauthorized",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			payload := NewErrorPayload(testCase.message, testCase.retryAfterMS)
			if payload.Code != testCase.wantCode {
				t.Fatalf("Code = %q, want %q", payload.Code, testCase.wantCode)
			}
			if payload.Message != testCase.wantMessage {
				t.Fatalf("Message = %q, want %q", payload.Message, testCase.wantMessage)
			}
			if payload.RetryAfterMS != testCase.wantRetry {
				t.Fatalf("RetryAfterMS = %d, want %d", payload.RetryAfterMS, testCase.wantRetry)
			}
		})
	}
}

func TestErrorPayloadJSONShape(t *testing.T) {
	cases := []struct {
		name    string
		payload ErrorPayload
		want    string
	}{
		{
			name:    "retry after included",
			payload: NewErrorPayload(MessageRateLimitExceeded, 60_000),
			want:    `{"code":"RATE_LIMIT_EXCEEDED","message":"Rate limit exceeded","retryAfterMs":60000}`,
		},
		{
			name:    "retry after omitted when zero",
			payload: NewErrorPayload(MessageRateLimitExceeded, 0),
			want:    `{"code":"RATE_LIMIT_EXCEEDED","message":"Rate limit exceeded"}`,
		},
		{
			name:    "connections omit retry after",
			payload: NewErrorPayload(MessageTooManyConnections, 60_000),
			want:    `{"code":"TOO_MANY_CONNECTIONS","message":"Too many connections"}`,
		},
		{
			name:    "unauthorized default",
			payload: NewErrorPayload("Invalid token", 0),
			want:    `{"code":"UNAUTHORIZED","message":"Unauthorized"}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := json.Marshal(testCase.payload)
			if err != nil {
				t.Fatalf("json.Marshal() error = %v", err)
			}
			if string(encoded) != testCase.want {
				t.Fatalf("payload JSON = %s, want %s", encoded, testCase.want)
			}
		})
	}
}

package crawlworker

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// payloadError is a client error carrying an axios-style response body.
type payloadError struct {
	message string
	payload json.RawMessage
}

func (e *payloadError) Error() string { return e.message }

// ResponsePayload implements errorResponsePayload.
func (e *payloadError) ResponsePayload() json.RawMessage { return e.payload }

func TestIsRetryableError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"crawl4ai 408", &crawl4ai.Error{Status: 408}, true},
		{"crawl4ai 423", &crawl4ai.Error{Status: 423}, true},
		{"crawl4ai 425", &crawl4ai.Error{Status: 425}, true},
		{"crawl4ai 429", &crawl4ai.Error{Status: 429}, true},
		{"crawl4ai 500", &crawl4ai.Error{Status: 500}, true},
		{"crawl4ai 502", &crawl4ai.Error{Status: 502}, true},
		{"crawl4ai 503", &crawl4ai.Error{Status: 503}, true},
		{"crawl4ai 504", &crawl4ai.Error{Status: 504}, true},
		{"crawl4ai 404", &crawl4ai.Error{Status: 404, Message: "not found"}, false},
		{"crawl4ai 400", &crawl4ai.Error{Status: 400, Message: "blocked url"}, false},
		{"crawl4ai message hint", &crawl4ai.Error{Status: 400, Message: "Request Timeout"}, true},
		{"wrapped crawl4ai", fmt.Errorf("crawl: %w", &crawl4ai.Error{Status: 502}), true},
		{"timeout text", errors.New("upstream Timeout"), true},
		{"temporarily text", errors.New("temporarily unavailable"), true},
		{"rate limit text", errors.New("Rate Limit reached"), true},
		{"connection reset", errors.New("read: connection reset by peer"), true},
		{"connection refused", errors.New("dial: connection refused"), true},
		{"unrelated", errors.New("blocked by policy"), false},
	}
	for _, testCase := range cases {
		if got := isRetryableError(testCase.err); got != testCase.want {
			t.Errorf("%s: retryable = %t, want %t", testCase.name, got, testCase.want)
		}
	}
}

func TestExtractErrorText(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"nil", nil, ""},
		{"message only", errors.New("Boom"), "boom"},
		{"object payload", &payloadError{
			message: "Request failed",
			payload: json.RawMessage(`{"message":"Memory at 96%","detail":"detail text","error":"error text"}`),
		}, "request failed\nmemory at 96%\ndetail text\nerror text"},
		{"string payload", &payloadError{
			message: "Request failed",
			payload: json.RawMessage(`"raw body"`),
		}, "request failed\nraw body"},
		{"dedupe keeps the first occurrence", &payloadError{
			message: "boom",
			payload: json.RawMessage(`"boom"`),
		}, "boom"},
		{"nested error object", &payloadError{
			message: "outer",
			payload: json.RawMessage(`{"error":{"message":"nested","detail":"nested detail","error":"nested error"}}`),
		}, "outer\nnested\nnested detail\nnested error"},
		{"non-string fields are ignored", &payloadError{
			message: "outer",
			payload: json.RawMessage(`{"message":42,"detail":null,"error":true}`),
		}, "outer"},
		{"array payload is ignored", &payloadError{
			message: "outer",
			payload: json.RawMessage(`["one","two"]`),
		}, "outer"},
		{"blank payload is ignored", &payloadError{
			message: "  outer  ",
			payload: json.RawMessage(`null`),
		}, "outer"},
		{"wrapped payload error", fmt.Errorf("call: %w", &payloadError{
			message: "Request failed",
			payload: json.RawMessage(`{"detail":"Detail"}`),
		}), "call: request failed\ndetail"},
	}
	for _, testCase := range cases {
		if got := extractErrorText(testCase.err); got != testCase.want {
			t.Errorf("%s: text = %q, want %q", testCase.name, got, testCase.want)
		}
	}
}

func TestExtractMemoryPressurePercent(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want *float64
	}{
		{"none", errors.New("boom"), nil},
		{"nil", nil, nil},
		{"integer", errors.New("refusing new browser: memory at 94%"), floatPointer(94)},
		{"decimal", errors.New("Memory At 96.5%"), floatPointer(96.5)},
		{"clamped high", errors.New("memory at 120%"), floatPointer(100)},
		{"low", errors.New("memory at 3%"), floatPointer(3)},
		{"first match", errors.New("memory at 96.5% and memory at 12%"), floatPointer(96.5)},
		{"not a percentage", errors.New("memory at fifty percent"), nil},
	}
	for _, testCase := range cases {
		got := extractMemoryPressurePercent(testCase.err)
		if (got == nil) != (testCase.want == nil) {
			t.Errorf("%s: percent = %v, want %v", testCase.name, got, testCase.want)
			continue
		}
		if got != nil && *got != *testCase.want {
			t.Errorf("%s: percent = %v, want %v", testCase.name, *got, *testCase.want)
		}
	}
}

func floatPointer(value float64) *float64 { return &value }

func TestIsMemoryPressureError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"comment", errors.New("playwright launched"), false},
		{"out of memory", errors.New("Out Of Memory"), true},
		{"insufficient memory", errors.New("insufficient memory"), true},
		{"not enough memory", errors.New("not enough memory"), true},
		{"cannot allocate memory", errors.New("cannot allocate memory"), true},
		{"refusing new browser", errors.New("refusing new browser instance"), true},
		{"memory at", errors.New("memory at 92%"), true},
		{"combined wording", errors.New("Memory pressure: refusing Browser"), true},
		{"refusing browser only", errors.New("refusing browser"), false},
		{"crawl4ai wrapping", &crawl4ai.Error{Status: 503, Message: "browser pool refusing new browser: memory at 97%"}, true},
	}
	for _, testCase := range cases {
		if got := isMemoryPressureError(testCase.err); got != testCase.want {
			t.Errorf("%s: memory pressure = %t, want %t", testCase.name, got, testCase.want)
		}
	}
}

func TestUnrecoverableErrorKeepsMessageAndCause(t *testing.T) {
	cause := errors.New("crawl4ai refused the request")
	failure := newUnrecoverableError(cause)
	if failure.Error() != cause.Error() {
		t.Fatalf("message = %q, want %q", failure.Error(), cause.Error())
	}
	if !errors.Is(failure, cause) {
		t.Fatal("the unrecoverable error must keep the cause")
	}
}

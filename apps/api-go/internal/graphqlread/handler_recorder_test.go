package graphqlread

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
)

// TestHandlerRecordsResolverFailuresWithA200Response is the end-to-end wiring proof
// for GAP-EXCEPTION-WIRING-001 on the GraphQL side: a resolver failure inside a real
// handler answers HTTP 200 with a GraphQL errors array, and the configured recorder
// still receives one event.
//
// The handler is built without an authenticator, so every root fails at prepare with
// the executor's 500 "Internal server error". That is the same code path a failed
// authentication or a resolver error takes, and it keeps the test free of a JWT chain.
func TestHandlerRecordsResolverFailuresWithA200Response(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)

	var recorded []exec.ResolverError
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			t.Error("a registered document must not be forwarded")
			w.WriteHeader(http.StatusBadGateway)
		},
		ErrorRecorder: func(failure exec.ResolverError) { recorded = append(recorded, failure) },
	})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "http://gateway/graphql",
		strings.NewReader(`query Alerts { alertChannels { id } }`))
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-trace-id", "trace-graphql-1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: the executor keeps resolver errors at 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"errors"`) {
		t.Fatalf("no GraphQL errors in the body: %s", recorder.Body.String())
	}
	if len(recorded) != 1 {
		t.Fatalf("recorded %d events, want 1", len(recorded))
	}
	got := recorded[0]
	if got.Operation != "alertChannels" {
		t.Errorf("operation = %q, want alertChannels", got.Operation)
	}
	if got.OperationName != "Alerts" {
		t.Errorf("operationName = %q, want Alerts", got.OperationName)
	}
	if got.TraceID != "trace-graphql-1" {
		t.Errorf("traceId = %q, want the request trace id", got.TraceID)
	}
	if got.StatusCode != http.StatusInternalServerError {
		// Without an authenticator the handler's prepare hook reports the executor's
		// internal failure, which is the same code path an authentication rejection
		// takes.
		t.Errorf("statusCode = %d, want 500", got.StatusCode)
	}
	if got.ErrorName != "Error" {
		t.Errorf("errorName = %q, want the base value for an untyped 500", got.ErrorName)
	}
}

// TestHandlerForwardsUnregisteredDocumentsWithoutRecording proves a document the
// gateway hands to NestJS records nothing: NestJS answers it and its own filter
// records any failure, so a Go event would duplicate a legacy response.
func TestHandlerForwardsUnregisteredDocumentsWithoutRecording(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	forwarded := 0
	var recorded []exec.ResolverError
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			forwarded++
			w.WriteHeader(http.StatusOK)
		},
		ErrorRecorder: func(failure exec.ResolverError) { recorded = append(recorded, failure) },
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://gateway/graphql",
		strings.NewReader(`{ alertRules { id } }`))
	request.Header.Set("content-type", "application/json")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if forwarded != 1 {
		t.Fatalf("forwarded %d times, want 1", forwarded)
	}
	if len(recorded) != 0 {
		t.Fatalf("a legacy document recorded %d events", len(recorded))
	}
}

// TestHandlerProtocolRejectionRecordsNothing proves a parse error is answered by the
// handler itself and recorded by nobody, matching the Apollo path NestJS never routes
// through its exception filter.
func TestHandlerProtocolRejectionRecordsNothing(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	var recorded []exec.ResolverError
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			t.Error("a malformed document must be answered, not forwarded")
		},
		ErrorRecorder: func(failure exec.ResolverError) { recorded = append(recorded, failure) },
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://gateway/graphql",
		strings.NewReader(`{"query":"{ alertChannels "}`))
	request.Header.Set("content-type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if len(recorded) != 0 {
		t.Fatalf("a parse error recorded %d events, want 0", len(recorded))
	}
}

package graphqlread

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// channelRow is the AlertChannelModel projection these tests resolve, matching the
// SDL fields so a successful resolve produces no execution errors.
type channelRow struct {
	ID        string    `graphql:"id"`
	Name      string    `graphql:"name"`
	Type      string    `graphql:"type"`
	Target    string    `graphql:"target"`
	IsActive  bool      `graphql:"isActive"`
	CreatedAt timeValue `graphql:"createdAt"`
	UpdatedAt timeValue `graphql:"updatedAt"`
}

// timeValue is a DateTime-shaped leaf the projector can render.
type timeValue string

// newRecorderHandler builds the real handler over a registry with exactly one
// registered query root, plus a legacy sink the caller inspects.
func newRecorderHandler(t *testing.T, resolve contract.Resolver, recorder exec.ErrorRecorder) (*Handler, *int) {
	t.Helper()
	reg := contract.NewRegistry()
	reg.RegisterType("AlertChannelModel", channelRow{})
	reg.RegisterRoot(contract.Root{
		Name:       "alertChannels",
		Permission: "alerts.read",
		Resolve:    resolve,
	})
	forwarded := 0
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			forwarded++
			w.WriteHeader(http.StatusOK)
		},
		ErrorRecorder: recorder,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler, &forwarded
}

// post runs one GraphQL document through the handler the way cmd/api mounts it: inside
// httpx.TraceMiddleware, so the trace id the executor reports is the one the middleware
// generated from the request header.
func post(handler *Handler, document string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "http://gateway/graphql",
		strings.NewReader(document))
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-trace-id", "feedfacecafebeef")
	recorder := httptest.NewRecorder()
	httpx.TraceMiddleware(handler).ServeHTTP(recorder, request)
	return recorder
}

// TestHandlerRecordsResolverFailuresRegardlessOfTheHttpStatus is the end-to-end wiring
// proof for GAP-EXCEPTION-WIRING-001 on the GraphQL side.
//
// The handler is built without an authenticator, so every root fails in the prepare hook
// with the executor's internal failure. That is the same reporting path a resolver
// error takes, and it keeps the test free of a JWT chain. alertChannels is a non-null
// root, so the response status follows the failure; the recording happens from the
// failure either way, which is what makes this work for HTTP 200 resolver errors too.
func TestHandlerRecordsResolverFailuresRegardlessOfTheHttpStatus(t *testing.T) {
	var recorded []exec.ResolverError
	handler, _ := newRecorderHandler(t, func(contract.Context) (any, error) {
		t.Error("the resolver must not run without an authenticator")
		return nil, nil
	}, func(failure exec.ResolverError) { recorded = append(recorded, failure) })

	recorder := post(handler, `{"query":"query Alerts { alertChannels { id } }","operationName":"Alerts"}`)

	// The failure is present in the GraphQL errors array whichever status it maps to.
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
	if got.TraceID != "feedfacecafebeef" {
		t.Errorf("traceId = %q, want the traced request id", got.TraceID)
	}
	if got.StatusCode != http.StatusInternalServerError {
		// Without an authenticator the prepare hook reports the executor's internal
		// failure, which is the same code path an authentication rejection takes.
		t.Errorf("statusCode = %d, want 500", got.StatusCode)
	}
	if got.ErrorName != "Error" {
		t.Errorf("errorName = %q, want the base value for an untyped 500", got.ErrorName)
	}
}

// TestHandlerForwardsUnregisteredDocumentsWithoutRecording proves a document the
// gateway hands to NestJS records nothing: NestJS answers it and its own filter records
// any failure, so a Go event would duplicate a legacy response.
func TestHandlerForwardsUnregisteredDocumentsWithoutRecording(t *testing.T) {
	var recorded []exec.ResolverError
	handler, forwarded := newRecorderHandler(t, func(contract.Context) (any, error) {
		return []channelRow{}, nil
	}, func(failure exec.ResolverError) { recorded = append(recorded, failure) })

	post(handler, `{"query":"{ alertRules { id } }"}`)
	if *forwarded != 1 {
		t.Fatalf("forwarded %d times, want 1", *forwarded)
	}
	if len(recorded) != 0 {
		t.Fatalf("a legacy document recorded %d events", len(recorded))
	}
}

// TestHandlerProtocolRejectionRecordsNothing proves a parse error is answered by the
// handler itself and recorded by nobody, matching the Apollo path NestJS never routes
// through its exception filter.
func TestHandlerProtocolRejectionRecordsNothing(t *testing.T) {
	var recorded []exec.ResolverError
	handler, forwarded := newRecorderHandler(t, func(contract.Context) (any, error) {
		return []channelRow{}, nil
	}, func(failure exec.ResolverError) { recorded = append(recorded, failure) })

	recorder := post(handler, `{"query":"{ alertChannels "}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if *forwarded != 0 {
		t.Fatalf("a malformed document was forwarded %d times", *forwarded)
	}
	if len(recorded) != 0 {
		t.Fatalf("a parse error recorded %d events, want 0", len(recorded))
	}
}

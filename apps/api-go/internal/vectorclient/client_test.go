package vectorclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUpsertSendsLegacyProtocol(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/upsert" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("method = %q", r.Method)
		}
		if got := r.Header.Get("content-type"); got != "application/json" {
			t.Errorf("content-type = %q", got)
		}
		if got := r.Header.Get("x-internal-token"); got != "secret" {
			t.Errorf("token = %q", got)
		}
		var request UpsertRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if request.OrgID != "org-1" || request.EmbeddingModel != "embed-v1" || len(request.Points) != 1 {
			t.Errorf("request = %+v", request)
		}
		_, _ = w.Write([]byte(`{"upserted":1,"collection":"processed"}`))
	}))
	defer server.Close()

	client := &Client{
		HTTPClient: server.Client(),
		Sleep:      func(context.Context, time.Duration) error { return nil },
		Rand:       func() float64 { return 0.5 },
	}
	err := client.Upsert(context.Background(), Config{
		Enabled: true, BaseURL: server.URL + "/", Token: "secret", TimeoutMs: 1000, MaxRetries: 2,
	}, UpsertRequest{OrgID: "org-1", EmbeddingModel: "embed-v1", Points: []Point{{
		ProcessedItemID: "p1", ItemMetaID: "m1", CreatedAtMs: 1, Vector: []float64{0.1, 0.2},
	}}})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestUpsertDisabledIsNoOp(t *testing.T) {
	client := &Client{HTTPClient: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("disabled upsert must not make a request")
		return nil, nil
	})}}
	if err := client.Upsert(context.Background(), Config{Enabled: false}, UpsertRequest{Points: []Point{{Vector: []float64{1}}}}); err != nil {
		t.Fatalf("disabled Upsert = %v", err)
	}
}

func TestUpsertEnabledButIncomplete(t *testing.T) {
	client := &Client{}
	err := client.Upsert(context.Background(), Config{Enabled: true}, UpsertRequest{Points: []Point{{Vector: []float64{1}}}})
	var vectorError *Error
	if !errors.As(err, &vectorError) || vectorError.Kind != "VectorServiceUnavailableError" {
		t.Fatalf("error = %v", err)
	}
	if err.Error() != "Vector service enabled but configuration is incomplete" {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestUpsertRetriesServerFailures(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	client := &Client{
		HTTPClient: server.Client(),
		Sleep:      func(context.Context, time.Duration) error { return nil },
		Rand:       func() float64 { return 0.5 },
	}
	err := client.Upsert(context.Background(), Config{Enabled: true, BaseURL: server.URL, Token: "secret", TimeoutMs: 1000, MaxRetries: 2}, UpsertRequest{Points: []Point{{Vector: []float64{1}}}})
	var vectorError *Error
	if !errors.As(err, &vectorError) || vectorError.Kind != "VectorServiceUnavailableError" {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3", calls.Load())
	}
}

func TestUpsertDoesNotRetryAuthFailures(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "no", http.StatusUnauthorized)
	}))
	defer server.Close()
	client := &Client{HTTPClient: server.Client(), Sleep: func(context.Context, time.Duration) error { return nil }}
	err := client.Upsert(context.Background(), Config{Enabled: true, BaseURL: server.URL, Token: "secret", TimeoutMs: 1000, MaxRetries: 5}, UpsertRequest{Points: []Point{{Vector: []float64{1}}}})
	var vectorError *Error
	if !errors.As(err, &vectorError) || vectorError.Kind != "VectorUnauthorizedError" {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

func TestUpsertRejectsBadSuccessPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"upserted":-1,"collection":"processed"}`))
	}))
	defer server.Close()
	client := &Client{HTTPClient: server.Client(), Sleep: func(context.Context, time.Duration) error { return nil }}
	err := client.Upsert(context.Background(), Config{Enabled: true, BaseURL: server.URL, Token: "secret", TimeoutMs: 1000}, UpsertRequest{Points: []Point{{Vector: []float64{1}}}})
	var vectorError *Error
	if !errors.As(err, &vectorError) || vectorError.Kind != "VectorBadResponseError" {
		t.Fatalf("error = %v", err)
	}
	if !strings.Contains(err.Error(), "invalid payload") {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestErrorNameMatchesNestClasses(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{&Error{Kind: "VectorUnauthorizedError"}, "VectorUnauthorizedError"},
		{&Error{Kind: "VectorServiceUnavailableError"}, "VectorServiceUnavailableError"},
		{errors.New("plain"), "OutboxDeliveryError"},
	}
	for _, testCase := range cases {
		if got := ErrorName(testCase.err); got != testCase.want {
			t.Fatalf("ErrorName(%v) = %q, want %q", testCase.err, got, testCase.want)
		}
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

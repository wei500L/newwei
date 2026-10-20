package newseventsingest

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

	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

// staticModelConfig resolves one fixed effective configuration.
type staticModelConfig struct {
	config modelaccesssettings.AssistantModelServiceConfig
	err    error
}

// AssistantModelServiceConfig implements ModelConfigReader.
func (s staticModelConfig) AssistantModelServiceConfig(ctx context.Context) (modelaccesssettings.AssistantModelServiceConfig, error) {
	_ = ctx
	return s.config, s.err
}

// testModelRequest is one clustering request used by the HTTP tests.
func testModelRequest() topicClusteringRequest {
	return topicClusteringRequest{
		Documents: []TopicClusteringDocument{
			{ID: "pa_1", Text: "Title\n\nSummary", Embedding: []float64{1, 0}},
			{ID: "pa_2", Text: "Title", Embedding: []float64{0, 1}},
		},
		MinTopicSize: 4,
		RequestID:    "req_1",
	}
}

// TestClusterTopicsRequestShape locks the POST path, headers and body members the
// Python model service reads.
func TestClusterTopicsRequestShape(t *testing.T) {
	var captured struct {
		path  string
		token string
		body  struct {
			Documents    json.RawMessage `json:"documents"`
			MinTopicSize json.RawMessage `json:"min_topic_size"`
			RequestID    json.RawMessage `json:"request_id"`
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		captured.path = request.URL.Path
		captured.token = request.Header.Get("x-internal-token")
		if err := json.NewDecoder(request.Body).Decode(&captured.body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"clusters":[{"topicId":0,"itemIds":["pa_1","pa_2"],"representativeId":"pa_1","keywords":["k"]}],"outlierIds":[],"diagnostics":{"document_count":2.0}}`))
	}))
	defer server.Close()

	client := NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL + "/", // the trailing slash is normalized away
		InternalToken: "secret",
		Timeout:       2 * time.Second,
		MaxRetries:    0,
	}})
	response, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	if err != nil {
		t.Fatalf("cluster: %v", err)
	}
	if captured.path != "/v1/topic-model/bertopic/cluster" {
		t.Fatalf("path = %q", captured.path)
	}
	if captured.token != "secret" {
		t.Fatalf("token = %q", captured.token)
	}
	if len(captured.body.Documents) == 0 || len(captured.body.MinTopicSize) == 0 || len(captured.body.RequestID) == 0 {
		t.Fatalf("body members = %+v", captured.body)
	}
	var minTopicSize float64
	if err := json.Unmarshal(captured.body.MinTopicSize, &minTopicSize); err != nil || minTopicSize != 4 {
		t.Fatalf("min_topic_size = %s", captured.body.MinTopicSize)
	}
	var requestID string
	if err := json.Unmarshal(captured.body.RequestID, &requestID); err != nil || requestID != "req_1" {
		t.Fatalf("request_id = %s", captured.body.RequestID)
	}
	var documents []TopicClusteringDocument
	if err := json.Unmarshal(captured.body.Documents, &documents); err != nil {
		t.Fatalf("documents: %v", err)
	}
	if len(documents) != 2 || documents[0].ID != "pa_1" || documents[0].Text != "Title\n\nSummary" {
		t.Fatalf("documents = %#v", documents)
	}
	if len(response.Clusters) != 1 || response.Clusters[0].RepresentativeID != "pa_1" {
		t.Fatalf("response = %#v", response)
	}
	if len(response.OutlierIDs) != 0 {
		t.Fatalf("outliers = %#v", response.OutlierIDs)
	}
}

// TestClusterTopicsConfigurationErrors locks the four exact messages: disabled,
// missing baseUrl, missing token and the temporary unavailability window.
func TestClusterTopicsConfigurationErrors(t *testing.T) {
	cases := []struct {
		name   string
		config modelaccesssettings.AssistantModelServiceConfig
		want   string
	}{
		{
			name:   "disabled",
			config: modelaccesssettings.AssistantModelServiceConfig{Enabled: false},
			want:   "Model service is disabled",
		},
		{
			name:   "missing base url",
			config: modelaccesssettings.AssistantModelServiceConfig{Enabled: true, InternalToken: "t"},
			want:   "Model service baseUrl is not configured",
		},
		{
			name:   "missing token",
			config: modelaccesssettings.AssistantModelServiceConfig{Enabled: true, BaseURL: "http://127.0.0.1:1"},
			want:   "Model service internal token is not configured",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := NewModelClient(staticModelConfig{config: testCase.config})
			_, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
			if err == nil || err.Error() != testCase.want {
				t.Fatalf("error = %v, want %q", err, testCase.want)
			}
		})
	}
}

// TestClusterTopicsUnauthorizedMarksUnavailable locks the 401 branch: the exact
// message, and the process-local disable window that makes the next call fail
// before any HTTP attempt.
func TestClusterTopicsUnauthorizedMarksUnavailable(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"detail":"Unauthorized"}`))
	}))
	defer server.Close()

	client := NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL,
		InternalToken: "secret",
		Timeout:       time.Second,
		MaxRetries:    3,
	}})
	_, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	if err == nil || err.Error() != "Model service request unauthorized" {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1 (401 is not retried)", calls.Load())
	}
	// The second call short-circuits on the temporary unavailability window.
	_, err = client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	if err == nil || err.Error() != "Model service is temporarily unavailable" {
		t.Fatalf("second error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

// TestClusterTopicsNonRetryableStatus locks the 4xx branch: one attempt and the
// formatted status message.
func TestClusterTopicsNonRetryableStatus(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = writer.Write([]byte(`{"detail":"At least two documents are required"}`))
	}))
	defer server.Close()

	client := NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL,
		InternalToken: "secret",
		Timeout:       time.Second,
		MaxRetries:    3,
	}})
	_, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	want := "Model service request failed (status=422): At least two documents are required"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

// TestClusterTopicsRetriesRetryableThenSucceeds locks the retry loop: a 503 is
// retried and the next success is returned.
func TestClusterTopicsRetriesRetryableThenSucceeds(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if calls.Add(1) == 1 {
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"detail":"down"}`))
			return
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"clusters":[],"outlierIds":["pa_1"],"diagnostics":{}}`))
	}))
	defer server.Close()

	client := NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL,
		InternalToken: "secret",
		Timeout:       time.Second,
		MaxRetries:    1,
	}})
	response, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	if err != nil {
		t.Fatalf("cluster: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
	if len(response.OutlierIDs) != 1 || response.OutlierIDs[0] != "pa_1" {
		t.Fatalf("outliers = %#v", response.OutlierIDs)
	}
}

// TestClusterTopicsExhaustedRetriesFails locks the final failure after the
// configured number of attempts and the retry ceiling of 5.
func TestClusterTopicsExhaustedRetriesFails(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(`{"detail":"boom"}`))
	}))
	defer server.Close()

	client := NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL,
		InternalToken: "secret",
		Timeout:       time.Second,
		MaxRetries:    99, // clamped to 5 => 6 attempts
	}})
	_, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	if err == nil || !strings.HasPrefix(err.Error(), "Model service request failed (status=500)") {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 6 {
		t.Fatalf("calls = %d, want 6", calls.Load())
	}
}

// TestClusterTopicsConfigurationReadError locks the propagation of a settings
// read failure.
func TestClusterTopicsConfigurationReadError(t *testing.T) {
	client := NewModelClient(staticModelConfig{err: errors.New("settings unavailable")})
	_, err := client.ClusterTopicsOrThrow(context.Background(), testModelRequest())
	if err == nil || err.Error() != "settings unavailable" {
		t.Fatalf("error = %v", err)
	}
}

// TestModelServiceErrorMessages pins the classify/format helpers directly.
func TestModelServiceErrorMessages(t *testing.T) {
	status := http.StatusTooManyRequests
	retryable := &modelServiceError{Status: &status, Body: []byte(`{"detail":"slow down"}`)}
	if got := classifyModelServiceError(retryable); got != modelErrorRetryable {
		t.Fatalf("429 classification = %v", got)
	}
	if got := formatModelServiceError(errModelServiceRequestFailedBase, retryable); got != "Model service request failed (status=429): slow down" {
		t.Fatalf("429 message = %q", got)
	}

	transport := &modelServiceError{Message: "dial tcp: connection refused"}
	if got := classifyModelServiceError(transport); got != modelErrorRetryable {
		t.Fatalf("transport classification = %v", got)
	}
	if got := formatModelServiceError(errModelServiceRequestFailedBase, transport); got != "Model service request failed: dial tcp: connection refused" {
		t.Fatalf("transport message = %q", got)
	}

	plain := &modelServiceError{Status: &status, Body: []byte("plain text error")}
	if got := formatModelServiceError(errModelServiceRequestFailedBase, plain); got != "Model service request failed (status=429): plain text error" {
		t.Fatalf("plain message = %q", got)
	}
}

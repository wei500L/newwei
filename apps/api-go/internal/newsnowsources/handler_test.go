package newsnowsources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type errorEnvelope struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code"`
	Detail     string `json:"detail"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

func TestSourceHandlerRejectsMissingAndInvalidID(t *testing.T) {
	service := newTestService(fakeRegistry{"zhihu": {ID: "zhihu", Interval: 600000}}, &fakeSecrets{}, newFakeStore())
	handler := NewHandler(service)

	cases := []struct {
		target  string
		message string
	}{
		{"/api/news-aggregator/source", "id query is required"},
		{"/api/news-aggregator/source?id=%20%20", "id query is required"},
		{"/api/news-aggregator/source?id=bad%20id", "invalid source id format"},
		{"/api/news-aggregator/source?id=a&id=b", "id query is required"},
	}
	for _, tc := range cases {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, tc.target, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d", tc.target, recorder.Code)
		}
		var body errorEnvelope
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Message != tc.message || body.Error != "Bad Request" {
			t.Fatalf("%s body=%#v", tc.target, body)
		}
		if body.Code != "" || body.Detail != "" {
			t.Fatalf("400 must not carry code/detail: %#v", body)
		}
		if body.TraceID == "" || body.Timestamp == "" || body.Path != tc.target {
			t.Fatalf("trace/path/timestamp missing: %#v", body)
		}
	}
}

func TestSourceHandlerLatestFlag(t *testing.T) {
	service := newTestService(fakeRegistry{"zhihu": {ID: "zhihu", Interval: 600000}}, &fakeSecrets{}, newFakeStore())
	service.getters["zhihu"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return []NewsItem{newItem(StringID("1"), "t", "https://example.com/1").build()}, nil
	}
	handler := NewHandler(service)

	for _, value := range []string{"maybe", "2"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
			"/api/news-aggregator/source?id=zhihu&latest="+value, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("latest=%s status=%d", value, recorder.Code)
		}
		var body errorEnvelope
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		if body.Message != "latest must be one of true/false, 1/0, yes/no, y/n, on/off" {
			t.Fatalf("latest=%s message=%q", value, body.Message)
		}
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/api/news-aggregator/source?id=zhihu&latest=true&latest=false", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("repeated latest status=%d", recorder.Code)
	}
	var body errorEnvelope
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	if body.Message != "latest must be a boolean string" {
		t.Fatalf("repeated latest message=%q", body.Message)
	}
}

func TestBatchHandlerFiltersAndCounts(t *testing.T) {
	service := newTestService(fakeRegistry{
		"ok":  {ID: "ok", Interval: 600000},
		"bad": {ID: "bad", Interval: 600000},
	}, &fakeSecrets{}, newFakeStore())
	service.getters["ok"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return []NewsItem{newItem(StringID("1"), "ok", "https://example.com/ok").build()}, nil
	}
	service.getters["bad"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return nil, &SecretRequiredError{SourceID: "bad", RequiredKeys: []string{"cookie"}}
	}
	handler := NewHandler(service)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/news-aggregator/sources/batch",
		strings.NewReader(`{"sources":["ok","bad", 7, " ", "ok","unknown"]}`))
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response BatchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Requested != 4 || response.Processed != 3 {
		t.Fatalf("requested/processed=%d/%d", response.Requested, response.Processed)
	}
	if len(response.Results) != 1 || response.Results[0].ID != "ok" {
		t.Fatalf("results=%#v", response.Results)
	}
	if len(response.Errors) != 2 || response.Errors[0].ID != "bad" || response.Errors[1].ID != "unknown" {
		t.Fatalf("errors=%#v", response.Errors)
	}
}

func TestBatchHandlerRejectsNonArraySources(t *testing.T) {
	service := newTestService(fakeRegistry{}, &fakeSecrets{}, newFakeStore())
	handler := NewHandler(service)
	for _, body := range []string{``, `{}`, `{"sources":null}`, `{"sources":"zhihu"}`, `[]`} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/news-aggregator/sources/batch", strings.NewReader(body))
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body=%q status=%d", body, recorder.Code)
		}
		var envelope errorEnvelope
		_ = json.Unmarshal(recorder.Body.Bytes(), &envelope)
		if envelope.Message != "sources must be an array of source ids" {
			t.Fatalf("body=%q message=%q", body, envelope.Message)
		}
	}
}

func TestSourceHandlerRuntimeSecretErrorShape(t *testing.T) {
	store := newFakeStore()
	service := newTestService(fakeRegistry{"weibo": {ID: "weibo", Interval: 120000}}, &fakeSecrets{}, store)
	service.getters["weibo"] = service.fetchWeibo
	handler := NewHandler(service)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/news-aggregator/source?id=weibo", nil))
	if recorder.Code != http.StatusFailedDependency {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body errorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Message != "Runtime secret required for news source: weibo" || body.Code != CodeRuntimeSecretRequired {
		t.Fatalf("body=%#v", body)
	}
	if body.Error != "Failed Dependency" || !strings.Contains(body.Detail, "Configure at least one runtime secret") {
		t.Fatalf("body=%#v", body)
	}
	if strings.Contains(recorder.Body.String(), "sourceId") || strings.Contains(recorder.Body.String(), "requiredKeys") {
		t.Fatalf("filter whitelist leaked internal fields: %s", recorder.Body.String())
	}
}

func TestSourceHandlerFetchFailureShape(t *testing.T) {
	store := newFakeStore()
	service := newTestService(fakeRegistry{"zhihu": {ID: "zhihu", Interval: 600000}}, &fakeSecrets{}, store)
	service.getters["zhihu"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return nil, &fetchStatusError{Method: "GET", URL: "https://example.com", Status: 403}
	}
	handler := NewHandler(service)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/news-aggregator/source?id=zhihu", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", recorder.Code)
	}
	var body errorEnvelope
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	if body.Message != "Internal server error" || body.Error != "Bad Gateway" || body.Code != CodeSourceFetchFailed {
		t.Fatalf("body=%#v", body)
	}
	if !strings.Contains(body.Detail, "403") {
		t.Fatalf("detail=%q", body.Detail)
	}
}

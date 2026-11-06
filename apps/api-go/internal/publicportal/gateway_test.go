package publicportal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayCompletionUsesConfiguredProfile(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"detailed_summary\":\"Detail.\",\"tldr\":\"Short.\"}"}}]}`))
	}))
	defer server.Close()

	store := &fakeStore{gatewayJSON: []byte(`{
		"activeId":"profile-1",
		"profiles":[{
			"id":"profile-1",
			"model":"openai/gpt-4o-mini",
			"apiBase":"` + server.URL + `",
			"apiKey":"secret-key",
			"enabled":true,
			"maxRetries":1,
			"timeoutMs":5000,
			"responseFormatMode":"json_schema",
			"apiSurface":"chat_completions"
		}]
	}`)}
	client := newGateway(store, GatewayEnv{MaxRetries: 1, TimeoutMs: 5000})
	content, err := client.Complete(context.Background(), completionRequest{
		System:   "system",
		User:     "user",
		Metadata: BriefCompletionMetadata{Feature: "news_event_brief"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "detailed_summary") {
		t.Fatalf("content = %s", content)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("auth = %s", gotAuth)
	}
	if gotPath != "/v1/chat/completions" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotBody["temperature"] != 0.2 || gotBody["max_tokens"] != float64(1200) {
		t.Fatalf("body = %#v", gotBody)
	}
	format, _ := gotBody["response_format"].(map[string]any)
	schema, _ := format["json_schema"].(map[string]any)
	if schema["name"] != "news_event_brief_v1" {
		t.Fatalf("format = %#v", format)
	}
}

func TestGovernanceMissingKeyFailsClosed(t *testing.T) {
	_, err := resolveCompletionProfile([]byte(`{
		"activeId":"profile-1",
		"profiles":[{"id":"profile-1","model":"m","apiBase":"http://gateway.example","apiKey":"profile-key","enabled":true}]
	}`), []byte(`{"enabled":true,"targetProfileId":"profile-1"}`), GatewayEnv{})
	status, ok := err.(*StatusError)
	if !ok || status.Code != http.StatusServiceUnavailable {
		t.Fatalf("err = %v", err)
	}
}

package itempipeline

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCircuitOpenNotificationContent(t *testing.T) {
	until := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	title, body, data := circuitOpenNotification("src-1", "Example News", 3, until)
	if title != "News source circuit opened" {
		t.Fatalf("title = %q", title)
	}
	wantBody := `News source "Example News" reached 3 consecutive failures and is paused until 2026-10-20T12:00:00.000Z.`
	if body != wantBody {
		t.Fatalf("body = %q, want %q", body, wantBody)
	}
	var decoded struct {
		SourceID            string `json:"sourceId"`
		SourceName          string `json:"sourceName"`
		ConsecutiveFailures int    `json:"consecutiveFailures"`
		CircuitOpenUntil    string `json:"circuitOpenUntil"`
		Presentation        struct {
			Kind   string         `json:"kind"`
			Params map[string]any `json:"params"`
		} `json:"presentation"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if decoded.SourceID != "src-1" || decoded.SourceName != "Example News" ||
		decoded.ConsecutiveFailures != 3 ||
		decoded.CircuitOpenUntil != "2026-10-20T12:00:00.000Z" {
		t.Fatalf("data = %+v", decoded)
	}
	if decoded.Presentation.Kind != "news_source_circuit_opened" {
		t.Fatalf("presentation kind = %q", decoded.Presentation.Kind)
	}
	if decoded.Presentation.Params["sourceId"] != "src-1" ||
		decoded.Presentation.Params["sourceName"] != "Example News" ||
		decoded.Presentation.Params["consecutiveFailures"] != float64(3) ||
		decoded.Presentation.Params["circuitOpenUntil"] != "2026-10-20T12:00:00.000Z" {
		t.Fatalf("presentation params = %+v", decoded.Presentation.Params)
	}
}

func TestAutoDisableNotificationContent(t *testing.T) {
	title, body, data := autoDisableNotification("src-2", "Another Source", 7)
	if title != "News source disabled after failures" {
		t.Fatalf("title = %q", title)
	}
	wantBody := `News source "Another Source" was disabled after 7 consecutive failures.`
	if body != wantBody {
		t.Fatalf("body = %q, want %q", body, wantBody)
	}
	var decoded struct {
		ConsecutiveFailures int `json:"consecutiveFailures"`
		Presentation        struct {
			Kind   string         `json:"kind"`
			Params map[string]any `json:"params"`
		} `json:"presentation"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if decoded.ConsecutiveFailures != 7 {
		t.Fatalf("data = %+v", decoded)
	}
	if decoded.Presentation.Kind != "news_source_auto_disabled" {
		t.Fatalf("presentation kind = %q", decoded.Presentation.Kind)
	}
	if _, ok := decoded.Presentation.Params["circuitOpenUntil"]; ok {
		t.Fatalf("auto-disable params must not carry circuitOpenUntil: %+v", decoded.Presentation.Params)
	}
}

func TestSanitizeErrorRedactsSensitiveFields(t *testing.T) {
	err := newNamedTestError("Error", "upstream password=secret123 token: abc.def failed")
	sanitized := sanitizeError(err)
	if strings.Contains(sanitized.Message, "secret123") || strings.Contains(sanitized.Message, "abc.def") {
		t.Fatalf("message was not redacted: %q", sanitized.Message)
	}
	if !strings.Contains(sanitized.Message, "[REDACTED]") {
		t.Fatalf("message missing redaction marker: %q", sanitized.Message)
	}
	if sanitized.Name == nil || *sanitized.Name != "Error" {
		t.Fatalf("name = %v", sanitized.Name)
	}
}

func TestSanitizeErrorKeepsNameAndMessage(t *testing.T) {
	err := NewPermanentError("Raw item not found")
	sanitized := sanitizeError(err)
	if sanitized.Message != "Raw item not found" {
		t.Fatalf("message = %q", sanitized.Message)
	}
	if sanitized.Name == nil || *sanitized.Name != "QueuePermanentError" {
		t.Fatalf("name = %v", sanitized.Name)
	}
}

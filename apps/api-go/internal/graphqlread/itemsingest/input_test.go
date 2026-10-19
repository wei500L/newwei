package itemsingestgraphql

import (
	"strings"
	"testing"
)

func TestParseCreateItemInputMessages(t *testing.T) {
	_, err := parseCreateItemInput(map[string]any{
		"input": map[string]any{
			"title":      "ab",
			"externalId": "x",
			"payload":    "",
		},
	})
	if err == nil {
		t.Fatalf("expected validation failure")
	}
	message := err.Error()
	for _, want := range []string{
		"title must be longer than or equal to 3 characters",
		"externalId must be longer than or equal to 3 characters",
		"payload should not be empty",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("message %q missing %q", message, want)
		}
	}
}

func TestParseCreateItemInputKeepsTitlesUntrimmed(t *testing.T) {
	input, err := parseCreateItemInput(map[string]any{
		"input": map[string]any{
			"title":      "  abc  ",
			"externalId": " ext ",
			"payload":    `{"url":"https://x.test"}`,
		},
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if input.Title != "  abc  " || input.ExternalID != " ext " {
		t.Fatalf("title/externalId were trimmed: %+v", input)
	}
}

func TestParseUpdateItemInputMaxLength(t *testing.T) {
	_, err := parseUpdateItemInput(map[string]any{
		"input": map[string]any{
			"id":    "item-1",
			"title": strings.Repeat("a", 256),
		},
	})
	if err == nil || !strings.Contains(err.Error(), "title must be shorter than or equal to 255 characters") {
		t.Fatalf("err = %v", err)
	}
}

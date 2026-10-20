package itemsingest

import (
	"strings"
	"testing"
)

func validOutboxJSON(orgID string) []byte {
	return []byte(`{
		"type":"raw_item",
		"orgId":"` + orgID + `",
		"itemMetaId":"item-1",
		"rawItemId":"507f1f77bcf86cd799439011",
		"source":"api",
		"payload":{"url":"https://example.com/a","tags":[]},
		"pipelineJobId":"job-1",
		"priority":3
	}`)
}

func TestParseOutboxPayload(t *testing.T) {
	payload, err := parseOutboxPayload(validOutboxJSON("org-1"), "org-1")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if payload.Type != "raw_item" || payload.ItemMetaID != "item-1" || payload.RawItemID != "507f1f77bcf86cd799439011" {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.Priority == nil || *payload.Priority != 3 {
		t.Fatalf("priority = %v", payload.Priority)
	}
	if payload.PipelineJobID == nil || *payload.PipelineJobID != "job-1" {
		t.Fatalf("pipelineJobId = %v", payload.PipelineJobID)
	}
}

func TestParseOutboxPayloadRejectsUntrustedRows(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
	}{
		{"org-mismatch", validOutboxJSON("org-2")},
		{"wrong-type", []byte(`{"type":"processed_item","orgId":"org-1"}`)},
		{"invalid-payload", []byte(`{"type":"raw_item","orgId":"org-1","itemMetaId":"i","rawItemId":"r","source":"api","payload":null}`)},
		{"float-priority", []byte(`{"type":"raw_item","orgId":"org-1","itemMetaId":"i","rawItemId":"r","source":"api","payload":{"url":"https://x.test"},"priority":1.5}`)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseOutboxPayload(test.raw, "org-1"); err == nil {
				t.Fatalf("expected rejection")
			}
		})
	}
}

func TestBackoffDelayBounds(t *testing.T) {
	service := &Service{}
	for attempt := 1; attempt <= 10; attempt++ {
		delay := service.backoffDelay(attempt)
		if delay <= 0 {
			t.Fatalf("attempt %d delay = %v", attempt, delay)
		}
		// The exponent is capped at five, so the maximum is 30s*16*1.5.
		if delay > 720000000000 {
			t.Fatalf("attempt %d delay = %v exceeds cap", attempt, delay)
		}
	}
}

func TestToItemMetaNameTruncatesAt191(t *testing.T) {
	if got := toItemMetaName(" short "); got != "short" {
		t.Fatalf("name = %q", got)
	}
	long := strings.Repeat("a", 250)
	got := toItemMetaName(long)
	if len([]rune(got)) != 191 || !strings.HasSuffix(got, "…") {
		t.Fatalf("long name length = %d suffix = %q", len([]rune(got)), got[len(got)-3:])
	}
}

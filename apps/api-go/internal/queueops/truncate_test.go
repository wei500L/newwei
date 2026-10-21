package queueops

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateUTF8KeepsASCIIShort(t *testing.T) {
	text, truncated := truncateUTF8("hello", 10)
	if truncated || text != "hello" {
		t.Fatalf("truncate = %q/%v", text, truncated)
	}
}

func TestTruncateUTF8AddsEllipsis(t *testing.T) {
	text, truncated := truncateUTF8("abcdef", 3)
	if !truncated {
		t.Fatalf("not truncated")
	}
	if text != "abc"+truncationEllipsis {
		t.Fatalf("text = %q", text)
	}
	if !utf8.ValidString(text) {
		t.Fatalf("text is not valid UTF-8")
	}
}

func TestTruncateUTF8DoesNotSplitMultiByteRunes(t *testing.T) {
	// Each 中 is three bytes, so a seven-byte limit falls inside the third rune.
	text, truncated := truncateUTF8("中文中文", 7)
	if !truncated {
		t.Fatalf("not truncated")
	}
	body := strings.TrimSuffix(text, truncationEllipsis)
	if body != "中文" {
		t.Fatalf("body = %q, want 中文", body)
	}
	if !utf8.ValidString(text) {
		t.Fatalf("text is not valid UTF-8")
	}
	if strings.ContainsRune(text, '\uFFFD') {
		t.Fatalf("text carries a replacement rune: %q", text)
	}
}

func TestTruncateUTF8LimitInsideFirstRune(t *testing.T) {
	text, truncated := truncateUTF8("中", 1)
	if !truncated {
		t.Fatalf("not truncated")
	}
	if text != truncationEllipsis {
		t.Fatalf("text = %q, want only the ellipsis", text)
	}
}

func TestTruncateUTF8ReplacesInvalidInput(t *testing.T) {
	invalid := string([]byte{'a', 0xff, 'b'})
	text, truncated := truncateUTF8(invalid, 10)
	if truncated {
		t.Fatalf("short invalid text reported as truncated")
	}
	if !utf8.ValidString(text) {
		t.Fatalf("text is not valid UTF-8")
	}
}

func TestDataPreviewTruncatesAtTwoThousandBytes(t *testing.T) {
	payload := make([]byte, 0, 4000)
	payload = append(payload, '{', '"')
	// 中 is three bytes: the cut must land on a rune boundary.
	for len(payload) < 3990 {
		payload = append(payload, "中"...)
	}
	preview := dataPreview(payload)
	if !strings.HasSuffix(preview, truncationEllipsis) {
		t.Fatalf("preview has no ellipsis")
	}
	body := strings.TrimSuffix(preview, truncationEllipsis)
	if len(body) > dataPreviewBytes {
		t.Fatalf("preview body is %d bytes", len(body))
	}
	if !utf8.ValidString(preview) {
		t.Fatalf("preview is not valid UTF-8")
	}
}

func TestDataPreviewKeepsShortPayload(t *testing.T) {
	payload := json.RawMessage(`{"orgId":"org-a"}`)
	if preview := dataPreview(payload); preview != string(payload) {
		t.Fatalf("preview = %q", preview)
	}
}

func TestTruncateJSONDocumentKeepsSmallDocument(t *testing.T) {
	payload := json.RawMessage(`{"orgId":"org-a"}`)
	data, truncated := truncateJSONDocument(payload)
	if truncated {
		t.Fatalf("small document reported as truncated")
	}
	if string(data) != string(payload) {
		t.Fatalf("data = %s", data)
	}
}

func TestTruncateJSONDocumentReturnsAJSONStringWhenCut(t *testing.T) {
	// A truncated JSON object would not be a valid document, so the oversized
	// payload becomes a JSON string of the truncated text.
	payload := make([]byte, 0, jobDetailDataBytes+16)
	payload = append(payload, `{"blob":"`...)
	for len(payload) < jobDetailDataBytes+8 {
		payload = append(payload, 'a')
	}
	payload = append(payload, `"}`...)

	data, truncated := truncateJSONDocument(payload)
	if !truncated {
		t.Fatalf("oversized document reported as complete")
	}
	if !json.Valid(data) {
		t.Fatalf("response data is not valid JSON")
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		t.Fatalf("data is not a JSON string: %v", err)
	}
	body := strings.TrimSuffix(text, truncationEllipsis)
	if len(body) > jobDetailDataBytes {
		t.Fatalf("truncated body is %d bytes", len(body))
	}
	if !utf8.ValidString(text) {
		t.Fatalf("truncated text is not valid UTF-8")
	}
}

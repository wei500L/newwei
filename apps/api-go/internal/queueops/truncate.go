package queueops

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// truncationEllipsis marks a truncated payload. It is a single rune appended
// after the cut, so the result stays valid UTF-8.
const truncationEllipsis = "…"

// truncateUTF8 cuts text to at most limit bytes and reports whether it cut
// anything.
//
// The cut never splits a multi-byte UTF-8 character: it backs up to the previous
// rune start, so the returned string is always valid UTF-8. Invalid input bytes
// are replaced with U+FFFD, which keeps the "valid UTF-8" guarantee for a job
// payload that was written by something other than JSON.stringify.
func truncateUTF8(text string, limit int) (string, bool) {
	if limit <= 0 || len(text) <= limit {
		return strings.ToValidUTF8(text, "\uFFFD"), false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return strings.ToValidUTF8(text[:cut], "\uFFFD") + truncationEllipsis, true
}

// dataPreview builds the JobSummary.dataPreview value: the stored payload text
// truncated to dataPreviewBytes and suffixed with "…" when it was cut.
func dataPreview(data json.RawMessage) string {
	preview, _ := truncateUTF8(string(data), dataPreviewBytes)
	return preview
}

// truncateJSONDocument bounds the detail payload. A stored document under the
// limit is returned unchanged. An oversized document cannot stay a valid JSON
// object once cut, so it is returned as a JSON string holding the truncated text;
// the caller sets dataTruncated so the console renders it as text.
func truncateJSONDocument(data json.RawMessage) (json.RawMessage, bool) {
	if len(data) <= jobDetailDataBytes {
		return data, false
	}
	truncated, _ := truncateUTF8(string(data), jobDetailDataBytes)
	encoded, err := json.Marshal(truncated)
	if err != nil {
		return json.RawMessage(`null`), true
	}
	return json.RawMessage(encoded), true
}

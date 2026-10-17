package platformgovernance

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

// optionalBool decodes a stored JSON value that NestJS inspects with
// `typeof value === "boolean"`. An absent key, null, a number or a string all
// decode to present=false, so the caller applies its own fallback. The value is
// never widened to a loose container.
type optionalBool struct {
	present bool
	value   bool
}

// UnmarshalJSON records only the two JSON literals NestJS accepts.
func (b *optionalBool) UnmarshalJSON(data []byte) error {
	switch string(bytes.TrimSpace(data)) {
	case "true":
		b.present, b.value = true, true
	case "false":
		b.present, b.value = true, false
	}
	return nil
}

// optionalString decodes a stored JSON string. Non-string values are ignored,
// which is what every NestJS `=== "..."` comparison does.
type optionalString struct {
	present bool
	value   string
}

// UnmarshalJSON records only JSON string literals.
func (s *optionalString) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return nil
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return nil
	}
	s.present, s.value = true, text
	return nil
}

// optionalJSONNumber decodes a stored JSON value that NestJS inspects with
// `typeof value === "number"` (no Number() coercion). Numeric strings therefore
// decode to present=false, unlike jsNumberish.
type optionalJSONNumber struct {
	present bool
	value   float64
}

// UnmarshalJSON records only JSON number literals.
func (n *optionalJSONNumber) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return nil
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil
	}
	n.present, n.value = true, value
	return nil
}

// nestTime serializes a timestamp exactly like JavaScript's
// Date.prototype.toISOString: UTC, millisecond precision, trailing Z. Express
// res.json produces this shape, so byte-level parity depends on it.
type nestTime time.Time

// MarshalJSON renders the timestamp in JavaScript ISO-8601 form.
func (t nestTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Time(t).UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

// storedValueIsObjectLike reports whether a SystemSetting.value is an object or
// an array, which is what the NestJS `raw && typeof raw === "object"` checks
// accept. It returns the bytes NestJS caches verbatim (Array.isArray is still an
// object for typeof).
func storedValueIsObjectLike(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false
	}
	switch trimmed[0] {
	case '{', '[':
		return trimmed, true
	default:
		return nil, false
	}
}

// storedValueForStruct returns the bytes that may be decoded into a named
// SystemSetting.value struct. A stored array is object-like to NestJS but has
// none of the named fields, and decoding it as a struct would fail, so it yields
// nil while still reporting present=true (the caller then reports source="db"
// with every field at its default).
func storedValueForStruct(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed, ok := storedValueIsObjectLike(raw)
	if !ok {
		return nil, false
	}
	if trimmed[0] == '[' {
		return nil, true
	}
	return trimmed, true
}

// isNullValue reports whether a raw JSON field holds the literal null. NestJS
// distinguishes undefined (absent) from null, and so must the DTO layer.
func isNullValue(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// hasValue reports whether a decoded field holds JSON at all. An absent key
// leaves json.RawMessage nil; `null` is present with the four bytes "null".
func hasValue(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// containsString reports whether values already holds target. Small ordered
// lists use it instead of a set map so no loose container appears in this
// package.
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// normalizeOrgID mirrors LlmRequestLogService.normalizeOrgId: the trimmed orgId,
// or the "_unknown_" bucket when it is empty.
func normalizeOrgID(orgID string) string {
	trimmed := strings.TrimSpace(orgID)
	if trimmed == "" {
		return unknownOrgID
	}
	return trimmed
}

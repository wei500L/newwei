package infrastructuresettings

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Stored runtime-secret document types.

// runtimeStoredEntry is one strictly parsed entry. Value keeps the exact JSON
// that will be written back (a plain string or a v1 envelope).
type runtimeStoredEntry struct {
	SourceID    string
	Key         string
	Value       json.RawMessage
	Fingerprint string
	UpdatedAt   string
}

// runtimeStoredSettings is the strictly parsed document.
type runtimeStoredSettings struct {
	Entries []runtimeStoredEntry
}

// rawRuntimeDocument is the schema-less read boundary for the stored JSON.
type rawRuntimeDocument struct {
	Version json.RawMessage `json:"version"`
	Entries json.RawMessage `json:"entries"`
}

// rawRuntimeEntry is the schema-less read boundary for one stored entry.
type rawRuntimeEntry struct {
	SourceID    json.RawMessage `json:"sourceId"`
	Key         json.RawMessage `json:"key"`
	Value       json.RawMessage `json:"value"`
	Fingerprint json.RawMessage `json:"fingerprint"`
	UpdatedAt   json.RawMessage `json:"updatedAt"`
}

// invalidRuntimeSecrets builds the safe 409 payload with the branch-specific
// detail string. The Go side and the NestJS side keep the same mixed 400/409
// semantics: a broken sourceId or key surfaces as the business 400, everything
// else as this 409.
func invalidRuntimeSecrets(detail string) error {
	return &httpError{
		status:  http.StatusConflict,
		code:    "NEWS_SOURCE_RUNTIME_SECRETS_INVALID",
		message: "Stored news source runtime secrets are invalid.",
		detail:  detail,
	}
}

// parseRuntimeSecretsStrict mirrors parseStoredSettingsStrict.
func parseRuntimeSecretsStrict(raw json.RawMessage) (*runtimeStoredSettings, error) {
	trimmed := trimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	if trimmed[0] != '{' && trimmed[0] != '[' {
		return nil, invalidRuntimeSecrets("Expected object with entries array.")
	}

	document := rawRuntimeDocument{}
	if trimmed[0] == '{' {
		if err := json.Unmarshal(trimmed, &document); err != nil {
			return nil, invalidRuntimeSecrets("Expected object with entries array.")
		}
	}
	if present(document.Version) {
		value, ok := jsonNumberStrict(document.Version)
		if !ok || value != 1 {
			return nil, invalidRuntimeSecrets("Unsupported version for runtime secrets settings.")
		}
	}
	entriesRaw := trimSpace(document.Entries)
	if len(entriesRaw) == 0 || entriesRaw[0] != '[' {
		return nil, invalidRuntimeSecrets("entries must be an array.")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(entriesRaw, &items); err != nil {
		return nil, invalidRuntimeSecrets("entries must be an array.")
	}

	type keyedEntry struct {
		key   string
		entry runtimeStoredEntry
	}
	ordered := make([]keyedEntry, 0, len(items))
	positions := make(map[string]int, len(items))
	for _, item := range items {
		entry, err := parseRuntimeEntryStrict(item)
		if err != nil {
			return nil, err
		}
		composite := runtimeCompositeKey(entry.SourceID, entry.Key)
		if position, seen := positions[composite]; seen {
			// Last duplicate wins, keeping the first insertion position.
			ordered[position].entry = entry
			continue
		}
		positions[composite] = len(ordered)
		ordered = append(ordered, keyedEntry{key: composite, entry: entry})
	}

	result := &runtimeStoredSettings{Entries: make([]runtimeStoredEntry, 0, len(ordered))}
	for _, item := range ordered {
		result.Entries = append(result.Entries, item.entry)
	}
	sortRuntimeEntries(result.Entries)
	return result, nil
}

// parseRuntimeEntryStrict mirrors parseStoredEntryStrict.
func parseRuntimeEntryStrict(raw json.RawMessage) (runtimeStoredEntry, error) {
	trimmed := trimSpace(raw)
	if len(trimmed) == 0 || (trimmed[0] != '{' && trimmed[0] != '[') {
		return runtimeStoredEntry{}, invalidRuntimeSecrets("entries contains invalid object.")
	}
	entry := rawRuntimeEntry{}
	if trimmed[0] == '{' {
		if err := json.Unmarshal(trimmed, &entry); err != nil {
			return runtimeStoredEntry{}, invalidRuntimeSecrets("entries contains invalid object.")
		}
	}

	sourceID, err := normalizeRuntimeSourceID(jsStringFromJSON(entry.SourceID))
	if err != nil {
		return runtimeStoredEntry{}, err
	}
	key, err := normalizeRuntimeKey(jsStringFromJSON(entry.Key))
	if err != nil {
		return runtimeStoredEntry{}, err
	}

	value := parseStoredSecretValue(entry.Value)
	if value.kind != secretPlaintext && value.kind != secretEncrypted {
		return runtimeStoredEntry{}, invalidRuntimeSecrets(
			fmt.Sprintf("Invalid value type for %s.%s.", sourceID, key))
	}
	storedValue := entry.Value
	if value.kind == secretEncrypted {
		encoded, err := value.encrypted.encodeJSON()
		if err != nil {
			return runtimeStoredEntry{}, err
		}
		storedValue = encoded
	}

	fingerprint := ""
	if text, ok := storedString(entry.Fingerprint); ok {
		fingerprint = strings.TrimSpace(text)
	}
	if fingerprint == "" {
		if value.kind == secretPlaintext {
			fingerprint = fingerprintSecretValue(value.plaintext)
		} else {
			fingerprint = "encrypted"
		}
	}

	updatedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if text, ok := storedString(entry.UpdatedAt); ok {
		if parsed, ok := parseJSTime(text); ok {
			updatedAt = parsed.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}

	return runtimeStoredEntry{
		SourceID:    sourceID,
		Key:         key,
		Value:       storedValue,
		Fingerprint: fingerprint,
		UpdatedAt:   updatedAt,
	}, nil
}

// normalizeRuntimeSourceID mirrors normalizeSourceId and its 400.
func normalizeRuntimeSourceID(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || !sourceIDRe.MatchString(normalized) {
		return "", &httpError{status: http.StatusBadRequest, message: "sourceId must match " + sourceIDPatternText}
	}
	return normalized, nil
}

// normalizeRuntimeKey mirrors normalizeSecretKey and its 400. The length rule
// uses String.prototype.length (UTF-16 code units).
func normalizeRuntimeKey(value string) (string, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" || !secretKeyRe.MatchString(normalized) || utf16Length(normalized) > runtimeSecretsKeyMaxRunes {
		return "", &httpError{
			status:  http.StatusBadRequest,
			message: "key must match " + secretKeyPatternText + " and be <= 128 chars",
		}
	}
	return normalized, nil
}

// normalizeRuntimeValue mirrors normalizeSecretValue and its 400s.
func normalizeRuntimeValue(value string) (string, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return "", &httpError{status: http.StatusBadRequest, message: "value is required"}
	}
	if utf16Length(normalized) > runtimeSecretsValMaxRunes {
		return "", &httpError{status: http.StatusBadRequest, message: "value must be <= 8192 chars"}
	}
	return normalized, nil
}

// fingerprintSecretValue mirrors fingerprintSecret: the first 16 hex characters
// of the SHA-256 of the UTF-8 bytes.
func fingerprintSecretValue(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

// runtimeCompositeKey mirrors makeCompositeKey.
func runtimeCompositeKey(sourceID, key string) string { return sourceID + "::" + key }

// sortRuntimeEntries mirrors the localeCompare ordering (sourceId, then key).
func sortRuntimeEntries(entries []runtimeStoredEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].SourceID == entries[j].SourceID {
			return localeCompare(entries[i].Key, entries[j].Key) < 0
		}
		return localeCompare(entries[i].SourceID, entries[j].SourceID) < 0
	})
}

// jsStringFromJSON mirrors `String(value ?? "")` for a decoded JSON value: the
// strict parser stringifies broken sourceId/key members before normalizing
// them, so a number member becomes its decimal text rather than a silent 409.
func jsStringFromJSON(raw json.RawMessage) string {
	trimmed := trimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return ""
		}
		return text
	case 't':
		return "true"
	case 'f':
		return "false"
	case 'n':
		return ""
	case '{':
		return "[object Object]"
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return ""
		}
		parts := make([]string, 0, len(items))
		for _, item := range items {
			element := trimSpace(item)
			if len(element) == 0 || bytes.Equal(element, []byte("null")) {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, jsStringFromJSON(item))
		}
		return strings.Join(parts, ",")
	default:
		return jsNumberTokenToString(trimmed)
	}
}

// jsNumberTokenToString renders a JSON number the way String(number) does for
// the values the strict parser can realistically encounter.
func jsNumberTokenToString(trimmed []byte) string {
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil || math.IsNaN(value) {
		return ""
	}
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// jsTimeLayouts lists the date formats the strict parser accepts, in the order
// JavaScript's Date constructor would resolve them. A value without a zone is
// interpreted as UTC (the CI and production containers run with TZ=UTC).
var jsTimeLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02",
	"2006/01/02",
	time.RFC1123,
	time.RFC1123Z,
	"Mon Jan 2 2006 15:04:05",
	"Mon, 02 Jan 2006 15:04:05 GMT",
	"January 2, 2006",
	"Jan 2, 2006",
}

// parseJSTime reports whether the text is a usable date and returns it.
func parseJSTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range jsTimeLayouts {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

package situationsettings

import (
	"bytes"
	"encoding/json"
	"log"
	"math"
	"net/url"
	"strconv"
	"strings"
)

// rawAbsent reports whether a JSON member was absent from the document. A
// present null is not absent.
func rawAbsent(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) == 0
}

// rawIsNull reports whether the member is the JSON literal null.
func rawIsNull(raw json.RawMessage) bool {
	return raw != nil && bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// rawIsTruthy reproduces JavaScript truthiness for a decoded JSON value. It is
// used by resolveStoredApiKey's `if (!raw)` guard.
func rawIsTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("false")) {
		return false
	}
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) == nil {
			return text != ""
		}
		return false
	}
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		return true
	}
	number, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		// true, or an unparseable token: only true stays truthy.
		return string(trimmed) == "true"
	}
	return number != 0
}

// normalizeStringRaw mirrors normalizeString: a JSON string is trimmed and an
// empty result becomes "absent"; every other JSON type is absent.
func normalizeStringRaw(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}
	return text, true
}

// normalizeURLRaw mirrors normalizeUrl: normalizeString followed by trailing
// slash removal. It does not validate the URL.
func normalizeURLRaw(raw json.RawMessage) (string, bool) {
	value, ok := normalizeStringRaw(raw)
	if !ok {
		return "", false
	}
	return strings.TrimRight(value, "/"), true
}

// asBooleanRaw mirrors asBoolean: only a real JSON boolean wins.
func asBooleanRaw(raw json.RawMessage, fallback bool) bool {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

// asBoundedIntRaw mirrors asBoundedInt on a stored unknown value:
// Number(value), NaN/Infinity keeps the fallback, Math.trunc, then clamp.
func asBoundedIntRaw(raw json.RawMessage, fallback, min, max int) int {
	if rawAbsent(raw) {
		return clampInt(fallback, min, max)
	}
	parsed, ok := jsNumber(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return clampInt(fallback, min, max)
	}
	return clampInt(int(math.Trunc(parsed)), min, max)
}

// jsNumber reproduces JavaScript's Number(value) for a decoded JSON value. The
// second result is false only when the token is not number-like.
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return math.NaN(), true
		}
		return jsStringToNumber(text), true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return 0, true
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return math.NaN(), true
		}
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			return jsNumber(items[0])
		default:
			return math.NaN(), true
		}
	case '{':
		return math.NaN(), true
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errorsAsRange(err, &numErr) {
				return value, true
			}
			return math.NaN(), true
		}
		return value, true
	}
}

// jsStringToNumber mirrors Number(string) for the shapes a stored setting can
// contain: empty string is 0, hexadecimal literals parse, everything else goes
// through ParseFloat (which accepts "Infinity" only via the explicit branches).
func jsStringToNumber(value string) float64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	switch strings.ToLower(trimmed) {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "0x") {
		if parsed, err := strconv.ParseInt(trimmed[2:], 16, 64); err == nil {
			return float64(parsed)
		}
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errorsAsRange(err, &numErr) {
			return parsed
		}
		return math.NaN()
	}
	return parsed
}

// errorsAsRange reports strconv.ErrRange, which JSON.parse/Number turn into
// Infinity rather than NaN.
func errorsAsRange(err error, target **strconv.NumError) bool {
	numErr, ok := err.(*strconv.NumError)
	if !ok {
		return false
	}
	*target = numErr
	return numErr.Err == strconv.ErrRange
}

// validateURL mirrors validateUrl: parse as an absolute URL, require one of the
// allowed protocols, serialize and strip trailing slashes. The returned error
// text is the exact BadRequestException message.
func validateURL(value, fieldName string, allowedProtocols ...string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return "", invalidURLError(fieldName, allowedProtocols)
	}
	allowed := false
	for _, scheme := range allowedProtocols {
		if strings.EqualFold(parsed.Scheme, scheme) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", invalidURLError(fieldName, allowedProtocols)
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	// WHATWG URL serializes an empty path as "/" for an authority URL, so a
	// query-only URL keeps the slash that NestJS stores
	// (https://host/?a=1). The trailing-slash strip below then reproduces the
	// NestJS `replace(/\/+$/, "")` result for both shapes.
	if parsed.Host != "" && parsed.Path == "" {
		parsed.Path = "/"
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func invalidURLError(fieldName string, allowedProtocols []string) error {
	hint := "http(s) URL"
	if len(allowedProtocols) == 1 && strings.EqualFold(allowedProtocols[0], "https") {
		hint = "https URL"
	}
	return badRequest(fieldName + " must be a valid " + hint)
}

// normalizeHTTPSURLRaw mirrors normalizeHttpsUrl: invalid or non-https stored
// values read as null instead of raising.
func normalizeHTTPSURLRaw(raw json.RawMessage) *string {
	value, ok := normalizeStringRaw(raw)
	if !ok {
		return nil
	}
	normalized, err := validateURL(value, "url", "https")
	if err != nil {
		return nil
	}
	return &normalized
}

// normalizeHTTPURLRaw mirrors normalizeHttpUrl.
func normalizeHTTPURLRaw(raw json.RawMessage) *string {
	value, ok := normalizeStringRaw(raw)
	if !ok {
		return nil
	}
	normalized, err := validateURL(value, "url", "http", "https")
	if err != nil {
		return nil
	}
	return &normalized
}

// normalizeHostListRaw mirrors normalizeHostList: a non-array reads as empty,
// entries are lower-cased bare hostnames and duplicates are dropped in order.
func normalizeHostListRaw(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return []string{}
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		value, ok := normalizeStringRaw(item)
		if !ok {
			continue
		}
		host, ok := normalizeHostEntry(value)
		if !ok || seen[host] {
			continue
		}
		seen[host] = true
		out = append(out, host)
	}
	return out
}

// parseHostCSV mirrors parseHostCsv: split on newlines and commas, normalize,
// dedupe and reject more than 64 unique hosts.
func parseHostCSV(value, fieldName string) ([]string, error) {
	entries := strings.FieldsFunc(value, func(r rune) bool { return r == '\n' || r == ',' })
	out := make([]string, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		host, ok := normalizeHostEntry(entry)
		if !ok || seen[host] {
			continue
		}
		seen[host] = true
		out = append(out, host)
	}
	if len(out) > maxLiveHLSProxyAllowedHosts {
		return nil, badRequest(fieldName + " must have at most 64 hosts")
	}
	return out, nil
}

// normalizeHostEntry mirrors normalizeHostEntry: a hostname only, no path, no
// port, no credentials.
func normalizeHostEntry(value string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return "", false
	}
	// WHATWG URL punycodes a non-ASCII hostname, so it no longer equals the
	// original entry and normalizeHostEntry returns null. Reject it here too.
	for _, r := range normalized {
		if r > 127 {
			return "", false
		}
	}
	parsed, err := url.Parse("https://" + normalized)
	if err != nil {
		return "", false
	}
	if parsed.Hostname() != normalized || parsed.Port() != "" {
		return "", false
	}
	if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", false
	}
	return normalized, true
}

// resolveStoredAPIKey mirrors resolveStoredApiKey. The second result is false
// when the field is falsy, not a string and not an encrypted v1 envelope, or
// when the key is missing/undecryptable (the NestJS method logs and returns
// undefined in those cases).
func resolveStoredAPIKey(raw json.RawMessage, keyName string, env Env) (string, bool) {
	if !rawIsTruthy(raw) {
		return "", false
	}
	if value, ok := normalizeStringRaw(raw); ok {
		return value, true
	}
	if !isEncryptedSettingsValue(raw) {
		return "", false
	}
	if !env.EncryptionKeyPresent() {
		log.Printf("situationsettings: missing SYSTEM_SETTINGS_ENCRYPTION_KEY for situation monitor %s", keyName)
		return "", false
	}
	plain, ok := decryptSettingsSecret(raw, env.EncryptionKeyRaw)
	if !ok {
		log.Printf("situationsettings: failed to decrypt situation monitor %s", keyName)
		return "", false
	}
	value, ok := normalizeStringRaw(mustJSONString(plain))
	if !ok {
		return "", false
	}
	return value, true
}

func mustJSONString(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

// resolveAPIKeySource mirrors resolveApiKeySource.
func resolveAPIKeySource(stored, effective string) APIKeySource {
	if stored != "" {
		return APIKeySourceStored
	}
	if effective != "" {
		return APIKeySourceEnv
	}
	return APIKeySourceNone
}

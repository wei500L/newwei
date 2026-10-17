package modelaccesssettings

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// SystemSetting primary keys, descriptions, Redis cache keys and TTLs.
//
// Every key is a global primary key with no org dimension, which is exactly why
// the write paths require a platform admin (MA1) and why the merge baseline must
// come from MySQL inside the lock (MA2/MA3).
const (
	settingKeyModelService  = "model_service"
	descriptionModelService = "Model service integration (time-series forecasting/anomaly) configuration."
	cacheKeyModelService    = "model_service:settings"

	settingKeyOpenAiKeys  = "openai_keys"
	descriptionOpenAiKeys = "OpenAI upstream API keys (used by LiteLLM proxy + moderation guardrails)."
	cacheKeyOpenAiKeys    = "openai_keys:settings"

	settingKeyAppliedStatus  = "litellm_openai_keys_applied"
	descriptionAppliedStatus = "LiteLLM Proxy applied OpenAI key fingerprints (reported at startup)."
	cacheKeyAppliedStatus    = "openai_keys:applied_status"

	// settingKeySystemSecurity / cacheKeySystemSecurity are READ-ONLY here: the
	// encryption policy needs secretEncryptionEnabled and nothing else. The owner
	// (SystemSecuritySettingsService) keeps writing both.
	settingKeySystemSecurity = "system_security"
	cacheKeySystemSecurity   = "system_security:settings"
	// systemSecurityCacheTTL is 60s because SystemSecuritySettingsService
	// hard-codes CACHE_TTL_SECONDS = 60 — deliberately not the 30s the other
	// three envelopes use.
	systemSecurityCacheTTL   = 60
	settingsCacheTTLSeconds  = 30
	appliedCacheTTLSeconds   = 30
	maxOpenAiApiKeys         = 100
	settingsResourceName     = "system_settings"
	actionModelServiceUpdate = "model_service_update"
	actionModelServiceReset  = "model_service_reset"
	actionOpenAiKeysUpdate   = "openai_keys_update"
	actionOpenAiKeysReset    = "openai_keys_reset"
)

// ---- stored model_service ----

// storedModelServicePayload is the decoded model_service row. Every field stays
// a json.RawMessage because NestJS interprets the stored value as a loose record
// whose fields may hold any JSON shape (a stored timeoutMs may be the string
// "15000", a legacy row may hold an encrypted token object, ...). The raw bytes
// are never passed through to a response: they are immediately projected into
// the typed accessors below.
type storedModelServicePayload struct {
	Enabled       json.RawMessage `json:"enabled"`
	BaseURL       json.RawMessage `json:"baseUrl"`
	InternalToken json.RawMessage `json:"internalToken"`
	TimeoutMs     json.RawMessage `json:"timeoutMs"`
	MaxRetries    json.RawMessage `json:"maxRetries"`
}

// modelServiceRecord is one decoded row plus the "stored" predicate.
//
// NestJS computes `settings = raw && typeof raw === "object" ? raw : null`, so a
// JSON array also counts as stored (typeof [] === "object") while a JSON
// primitive or null does not.
type modelServiceRecord struct {
	// present mirrors "settings !== null" and drives source=db|env.
	present bool
	// payload holds the named fields; zero when the stored value was an array.
	payload storedModelServicePayload
}

// decodeModelServiceRecord classifies a raw SystemSetting.value for
// key=model_service. An empty raw means "row missing".
func decodeModelServiceRecord(raw json.RawMessage) (modelServiceRecord, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return modelServiceRecord{}, nil
	}
	switch trimmed[0] {
	case '{':
		var payload storedModelServicePayload
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return modelServiceRecord{}, err
		}
		return modelServiceRecord{present: true, payload: payload}, nil
	case '[':
		// typeof [] === "object": stored, but with no readable fields.
		return modelServiceRecord{present: true}, nil
	default:
		return modelServiceRecord{}, nil
	}
}

// modelServiceSettingsPublic is the GET/PUT/DELETE response body. Field order
// matches the NestJS object literal (and therefore the JSON byte order).
type modelServiceSettingsPublic struct {
	Source      settingsSource `json:"source"`
	Enabled     bool           `json:"enabled"`
	BaseURL     *string        `json:"baseUrl"`
	TimeoutMs   int            `json:"timeoutMs"`
	MaxRetries  int            `json:"maxRetries"`
	HasToken    bool           `json:"hasToken"`
	TokenSource tokenSource    `json:"tokenSource"`
}

// modelServiceSettingsWrite is the stored representation this package writes
// back. Field order matches the NestJS `nextStored` object literal exactly.
type modelServiceSettingsWrite struct {
	Enabled       bool        `json:"enabled"`
	BaseURL       *string     `json:"baseUrl"`
	InternalToken secretValue `json:"internalToken"`
	TimeoutMs     int         `json:"timeoutMs"`
	MaxRetries    int         `json:"maxRetries"`
}

// modelServiceUpdateAudit is the AuditLog.metadata document of
// action=model_service_update. It never carries the token.
type modelServiceUpdateAudit struct {
	Enabled         bool    `json:"enabled"`
	BaseURL         *string `json:"baseUrl"`
	TimeoutMs       int     `json:"timeoutMs"`
	MaxRetries      int     `json:"maxRetries"`
	TokenUpdated    bool    `json:"tokenUpdated"`
	TokenConfigured bool    `json:"tokenConfigured"`
}

// okAudit is the AuditLog.metadata of the two reset actions.
type okAudit struct {
	OK bool `json:"ok"`
}

// keysCountAudit is the AuditLog.metadata of action=openai_keys_update.
type keysCountAudit struct {
	KeysCount int `json:"keysCount"`
}

// ---- stored openai_keys ----

// storedOpenAiKeysPayload is the decoded openai_keys row.
type storedOpenAiKeysPayload struct {
	OpenaiApiKeys []json.RawMessage `json:"openaiApiKeys"`
}

// openAiKeysRecord is one decoded row plus the "stored" predicate (see
// modelServiceRecord).
type openAiKeysRecord struct {
	present bool
	// entries holds the raw array entries in stored order. NestJS preserves the
	// source order for fingerprints and for the resolveKeys output.
	entries []json.RawMessage
}

// decodeOpenAiKeysRecord classifies a raw SystemSetting.value for
// key=openai_keys.
func decodeOpenAiKeysRecord(raw json.RawMessage) (openAiKeysRecord, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return openAiKeysRecord{}, nil
	}
	switch trimmed[0] {
	case '{':
		var payload storedOpenAiKeysPayload
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return openAiKeysRecord{}, err
		}
		return openAiKeysRecord{present: true, entries: payload.OpenaiApiKeys}, nil
	case '[':
		return openAiKeysRecord{present: true}, nil
	default:
		return openAiKeysRecord{}, nil
	}
}

// wrappedOpenAiKey is the {fingerprint, value} entry shape.
type wrappedOpenAiKey struct {
	fingerprint string
	value       secretValue
}

// openAiKeyEntry is the discriminated union of the three legacy OpenAI key
// entry shapes. countStoredKeys, resolveKeys and listKeyFingerprints each read a
// different subset of this union on purpose — the differences are part of the
// stored-data contract and are covered by unit tests and the real-stack smoke.
type openAiKeyEntry struct {
	kind      openAiKeyKind
	plain     string
	encrypted secretValue
	wrapped   wrappedOpenAiKey
}

// openAiKeysSettingsPublic is the openai_keys response body. Field order matches
// the NestJS object literal.
type openAiKeysSettingsPublic struct {
	Source                  settingsSource `json:"source"`
	KeysCount               int            `json:"keysCount"`
	HasKeys                 bool           `json:"hasKeys"`
	KeyFingerprints         []string       `json:"keyFingerprints"`
	InternalTokenConfigured bool           `json:"internalTokenConfigured"`
	AppliedAt               *string        `json:"appliedAt"`
	AppliedSource           *appliedSource `json:"appliedSource"`
	AppliedKeyFingerprints  []string       `json:"appliedKeyFingerprints"`
	RestartRequired         bool           `json:"restartRequired"`
}

// openAiKeysSettingsWrite is the stored representation written by PUT/POST/
// DELETE-key. Field order matches NestJS.
type openAiKeysSettingsWrite struct {
	OpenaiApiKeys []openAiKeyEntryWrite `json:"openaiApiKeys"`
}

// openAiKeyEntryWrite is one freshly encoded {fingerprint, value} entry.
type openAiKeyEntryWrite struct {
	Fingerprint string      `json:"fingerprint"`
	Value       secretValue `json:"value"`
}

// openAiKeysInternalResponse is the plaintext-key response of route 9.
type openAiKeysInternalResponse struct {
	OpenaiApiKeys []string `json:"openaiApiKeys"`
}

// ---- stored applied status ----

// storedAppliedStatusPayload is the decoded litellm_openai_keys_applied row.
type storedAppliedStatusPayload struct {
	Source          json.RawMessage   `json:"source"`
	KeyFingerprints []json.RawMessage `json:"keyFingerprints"`
	AppliedAt       json.RawMessage   `json:"appliedAt"`
}

// appliedStatusRecord is one decoded applied-status row plus the "stored"
// predicate.
type appliedStatusRecord struct {
	present bool
	payload storedAppliedStatusPayload
}

// decodeAppliedStatusRecord classifies a raw SystemSetting.value for
// key=litellm_openai_keys_applied.
func decodeAppliedStatusRecord(raw json.RawMessage) (appliedStatusRecord, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return appliedStatusRecord{}, nil
	}
	switch trimmed[0] {
	case '{':
		var payload storedAppliedStatusPayload
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return appliedStatusRecord{}, err
		}
		return appliedStatusRecord{present: true, payload: payload}, nil
	case '[':
		return appliedStatusRecord{present: true}, nil
	default:
		return appliedStatusRecord{}, nil
	}
}

// appliedStatusWrite is the stored representation written by route 10. Field
// order matches NestJS.
type appliedStatusWrite struct {
	Source          appliedSource `json:"source"`
	KeyFingerprints []string      `json:"keyFingerprints"`
	AppliedAt       string        `json:"appliedAt"`
}

// okResponse is the {"ok":true} body of route 10.
type okResponse struct {
	OK bool `json:"ok"`
}

// ---- Redis cache envelopes ----

// cacheEnvelope is the JSON envelope both settings services use:
// {"exists":true,"value":{...}}. `value` is omitted when the row exists but its
// value is not an object (JSON.stringify drops undefined), exactly like
// CacheService.set.
type cacheEnvelope struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// ---- system_security projection (read-only) ----

// systemSecurityPayload is the only field this package consumes from the
// system_security row.
type systemSecurityPayload struct {
	SecretEncryptionEnabled json.RawMessage `json:"secretEncryptionEnabled"`
}

// systemSecurityRecord is one decoded system_security row plus the "stored"
// predicate.
type systemSecurityRecord struct {
	present bool
	payload systemSecurityPayload
}

// decodeSystemSecurityRecord classifies a raw SystemSetting.value for
// key=system_security.
func decodeSystemSecurityRecord(raw json.RawMessage) (systemSecurityRecord, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return systemSecurityRecord{}, nil
	}
	switch trimmed[0] {
	case '{':
		var payload systemSecurityPayload
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return systemSecurityRecord{}, err
		}
		return systemSecurityRecord{present: true, payload: payload}, nil
	case '[':
		return systemSecurityRecord{present: true}, nil
	default:
		return systemSecurityRecord{}, nil
	}
}

// resolveConfigured mirrors SystemSecuritySettingsService.resolveConfigured:
// only a stored JSON boolean is a decision, everything else is "unset".
func (r systemSecurityRecord) resolveConfigured() (bool, bool) {
	trimmed := bytes.TrimSpace(r.payload.SecretEncryptionEnabled)
	switch string(trimmed) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// ---- small JSON helpers ----

// jsonPresent reports whether a decoded field holds any JSON at all. An absent
// key leaves json.RawMessage nil; the literal null is present as "null".
func jsonPresent(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// jsonIsNull reports whether the field holds the JSON literal null.
func jsonIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// jsonIsString reports whether the field holds a JSON string.
func jsonIsString(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"'
}

// jsonIsNumber reports whether the field holds a JSON number. JSON numbers never
// start with '+' and never carry a base prefix.
func jsonIsNumber(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')
}

// jsonString decodes a JSON string field.
func jsonString(raw json.RawMessage) (string, bool) {
	if !jsonIsString(raw) {
		return "", false
	}
	var text string
	if err := json.Unmarshal(bytes.TrimSpace(raw), &text); err != nil {
		return "", false
	}
	return text, true
}

// jsonTruthyJSON reproduces JavaScript truthiness for a decoded JSON value:
// null, false, 0 (and -0) and the empty string are falsy; every object, array
// and non-empty string is truthy.
func jsonTruthyJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	switch trimmed[0] {
	case 'n': // null
		return false
	case 'f': // false
		return false
	case 't': // true
		return true
	case '"':
		text, ok := jsonString(trimmed)
		return ok && text != ""
	case '{', '[':
		return true
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			// A range error still yields the parsed magnitude (0 for an
			// underflow, ±Inf for an overflow) — neither is falsy-zero except the
			// underflow case, which the returned 0 already covers.
			return !(value == 0)
		}
		return value != 0
	}
}

// jsTrimSpace trims exactly the code points JavaScript's String.prototype.trim
// and the \s character class cover, which is a superset of Go's unicode.IsSpace
// and excludes U+0085 and U+200B.
func jsTrimSpace(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

// isJSWhitespace reports whether r is a JavaScript WhiteSpace or LineTerminator
// code point (ECMAScript \s).
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// isJSLineTerminator reports whether r ends a line for JavaScript's `.`
// metacharacter (which does not match these four code points).
func isJSLineTerminator(r rune) bool {
	switch r {
	case '\n', '\r', '\u2028', '\u2029':
		return true
	default:
		return false
	}
}

// containsJSLineTerminator reports whether the text holds a JavaScript line
// terminator.
func containsJSLineTerminator(text string) bool {
	for _, r := range text {
		if isJSLineTerminator(r) {
			return true
		}
	}
	return false
}

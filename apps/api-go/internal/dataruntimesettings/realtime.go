package dataruntimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strings"
)

// storedRealtimeSettings is the read model of the realtime_signals_settings JSON
// column. Every member stays raw so a wrong stored type degrades to the
// environment default instead of failing the read, which is exactly what the
// NestJS `unknown`-typed interface does.
type storedRealtimeSettings struct {
	Enabled                         json.RawMessage `json:"enabled,omitempty"`
	RequestTimeoutMs                json.RawMessage `json:"requestTimeoutMs,omitempty"`
	MaxRetries                      json.RawMessage `json:"maxRetries,omitempty"`
	OpenskyEnabled                  json.RawMessage `json:"openskyEnabled,omitempty"`
	AdsbEnabled                     json.RawMessage `json:"adsbEnabled,omitempty"`
	OpenskyIntervalSec              json.RawMessage `json:"openskyIntervalSec,omitempty"`
	AdsbIntervalSec                 json.RawMessage `json:"adsbIntervalSec,omitempty"`
	OpenskyDailyCreditBudget        json.RawMessage `json:"openskyDailyCreditBudget,omitempty"`
	OpenskyDayIntervalSec           json.RawMessage `json:"openskyDayIntervalSec,omitempty"`
	OpenskyNightIntervalSec         json.RawMessage `json:"openskyNightIntervalSec,omitempty"`
	OpenskyDayStartHourHKT          json.RawMessage `json:"openskyDayStartHourHkt,omitempty"`
	OpenskyNightStartHourHKT        json.RawMessage `json:"openskyNightStartHourHkt,omitempty"`
	OpenskyWarningRemainingPct      json.RawMessage `json:"openskyWarningRemainingPct,omitempty"`
	OpenskyCriticalRemainingPct     json.RawMessage `json:"openskyCriticalRemainingPct,omitempty"`
	AisEnabled                      json.RawMessage `json:"aisEnabled,omitempty"`
	AisIntervalSec                  json.RawMessage `json:"aisIntervalSec,omitempty"`
	UnrestEnabled                   json.RawMessage `json:"unrestEnabled,omitempty"`
	UnrestIntervalSec               json.RawMessage `json:"unrestIntervalSec,omitempty"`
	OutagesEnabled                  json.RawMessage `json:"outagesEnabled,omitempty"`
	OutagesIntervalSec              json.RawMessage `json:"outagesIntervalSec,omitempty"`
	KeywordSpikeEnabled             json.RawMessage `json:"keywordSpikeEnabled,omitempty"`
	KeywordSpikeIntervalSec         json.RawMessage `json:"keywordSpikeIntervalSec,omitempty"`
	PizzintEnabled                  json.RawMessage `json:"pizzintEnabled,omitempty"`
	PizzintIntervalSec              json.RawMessage `json:"pizzintIntervalSec,omitempty"`
	GdeltTensionEnabled             json.RawMessage `json:"gdeltTensionEnabled,omitempty"`
	GdeltTensionIntervalSec         json.RawMessage `json:"gdeltTensionIntervalSec,omitempty"`
	PolymarketLeadsEnabled          json.RawMessage `json:"polymarketLeadsEnabled,omitempty"`
	PolymarketLeadsIntervalSec      json.RawMessage `json:"polymarketLeadsIntervalSec,omitempty"`
	KeywordSpikeMinCount            json.RawMessage `json:"keywordSpikeMinCount,omitempty"`
	KeywordSpikeMultiplier          json.RawMessage `json:"keywordSpikeMultiplier,omitempty"`
	PredictionShiftThreshold        json.RawMessage `json:"predictionShiftThreshold,omitempty"`
	PredictionNewsActivityThreshold json.RawMessage `json:"predictionNewsActivityThreshold,omitempty"`
	OpenskyBaseURL                  json.RawMessage `json:"openskyBaseUrl,omitempty"`
	AdsbBaseURL                     json.RawMessage `json:"adsbBaseUrl,omitempty"`
	OpenskyTokenURL                 json.RawMessage `json:"openskyTokenUrl,omitempty"`
	AisRelayBaseURL                 json.RawMessage `json:"aisRelayBaseUrl,omitempty"`
	OpenskyClientID                 json.RawMessage `json:"openskyClientId,omitempty"`
	OpenskyClientSecret             json.RawMessage `json:"openskyClientSecret,omitempty"`
	AisRelaySharedSecret            json.RawMessage `json:"aisRelaySharedSecret,omitempty"`
	RelayBaseURL                    json.RawMessage `json:"relayBaseUrl,omitempty"`
	RelaySharedSecret               json.RawMessage `json:"relaySharedSecret,omitempty"`
	AcledAccessToken                json.RawMessage `json:"acledAccessToken,omitempty"`
	AcledOauthUsername              json.RawMessage `json:"acledOauthUsername,omitempty"`
	AcledOauthPassword              json.RawMessage `json:"acledOauthPassword,omitempty"`
	AcledOauthClientID              json.RawMessage `json:"acledOauthClientId,omitempty"`
	CloudflareAPIToken              json.RawMessage `json:"cloudflareApiToken,omitempty"`
	WingbitsAPIKey                  json.RawMessage `json:"wingbitsApiKey,omitempty"`
	PolymarketProxyURL              json.RawMessage `json:"polymarketProxyUrl,omitempty"`
}

// parseStoredRealtimeSettings mirrors the NestJS
// `raw && typeof raw === "object" ? raw : null` check: JSON null and primitives
// are "no settings"; an object or an array is a settings document (an array
// simply yields undefined members), which is why an array still reports
// source=db.
func parseStoredRealtimeSettings(raw json.RawMessage) *storedRealtimeSettings {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] != '{' && trimmed[0] != '[' {
		return nil
	}
	settings := storedRealtimeSettings{}
	if trimmed[0] == '{' {
		if err := json.Unmarshal(trimmed, &settings); err != nil {
			return &storedRealtimeSettings{}
		}
	}
	return &settings
}

// writtenRealtimeSettings is the write model. Member order matches the object
// literal in RealtimeSignalsSettingsService.updateSettings, and
// relayBaseUrl/relaySharedSecret are absent on purpose: NestJS sets them to
// `undefined`, which JSON.stringify drops. acledAccessToken is always written as
// the JSON literal null so a historical token can never be resurrected as an
// input field.
//
// String members are *string so an unset value serializes as JSON null rather
// than "" (the NestJS resolvers return null, never an empty string).
type writtenRealtimeSettings struct {
	Enabled                         bool            `json:"enabled"`
	RequestTimeoutMs                int             `json:"requestTimeoutMs"`
	MaxRetries                      int             `json:"maxRetries"`
	OpenskyEnabled                  bool            `json:"openskyEnabled"`
	OpenskyIntervalSec              int             `json:"openskyIntervalSec"`
	OpenskyDailyCreditBudget        int             `json:"openskyDailyCreditBudget"`
	OpenskyDayIntervalSec           int             `json:"openskyDayIntervalSec"`
	OpenskyNightIntervalSec         int             `json:"openskyNightIntervalSec"`
	OpenskyDayStartHourHKT          int             `json:"openskyDayStartHourHkt"`
	OpenskyNightStartHourHKT        int             `json:"openskyNightStartHourHkt"`
	OpenskyWarningRemainingPct      int             `json:"openskyWarningRemainingPct"`
	OpenskyCriticalRemainingPct     int             `json:"openskyCriticalRemainingPct"`
	AisEnabled                      bool            `json:"aisEnabled"`
	AisIntervalSec                  int             `json:"aisIntervalSec"`
	UnrestEnabled                   bool            `json:"unrestEnabled"`
	UnrestIntervalSec               int             `json:"unrestIntervalSec"`
	OutagesEnabled                  bool            `json:"outagesEnabled"`
	OutagesIntervalSec              int             `json:"outagesIntervalSec"`
	KeywordSpikeEnabled             bool            `json:"keywordSpikeEnabled"`
	KeywordSpikeIntervalSec         int             `json:"keywordSpikeIntervalSec"`
	PizzintEnabled                  bool            `json:"pizzintEnabled"`
	PizzintIntervalSec              int             `json:"pizzintIntervalSec"`
	GdeltTensionEnabled             bool            `json:"gdeltTensionEnabled"`
	GdeltTensionIntervalSec         int             `json:"gdeltTensionIntervalSec"`
	PolymarketLeadsEnabled          bool            `json:"polymarketLeadsEnabled"`
	PolymarketLeadsIntervalSec      int             `json:"polymarketLeadsIntervalSec"`
	KeywordSpikeMinCount            int             `json:"keywordSpikeMinCount"`
	KeywordSpikeMultiplier          float64         `json:"keywordSpikeMultiplier"`
	PredictionShiftThreshold        float64         `json:"predictionShiftThreshold"`
	PredictionNewsActivityThreshold int             `json:"predictionNewsActivityThreshold"`
	OpenskyBaseURL                  *string         `json:"openskyBaseUrl"`
	OpenskyTokenURL                 *string         `json:"openskyTokenUrl"`
	AisRelayBaseURL                 *string         `json:"aisRelayBaseUrl"`
	OpenskyClientID                 *string         `json:"openskyClientId"`
	OpenskyClientSecret             json.RawMessage `json:"openskyClientSecret"`
	AisRelaySharedSecret            json.RawMessage `json:"aisRelaySharedSecret"`
	AcledAccessToken                json.RawMessage `json:"acledAccessToken"`
	AcledOauthUsername              *string         `json:"acledOauthUsername"`
	AcledOauthPassword              json.RawMessage `json:"acledOauthPassword"`
	AcledOauthClientID              *string         `json:"acledOauthClientId"`
	CloudflareAPIToken              json.RawMessage `json:"cloudflareApiToken"`
	WingbitsAPIKey                  json.RawMessage `json:"wingbitsApiKey"`
	PolymarketProxyURL              *string         `json:"polymarketProxyUrl"`
}

// jsonNullValue is the JSON literal null used for cleared secrets.
var jsonNullValue = json.RawMessage("null")

// ---- coercion helpers ----

// clampInt clamps an already-finite integer into [min, max].
func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// asBooleanOption mirrors `asBoolean(input.x, fallback)`: only a real boolean is
// accepted, so a missing member and an explicit JSON null both fall back.
func asBooleanOption(value optionalBool, fallback bool) bool {
	if value.state == presenceValue {
		return value.value
	}
	return fallback
}

// asBoundedIntOption mirrors `asBoundedInt(input.x, fallback, min, max)`.
//
// An explicit null becomes `Math.trunc(Number(null)) === 0` and is therefore
// clamped to the lower bound, which is deliberately NOT the same as omitting the
// field. A non-finite parsed value falls back.
func asBoundedIntOption(value optionalNumber, fallback, min, max int) int {
	switch value.state {
	case presenceMissing:
		return fallback
	case presenceNull:
		return clampInt(0, min, max)
	default:
		return clampToInt(value.value, fallback, min, max)
	}
}

// asBoundedNumberOption mirrors `asBoundedNumber(input.x, fallback, min, max)`.
func asBoundedNumberOption(value optionalNumber, fallback, min, max float64) float64 {
	switch value.state {
	case presenceMissing:
		return fallback
	case presenceNull:
		return clampFloat(0, min, max)
	default:
		return clampToFloat(value.value, fallback, min, max)
	}
}

// asBoundedIntRaw mirrors `asBoundedInt(storedValue, fallback, min, max)` for an
// arbitrary stored JSON member, applying JavaScript's Number() coercion.
func asBoundedIntRaw(raw json.RawMessage, fallback, min, max int) int {
	value, present := jsNumberFromJSON(raw)
	if !present {
		return fallback
	}
	return clampToInt(value, fallback, min, max)
}

// asBoundedIntRawOptional mirrors `asBoundedInt(storedValue, envDefault, ...)`
// where the stored member itself is absent: the environment default is used and
// is NOT re-clamped, exactly like NestJS (the env value already passed the zod
// schema constraints).
func asBoundedIntRawOptional(raw json.RawMessage, fallback, min, max int) int {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fallback
	}
	return asBoundedIntRaw(raw, fallback, min, max)
}

// asBoundedNumberRawOptional mirrors `asBoundedNumber(storedValue, envDefault, ...)`.
func asBoundedNumberRawOptional(raw json.RawMessage, fallback, min, max float64) float64 {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fallback
	}
	value, present := jsNumberFromJSON(raw)
	if !present {
		return fallback
	}
	return clampToFloat(value, fallback, min, max)
}

// clampToInt applies Math.trunc then the clamp, falling back for non-finite
// values.
func clampToInt(value float64, fallback, min, max int) int {
	parsed := math.Trunc(value)
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	if parsed < float64(min) {
		return min
	}
	if parsed > float64(max) {
		return max
	}
	return int(parsed)
}

// clampToFloat applies the clamp, falling back for non-finite values.
func clampToFloat(value, fallback, min, max float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	return clampFloat(value, min, max)
}

// clampFloat clamps an already-finite float into [min, max].
func clampFloat(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// asBooleanRaw mirrors `asBoolean(storedValue, envDefault)`.
func asBooleanRaw(raw json.RawMessage, fallback bool) bool {
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("true")) {
		return true
	}
	if bytes.Equal(trimmed, []byte("false")) {
		return false
	}
	return fallback
}

// rawCoalesce mirrors the JavaScript `a ?? b` operator on raw stored members: a
// present non-null value wins (including false, 0 and ""), while a missing member
// and JSON null both fall through to b. Using a "key present" test instead would
// change the OpenSky precedence, because
// `stored.openskyBaseUrl ?? stored.adsbBaseUrl` coalesces the RAW members and
// only normalizes the winner.
func rawCoalesce(a, b json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(a)
	if len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
		return a
	}
	return b
}

// normalizeStringRaw decodes a JSON string member and trims it, returning "" for
// a non-string, an empty string or whitespace. "" is the Go representation of the
// NestJS `undefined`.
func normalizeStringRaw(raw json.RawMessage) string {
	text, ok := decodeJSONString(raw)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// normalizeURLRaw trims a JSON string member and removes every trailing slash,
// mirroring the NestJS `normalizeUrl` helper (which never validates).
func normalizeURLRaw(raw json.RawMessage) string {
	return strings.TrimRight(normalizeStringRaw(raw), "/")
}

// firstNonEmpty returns the first non-empty candidate.
func firstNonEmpty(candidates ...string) string {
	for _, candidate := range candidates {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

// stringPtrOrNil converts "" into a JSON null pointer.
func stringPtrOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// ---- secret resolution ----

// resolveStoredSecret mirrors `resolveStoredSecret(raw, keyName)`:
//   - absent -> undefined;
//   - a plain string -> the trimmed value ("" when empty/whitespace);
//   - a v1 envelope -> the decrypted value, or undefined when no valid key is
//     configured or decryption fails (a rotated key must degrade to the
//     environment fallback, never fail the read);
//   - anything else -> undefined.
func (s *Service) resolveStoredSecret(raw json.RawMessage, keyName string) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		return normalizeStringRaw(trimmed)
	}
	var envelope encryptedStringValueV1
	if err := json.Unmarshal(trimmed, &envelope); err != nil || !envelope.valid() {
		return ""
	}
	key := s.settingsKey()
	if key == nil {
		logBackground("missing SYSTEM_SETTINGS_ENCRYPTION_KEY for "+keyName, nil)
		return ""
	}
	plain, err := decryptStringValueV1(envelope, key)
	if err != nil {
		logBackground("failed to decrypt "+keyName, err)
		return ""
	}
	return strings.TrimSpace(plain)
}

// secretPresence mirrors `resolveSecretPresence(stored, effective)`.
func secretPresence(stored, effective string) (bool, SecretSource) {
	if stored != "" {
		return true, SecretSourceStored
	}
	if effective != "" {
		return true, SecretSourceEnv
	}
	return false, SecretSourceNone
}

// ---- effective configuration ----

// effectiveRealtimeSettings is the resolved view of the settings row plus the
// environment defaults. Every string member uses "" for the NestJS `undefined`;
// the presence/source pair is derived at the response boundary.
type effectiveRealtimeSettings struct {
	Enabled                         bool
	RequestTimeoutMs                int
	MaxRetries                      int
	OpenskyEnabled                  bool
	OpenskyIntervalSec              int
	OpenskyDailyCreditBudget        int
	OpenskyDayIntervalSec           int
	OpenskyNightIntervalSec         int
	OpenskyDayStartHourHKT          int
	OpenskyNightStartHourHKT        int
	OpenskyWarningRemainingPct      int
	OpenskyCriticalRemainingPct     int
	AisEnabled                      bool
	AisIntervalSec                  int
	UnrestEnabled                   bool
	UnrestIntervalSec               int
	OutagesEnabled                  bool
	OutagesIntervalSec              int
	KeywordSpikeEnabled             bool
	KeywordSpikeIntervalSec         int
	PizzintEnabled                  bool
	PizzintIntervalSec              int
	GdeltTensionEnabled             bool
	GdeltTensionIntervalSec         int
	PolymarketLeadsEnabled          bool
	PolymarketLeadsIntervalSec      int
	KeywordSpikeMinCount            int
	KeywordSpikeMultiplier          float64
	PredictionShiftThreshold        float64
	PredictionNewsActivityThreshold int
	OpenskyBaseURL                  string
	OpenskyTokenURL                 string
	AisRelayBaseURL                 string
	AisRelaySharedSecret            string
	OpenskyClientID                 string
	OpenskyClientIDPresent          bool
	OpenskyClientIDSource           SecretSource
	OpenskyClientSecret             string
	OpenskyClientSecretPresent      bool
	OpenskyClientSecretSource       SecretSource
	AisRelaySecretPresent           bool
	AisRelaySecretSource            SecretSource
	AcledOauthUsername              string
	AcledOauthUsernamePresent       bool
	AcledOauthUsernameSource        SecretSource
	AcledOauthPassword              string
	AcledOauthPasswordPresent       bool
	AcledOauthPasswordSource        SecretSource
	AcledOauthClientID              string
	AcledOauthClientIDPresent       bool
	AcledOauthClientIDSource        SecretSource
	CloudflareAPIToken              string
	CloudflareAPITokenPresent       bool
	CloudflareAPITokenSource        SecretSource
	WingbitsAPIKey                  string
	WingbitsAPIKeyPresent           bool
	WingbitsAPIKeySource            SecretSource
	PolymarketProxyURL              string
}

// defaultOpenskyBaseURL and defaultOpenskyTokenURL mirror the schema defaults.
// They are unreachable through the NestJS expression because apiEnvSchema
// already supplies the environment value, but keeping them documents the
// contract.
const (
	defaultOpenskyBaseURL  = "https://opensky-network.org/api"
	defaultOpenskyTokenURL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
	defaultAcledClientID   = "acled"
)

// resolveEffectiveSettings mirrors RealtimeSignalsSettingsService.resolveEffectiveConfig
// and validates the OpenSky budget relations before returning.
func (s *Service) resolveEffectiveSettings(stored *storedRealtimeSettings) (*effectiveRealtimeSettings, error) {
	cfg := s.cfg

	// Stored members are read as raw JSON so a wrong type degrades to the
	// environment default, exactly like the NestJS unknown-typed interface.
	var (
		enabledRaw         json.RawMessage
		openskyEnabledRaw  json.RawMessage
		openskyIntervalRaw json.RawMessage
		openskyBaseURLRaw  json.RawMessage
		aisRelayBaseURLRaw json.RawMessage
	)
	if stored != nil {
		enabledRaw = stored.Enabled
		// `stored?.openskyEnabled ?? stored?.adsbEnabled`: the RAW members are
		// coalesced first, then coerced. The environment fallback can never
		// reach REALTIME_SIGNALS_ADSB_ENABLED because apiEnvSchema defaults
		// REALTIME_SIGNALS_OPENSKY_ENABLED, and this port preserves that.
		openskyEnabledRaw = rawCoalesce(stored.OpenskyEnabled, stored.AdsbEnabled)
		openskyIntervalRaw = rawCoalesce(stored.OpenskyIntervalSec, stored.AdsbIntervalSec)
		openskyBaseURLRaw = rawCoalesce(stored.OpenskyBaseURL, stored.AdsbBaseURL)
		aisRelayBaseURLRaw = stored.AisRelayBaseURL
	}

	storedOpenskyClientID := ""
	storedOpenskyClientSecret := ""
	storedAisRelaySecret := ""
	storedLegacyRelaySecret := ""
	storedAcledUsername := ""
	storedAcledPassword := ""
	storedAcledClientID := ""
	storedCloudflare := ""
	storedWingbits := ""
	if stored != nil {
		storedOpenskyClientID = normalizeStringRaw(stored.OpenskyClientID)
		storedOpenskyClientSecret = s.resolveStoredSecret(stored.OpenskyClientSecret, "opensky client secret")
		storedAisRelaySecret = s.resolveStoredSecret(stored.AisRelaySharedSecret, "ais relay shared secret")
		storedLegacyRelaySecret = s.resolveStoredSecret(stored.RelaySharedSecret, "legacy relay shared secret")
		storedAcledUsername = normalizeStringRaw(stored.AcledOauthUsername)
		storedAcledPassword = s.resolveStoredSecret(stored.AcledOauthPassword, "acled oauth password")
		storedAcledClientID = normalizeStringRaw(stored.AcledOauthClientID)
		storedCloudflare = s.resolveStoredSecret(stored.CloudflareAPIToken, "cloudflare api token")
		storedWingbits = s.resolveStoredSecret(stored.WingbitsAPIKey, "wingbits api key")
	}

	// `resolveStoredSecret(stored?.aisRelaySharedSecret ?? stored?.relaySharedSecret)`
	// — the presence path coalesces the RAW members, which is deliberately
	// different from the effective path below (that one resolves each member and
	// then coalesces). A non-decryptable canonical secret therefore reports
	// env/none here while the effective value may still come from the legacy
	// alias, exactly as in NestJS.
	presenceAisRelayRaw := storedAisRelaySecret
	if stored != nil {
		presenceAisRelayRaw = s.resolveStoredSecret(
			rawCoalesce(stored.AisRelaySharedSecret, stored.RelaySharedSecret),
			"ais relay shared secret",
		)
	}

	effective := &effectiveRealtimeSettings{
		Enabled:                         asBooleanRaw(enabledRaw, cfg.RealtimeEnabled),
		RequestTimeoutMs:                asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.RequestTimeoutMs }), cfg.RealtimeRequestTimeoutMs, 1_000, 120_000),
		MaxRetries:                      asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.MaxRetries }), cfg.RealtimeMaxRetries, 0, 6),
		OpenskyEnabled:                  asBooleanRaw(openskyEnabledRaw, cfg.RealtimeOpenskyEnabled),
		OpenskyIntervalSec:              asBoundedIntRawOptional(openskyIntervalRaw, cfg.RealtimeOpenskyIntervalSec, 30, 86_400),
		OpenskyDailyCreditBudget:        asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyDailyCreditBudget }), cfg.RealtimeOpenskyDailyCreditBudget, 1, 100_000),
		OpenskyDayIntervalSec:           asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyDayIntervalSec }), cfg.RealtimeOpenskyDayIntervalSec, 30, 86_400),
		OpenskyNightIntervalSec:         asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyNightIntervalSec }), cfg.RealtimeOpenskyNightIntervalSec, 30, 86_400),
		OpenskyDayStartHourHKT:          asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyDayStartHourHKT }), cfg.RealtimeOpenskyDayStartHourHKT, 0, 23),
		OpenskyNightStartHourHKT:        asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyNightStartHourHKT }), cfg.RealtimeOpenskyNightStartHourHKT, 0, 23),
		OpenskyWarningRemainingPct:      asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyWarningRemainingPct }), cfg.RealtimeOpenskyWarningRemaining, 1, 99),
		OpenskyCriticalRemainingPct:     asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyCriticalRemainingPct }), cfg.RealtimeOpenskyCriticalRemaining, 0, 98),
		AisEnabled:                      asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AisEnabled }), cfg.RealtimeAisEnabled),
		AisIntervalSec:                  asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AisIntervalSec }), cfg.RealtimeAisIntervalSec, 30, 86_400),
		UnrestEnabled:                   asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.UnrestEnabled }), cfg.RealtimeUnrestEnabled),
		UnrestIntervalSec:               asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.UnrestIntervalSec }), cfg.RealtimeUnrestIntervalSec, 30, 86_400),
		OutagesEnabled:                  asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OutagesEnabled }), cfg.RealtimeOutagesEnabled),
		OutagesIntervalSec:              asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OutagesIntervalSec }), cfg.RealtimeOutagesIntervalSec, 30, 86_400),
		KeywordSpikeEnabled:             asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.KeywordSpikeEnabled }), cfg.RealtimeKeywordSpikeEnabled),
		KeywordSpikeIntervalSec:         asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.KeywordSpikeIntervalSec }), cfg.RealtimeKeywordSpikeIntervalSec, 30, 86_400),
		PizzintEnabled:                  asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PizzintEnabled }), cfg.RealtimePizzintEnabled),
		PizzintIntervalSec:              asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PizzintIntervalSec }), cfg.RealtimePizzintIntervalSec, 30, 86_400),
		GdeltTensionEnabled:             asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.GdeltTensionEnabled }), cfg.RealtimeGdeltTensionEnabled),
		GdeltTensionIntervalSec:         asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.GdeltTensionIntervalSec }), cfg.RealtimeGdeltTensionIntervalSec, 30, 86_400),
		PolymarketLeadsEnabled:          asBooleanRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PolymarketLeadsEnabled }), cfg.RealtimePolymarketLeadsEnabled),
		PolymarketLeadsIntervalSec:      asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PolymarketLeadsIntervalSec }), cfg.RealtimePolymarketIntervalSec, 30, 86_400),
		KeywordSpikeMinCount:            asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.KeywordSpikeMinCount }), cfg.RealtimeKeywordSpikeMinCount, 1, 500),
		KeywordSpikeMultiplier:          asBoundedNumberRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.KeywordSpikeMultiplier }), cfg.RealtimeKeywordSpikeMultiplier, 1, 100),
		PredictionShiftThreshold:        asBoundedNumberRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PredictionShiftThreshold }), cfg.RealtimePredictionShiftThreshold, 1, 100),
		PredictionNewsActivityThreshold: asBoundedIntRawOptional(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PredictionNewsThreshold }), cfg.RealtimePredictionNewsThreshold, 0, 1_000),
	}

	// URLs. `normalizeUrl(stored.x ?? stored.adsbX) ?? normalizeUrl(env.x) ?? default`
	effective.OpenskyBaseURL = firstNonEmpty(
		normalizeURLRaw(openskyBaseURLRaw),
		normalizeURLRaw(jsonStringValue(cfg.RealtimeOpenskyBaseURL)),
		defaultOpenskyBaseURL,
	)
	effective.OpenskyTokenURL = firstNonEmpty(
		normalizeURLRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyTokenURL })),
		normalizeURLRaw(jsonStringValue(cfg.RealtimeOpenskyTokenURL)),
		defaultOpenskyTokenURL,
	)
	// `normalizeUrl(stored.aisRelayBaseUrl) ?? normalizeUrl(stored.relayBaseUrl) ?? normalizeUrl(env.ais.baseUrl)`
	effective.AisRelayBaseURL = firstNonEmpty(
		normalizeURLRaw(aisRelayBaseURLRaw),
		normalizeURLRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.RelayBaseURL })),
		normalizeURLRaw(jsonStringValue(cfg.RealtimeAisBaseURL)),
	)
	effective.PolymarketProxyURL = firstNonEmpty(
		normalizeURLRaw(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PolymarketProxyURL })),
		normalizeURLRaw(jsonStringValue(cfg.RealtimePolymarketProxyURL)),
	)

	// Credentials: stored, then the environment, then the ACLED client-id default.
	effective.OpenskyClientID = firstNonEmpty(storedOpenskyClientID, cfg.RealtimeOpenskyClientID)
	effective.OpenskyClientSecret = firstNonEmpty(storedOpenskyClientSecret, cfg.RealtimeOpenskyClientSecret)
	effective.AisRelaySharedSecret = firstNonEmpty(storedAisRelaySecret, storedLegacyRelaySecret, cfg.RealtimeAisSharedSecret)
	effective.AcledOauthUsername = firstNonEmpty(storedAcledUsername, cfg.RealtimeAcledOauthUsername)
	effective.AcledOauthPassword = firstNonEmpty(storedAcledPassword, cfg.RealtimeAcledOauthPassword)
	effective.AcledOauthClientID = firstNonEmpty(storedAcledClientID, cfg.RealtimeAcledOauthClientID, defaultAcledClientID)
	effective.CloudflareAPIToken = firstNonEmpty(storedCloudflare, cfg.RealtimeCloudflareAPIToken)
	effective.WingbitsAPIKey = firstNonEmpty(storedWingbits, cfg.RealtimeWingbitsAPIKey)

	// Presence sources mirror resolveSecretPresence(stored, effective).
	effective.OpenskyClientIDPresent, effective.OpenskyClientIDSource = secretPresence(storedOpenskyClientID, effective.OpenskyClientID)
	effective.OpenskyClientSecretPresent, effective.OpenskyClientSecretSource = secretPresence(storedOpenskyClientSecret, effective.OpenskyClientSecret)
	effective.AisRelaySecretPresent, effective.AisRelaySecretSource = secretPresence(presenceAisRelayRaw, effective.AisRelaySharedSecret)
	effective.AcledOauthUsernamePresent, effective.AcledOauthUsernameSource = secretPresence(storedAcledUsername, effective.AcledOauthUsername)
	effective.AcledOauthPasswordPresent, effective.AcledOauthPasswordSource = secretPresence(storedAcledPassword, effective.AcledOauthPassword)
	effective.AcledOauthClientIDPresent, effective.AcledOauthClientIDSource = secretPresence(storedAcledClientID, effective.AcledOauthClientID)
	effective.CloudflareAPITokenPresent, effective.CloudflareAPITokenSource = secretPresence(storedCloudflare, effective.CloudflareAPIToken)
	effective.WingbitsAPIKeyPresent, effective.WingbitsAPIKeySource = secretPresence(storedWingbits, effective.WingbitsAPIKey)

	if err := validateOpenskyBudgetSettings(effective); err != nil {
		return nil, err
	}
	return effective, nil
}

// rawMember reads one member of a possibly-nil stored settings document.
func rawMember(stored *storedRealtimeSettings, pick func(*storedRealtimeSettings) json.RawMessage) json.RawMessage {
	if stored == nil {
		return nil
	}
	return pick(stored)
}

// jsonStringValue renders a Go string as a JSON string token for the raw-value
// helpers, or nil when the environment value is absent.
func jsonStringValue(value string) json.RawMessage {
	if value == "" {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

// validateOpenskyBudgetSettings mirrors validateOpenskyBudgetSettings, including
// the message wording and the evaluation order.
func validateOpenskyBudgetSettings(input *effectiveRealtimeSettings) error {
	if input.OpenskyDailyCreditBudget <= 0 {
		return &httpError{status: http.StatusBadRequest, message: "openskyDailyCreditBudget must be greater than 0"}
	}
	if input.OpenskyDayStartHourHKT >= input.OpenskyNightStartHourHKT {
		return &httpError{status: http.StatusBadRequest, message: "openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt"}
	}
	if input.OpenskyCriticalRemainingPct >= input.OpenskyWarningRemainingPct {
		return &httpError{status: http.StatusBadRequest, message: "openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct"}
	}
	if input.OpenskyDayIntervalSec > input.OpenskyNightIntervalSec {
		return &httpError{status: http.StatusBadRequest, message: "openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec"}
	}
	return nil
}

// ---- public response ----

// realtimePublicSettings is the GET/PUT/DELETE response body. Member order
// matches RealtimeSignalsSettingsPublic. The omitempty members are exactly the
// NestJS `string | undefined` fields: an unset URL, client id or username is
// omitted rather than sent as null. The ACLED access-token fields are always
// omitted because the API stays disabled.
type realtimePublicSettings struct {
	Source                          SettingSource          `json:"source"`
	Enabled                         bool                   `json:"enabled"`
	RequestTimeoutMs                int                    `json:"requestTimeoutMs"`
	MaxRetries                      int                    `json:"maxRetries"`
	AcledAPIEnabled                 bool                   `json:"acledApiEnabled"`
	AcledAPIDisabledReason          string                 `json:"acledApiDisabledReason"`
	OpenskyEnabled                  bool                   `json:"openskyEnabled"`
	OpenskyIntervalSec              int                    `json:"openskyIntervalSec"`
	OpenskyDailyCreditBudget        int                    `json:"openskyDailyCreditBudget"`
	OpenskyDayIntervalSec           int                    `json:"openskyDayIntervalSec"`
	OpenskyNightIntervalSec         int                    `json:"openskyNightIntervalSec"`
	OpenskyDayStartHourHKT          int                    `json:"openskyDayStartHourHkt"`
	OpenskyNightStartHourHKT        int                    `json:"openskyNightStartHourHkt"`
	OpenskyWarningRemainingPct      int                    `json:"openskyWarningRemainingPct"`
	OpenskyCriticalRemainingPct     int                    `json:"openskyCriticalRemainingPct"`
	AisEnabled                      bool                   `json:"aisEnabled"`
	AisIntervalSec                  int                    `json:"aisIntervalSec"`
	UnrestEnabled                   bool                   `json:"unrestEnabled"`
	UnrestIntervalSec               int                    `json:"unrestIntervalSec"`
	OutagesEnabled                  bool                   `json:"outagesEnabled"`
	OutagesIntervalSec              int                    `json:"outagesIntervalSec"`
	KeywordSpikeEnabled             bool                   `json:"keywordSpikeEnabled"`
	KeywordSpikeIntervalSec         int                    `json:"keywordSpikeIntervalSec"`
	PizzintEnabled                  bool                   `json:"pizzintEnabled"`
	PizzintIntervalSec              int                    `json:"pizzintIntervalSec"`
	GdeltTensionEnabled             bool                   `json:"gdeltTensionEnabled"`
	GdeltTensionIntervalSec         int                    `json:"gdeltTensionIntervalSec"`
	PolymarketLeadsEnabled          bool                   `json:"polymarketLeadsEnabled"`
	PolymarketLeadsIntervalSec      int                    `json:"polymarketLeadsIntervalSec"`
	KeywordSpikeMinCount            int                    `json:"keywordSpikeMinCount"`
	KeywordSpikeMultiplier          float64                `json:"keywordSpikeMultiplier"`
	PredictionShiftThreshold        float64                `json:"predictionShiftThreshold"`
	PredictionNewsActivityThreshold int                    `json:"predictionNewsActivityThreshold"`
	OpenskyBaseURL                  string                 `json:"openskyBaseUrl,omitempty"`
	OpenskyTokenURL                 string                 `json:"openskyTokenUrl,omitempty"`
	AisRelayBaseURL                 string                 `json:"aisRelayBaseUrl,omitempty"`
	PolymarketProxyURL              string                 `json:"polymarketProxyUrl,omitempty"`
	OpenskyClientID                 string                 `json:"openskyClientId,omitempty"`
	OpenskyClientIDSource           SecretSource           `json:"openskyClientIdSource"`
	HasAisRelaySharedSecret         bool                   `json:"hasAisRelaySharedSecret"`
	AisRelaySharedSecretSource      SecretSource           `json:"aisRelaySharedSecretSource"`
	HasOpenskyClientSecret          bool                   `json:"hasOpenskyClientSecret"`
	OpenskyClientSecretSource       SecretSource           `json:"openskyClientSecretSource"`
	HasAcledAccessToken             bool                   `json:"hasAcledAccessToken"`
	AcledAccessTokenSource          SecretSource           `json:"acledAccessTokenSource"`
	AcledAccessTokenStatus          AcledAccessTokenStatus `json:"acledAccessTokenStatus"`
	AcledAccessTokenExpiresAt       string                 `json:"acledAccessTokenExpiresAt,omitempty"`
	AcledAccessTokenRefreshedAt     string                 `json:"acledAccessTokenRefreshedAt,omitempty"`
	AcledAccessTokenLastAttemptAt   string                 `json:"acledAccessTokenLastAttemptAt,omitempty"`
	AcledAccessTokenLastError       string                 `json:"acledAccessTokenLastError,omitempty"`
	AcledOauthUsername              string                 `json:"acledOauthUsername,omitempty"`
	AcledOauthUsernameSource        SecretSource           `json:"acledOauthUsernameSource"`
	HasAcledOauthPassword           bool                   `json:"hasAcledOauthPassword"`
	AcledOauthPasswordSource        SecretSource           `json:"acledOauthPasswordSource"`
	AcledOauthClientID              string                 `json:"acledOauthClientId"`
	AcledOauthClientIDSource        SecretSource           `json:"acledOauthClientIdSource"`
	HasCloudflareAPIToken           bool                   `json:"hasCloudflareApiToken"`
	CloudflareAPITokenSource        SecretSource           `json:"cloudflareApiTokenSource"`
	HasWingbitsAPIKey               bool                   `json:"hasWingbitsApiKey"`
	WingbitsAPIKeySource            SecretSource           `json:"wingbitsApiKeySource"`
}

// encodeJSON renders the public settings.
func (s realtimePublicSettings) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// getRealtimePublicSettings mirrors getPublicSettings. The ACLED policy is fixed
// at disabled, so no OAuth state is read, no token is reported as usable and no
// network request is made — even when the database still holds a historical
// token row.
func (s *Service) getRealtimePublicSettings(ctx context.Context) (*realtimePublicSettings, error) {
	stored, err := s.loadRealtimeSettings(ctx)
	if err != nil {
		return nil, err
	}
	effective, err := s.resolveEffectiveSettings(stored)
	if err != nil {
		return nil, err
	}
	return s.buildRealtimePublicSettings(stored, effective), nil
}

// buildRealtimePublicSettings assembles the response from an already resolved
// configuration.
func (s *Service) buildRealtimePublicSettings(stored *storedRealtimeSettings, effective *effectiveRealtimeSettings) *realtimePublicSettings {
	source := SettingSourceEnv
	if stored != nil {
		source = SettingSourceDB
	}
	return &realtimePublicSettings{
		Source:                      source,
		Enabled:                     effective.Enabled,
		RequestTimeoutMs:            effective.RequestTimeoutMs,
		MaxRetries:                  effective.MaxRetries,
		AcledAPIEnabled:             AcledAPIEnabled,
		AcledAPIDisabledReason:      AcledAPIDisabledReason,
		OpenskyEnabled:              effective.OpenskyEnabled,
		OpenskyIntervalSec:          effective.OpenskyIntervalSec,
		OpenskyDailyCreditBudget:    effective.OpenskyDailyCreditBudget,
		OpenskyDayIntervalSec:       effective.OpenskyDayIntervalSec,
		OpenskyNightIntervalSec:     effective.OpenskyNightIntervalSec,
		OpenskyDayStartHourHKT:      effective.OpenskyDayStartHourHKT,
		OpenskyNightStartHourHKT:    effective.OpenskyNightStartHourHKT,
		OpenskyWarningRemainingPct:  effective.OpenskyWarningRemainingPct,
		OpenskyCriticalRemainingPct: effective.OpenskyCriticalRemainingPct,
		AisEnabled:                  effective.AisEnabled,
		AisIntervalSec:              effective.AisIntervalSec,
		UnrestEnabled:               effective.UnrestEnabled,
		UnrestIntervalSec:           effective.UnrestIntervalSec,
		OutagesEnabled:              effective.OutagesEnabled,
		OutagesIntervalSec:          effective.OutagesIntervalSec,
		KeywordSpikeEnabled:         effective.KeywordSpikeEnabled,
		KeywordSpikeIntervalSec:     effective.KeywordSpikeIntervalSec,
		PizzintEnabled:              effective.PizzintEnabled,
		PizzintIntervalSec:          effective.PizzintIntervalSec,
		GdeltTensionEnabled:         effective.GdeltTensionEnabled,
		GdeltTensionIntervalSec:     effective.GdeltTensionIntervalSec,
		PolymarketLeadsEnabled:      effective.PolymarketLeadsEnabled,
		PolymarketLeadsIntervalSec:  effective.PolymarketLeadsIntervalSec,
		KeywordSpikeMinCount:        effective.KeywordSpikeMinCount,
		KeywordSpikeMultiplier:      effective.KeywordSpikeMultiplier,
		PredictionShiftThreshold:    effective.PredictionShiftThreshold,
		//nolint:staticcheck // preserved contract field name
		PredictionNewsActivityThreshold: effective.PredictionNewsActivityThreshold,
		OpenskyBaseURL:                  effective.OpenskyBaseURL,
		OpenskyTokenURL:                 effective.OpenskyTokenURL,
		AisRelayBaseURL:                 effective.AisRelayBaseURL,
		PolymarketProxyURL:              effective.PolymarketProxyURL,
		OpenskyClientID:                 effective.OpenskyClientID,
		OpenskyClientIDSource:           effective.OpenskyClientIDSource,
		HasAisRelaySharedSecret:         effective.AisRelaySecretPresent,
		AisRelaySharedSecretSource:      effective.AisRelaySecretSource,
		HasOpenskyClientSecret:          effective.OpenskyClientSecretPresent,
		OpenskyClientSecretSource:       effective.OpenskyClientSecretSource,
		// ACLED stays disabled: no usable access token is ever reported, so the
		// source is "none", the status is "missing" and the unreachable state
		// fields stay omitted.
		HasAcledAccessToken:      false,
		AcledAccessTokenSource:   SecretSourceNone,
		AcledAccessTokenStatus:   AcledTokenMissing,
		AcledOauthUsername:       effective.AcledOauthUsername,
		AcledOauthUsernameSource: effective.AcledOauthUsernameSource,
		HasAcledOauthPassword:    effective.AcledOauthPasswordPresent,
		AcledOauthPasswordSource: effective.AcledOauthPasswordSource,
		AcledOauthClientID:       effective.AcledOauthClientID,
		AcledOauthClientIDSource: effective.AcledOauthClientIDSource,
		HasCloudflareAPIToken:    effective.CloudflareAPITokenPresent,
		CloudflareAPITokenSource: effective.CloudflareAPITokenSource,
		HasWingbitsAPIKey:        effective.WingbitsAPIKeyPresent,
		WingbitsAPIKeySource:     effective.WingbitsAPIKeySource,
	}
}

// ---- load / update / reset ----

// loadRealtimeSettings mirrors loadStoredSettings: cache first (with the
// {exists,value} envelope), then MySQL, tolerating cache failures by falling back
// to the database.
func (s *Service) loadRealtimeSettings(ctx context.Context) (*storedRealtimeSettings, error) {
	if found, settings := s.loadRealtimeSettingsCache(ctx); found {
		return settings, nil
	}
	settings, err := s.loadRealtimeSettingsFromDB(ctx)
	if err != nil {
		return nil, err
	}
	s.writeRealtimeSettingsCache(ctx, settings)
	return settings, nil
}

// loadRealtimeSettingsFromDB reads the row straight from MySQL. This is the only
// merge base a write may use (the DS2 fix): the Redis envelope can be up to 30
// seconds stale, so merging from it would overwrite a field another instance just
// wrote.
func (s *Service) loadRealtimeSettingsFromDB(ctx context.Context) (*storedRealtimeSettings, error) {
	raw, found, err := s.loadSettingRaw(ctx, settingKeyRealtime)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return parseStoredRealtimeSettings(raw), nil
}

// invalidateRealtimeSettingsCache drops the settings cache entry. Failure is
// tolerated (NestJS logs and continues).
func (s *Service) invalidateRealtimeSettingsCache(ctx context.Context) {
	if err := s.cacheDel(ctx, cacheKeyRealtime); err != nil {
		logBackground("failed to invalidate realtime signals settings cache", err)
	}
}

// updateRealtimeSettings mirrors RealtimeSignalsSettingsService.updateSettings.
//
// The caller has already asserted the platform admin (DS1) and taken the global
// realtime lock (DS2). The merge base is the raw MySQL row handed in as
// `stored`, so this function never consults Redis or a public response.
func (s *Service) updateRealtimeSettings(ctx context.Context, orgID, actorID string, update *realtimeSettingsUpdate, stored *storedRealtimeSettings) (*realtimePublicSettings, error) {
	effective, err := s.resolveEffectiveSettings(stored)
	if err != nil {
		return nil, err
	}

	next, err := s.mergeRealtimeSettings(ctx, update, effective, stored)
	if err != nil {
		return nil, err
	}

	encoded, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	if err := s.upsertRealtime(ctx, encoded); err != nil {
		return nil, err
	}

	// ACLED stays disabled, so the "credentials changed -> clear the derived
	// auth state" branch is unreachable by construction and is not performed.

	metadata, err := json.Marshal(realtimeUpdateAuditMetadata{
		OK:            true,
		UpdatedFields: append([]string(nil), realtimeDTOFieldOrder...),
		SecretsUpdated: realtimeSecretsUpdated{
			AisRelaySharedSecret: provided(update.AisRelaySharedSecret.state) || provided(update.RelaySharedSecret.state),
			OpenskyClientSecret:  provided(update.OpenskyClientSecret.state),
			AcledOauthPassword:   provided(update.AcledOauthPassword.state),
			CloudflareAPIToken:   provided(update.CloudflareAPIToken.state),
			WingbitsAPIKey:       provided(update.WingbitsAPIKey.state),
		},
	})
	if err != nil {
		return nil, err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, "realtime_signals_update", metadata); err != nil {
		return nil, err
	}

	s.invalidateRealtimeSettingsCache(ctx)

	// The response is rebuilt exactly like NestJS: getPublicSettings re-reads the
	// (now invalidated) cache, so it observes the value just written.
	return s.getRealtimePublicSettings(ctx)
}

// mergeRealtimeSettings builds the next stored document from the locked database
// snapshot plus the validated partial update.
func (s *Service) mergeRealtimeSettings(ctx context.Context, update *realtimeSettingsUpdate, effective *effectiveRealtimeSettings, stored *storedRealtimeSettings) (*writtenRealtimeSettings, error) {
	// `input.openskyClientSecret` has no legacy alias and clears on null.
	openskyClientSecret, err := s.resolveNextSecretRaw(ctx, rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyClientSecret }), update.OpenskyClientSecret)
	if err != nil {
		return nil, err
	}
	// `input.aisRelaySharedSecret ?? input.relaySharedSecret`
	aisRelaySharedSecret, err := s.resolveNextSecretRaw(
		ctx,
		rawCoalesce(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AisRelaySharedSecret }),
			rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.RelaySharedSecret })),
		coalesceString(update.AisRelaySharedSecret, update.RelaySharedSecret),
	)
	if err != nil {
		return nil, err
	}
	acledPassword, err := s.resolveNextSecretRaw(ctx, rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AcledOauthPassword }), update.AcledOauthPassword)
	if err != nil {
		return nil, err
	}
	cloudflare, err := s.resolveNextSecretRaw(ctx, rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.CloudflareAPIToken }), update.CloudflareAPIToken)
	if err != nil {
		return nil, err
	}
	wingbits, err := s.resolveNextSecretRaw(ctx, rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.WingbitsAPIKey }), update.WingbitsAPIKey)
	if err != nil {
		return nil, err
	}

	// URLs. The OpenSky base URL is the one member whose stored canonical and
	// legacy names are coalesced raw before normalization.
	openskyBaseURL, err := s.resolveNextURL(
		rawCoalesce(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyBaseURL }),
			rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AdsbBaseURL })),
		coalesceString(update.OpenskyBaseURL, update.AdsbBaseURL),
		"openskyBaseUrl",
	)
	if err != nil {
		return nil, err
	}
	openskyTokenURL, err := s.resolveNextURL(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyTokenURL }), update.OpenskyTokenURL, "openskyTokenUrl")
	if err != nil {
		return nil, err
	}
	aisRelayBaseURL, err := s.resolveNextURL(
		rawCoalesce(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AisRelayBaseURL }),
			rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.RelayBaseURL })),
		coalesceString(update.AisRelayBaseURL, update.RelayBaseURL),
		"aisRelayBaseUrl",
	)
	if err != nil {
		return nil, err
	}
	polymarketProxyURL, err := s.resolveNextURL(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.PolymarketProxyURL }), update.PolymarketProxyURL, "polymarketProxyUrl")
	if err != nil {
		return nil, err
	}

	next := &writtenRealtimeSettings{
		Enabled:                         asBooleanOption(update.Enabled, effective.Enabled),
		RequestTimeoutMs:                asBoundedIntOption(update.RequestTimeoutMs, effective.RequestTimeoutMs, 1_000, 120_000),
		MaxRetries:                      asBoundedIntOption(update.MaxRetries, effective.MaxRetries, 0, 6),
		OpenskyEnabled:                  asBooleanOption(coalesceBool(update.OpenskyEnabled, update.AdsbEnabled), effective.OpenskyEnabled),
		OpenskyIntervalSec:              asBoundedIntOption(coalesceNumber(update.OpenskyIntervalSec, update.AdsbIntervalSec), effective.OpenskyIntervalSec, 30, 86_400),
		OpenskyDailyCreditBudget:        asBoundedIntOption(update.OpenskyDailyCreditBudget, effective.OpenskyDailyCreditBudget, 1, 100_000),
		OpenskyDayIntervalSec:           asBoundedIntOption(update.OpenskyDayIntervalSec, effective.OpenskyDayIntervalSec, 30, 86_400),
		OpenskyNightIntervalSec:         asBoundedIntOption(update.OpenskyNightIntervalSec, effective.OpenskyNightIntervalSec, 30, 86_400),
		OpenskyDayStartHourHKT:          asBoundedIntOption(update.OpenskyDayStartHourHKT, effective.OpenskyDayStartHourHKT, 0, 23),
		OpenskyNightStartHourHKT:        asBoundedIntOption(update.OpenskyNightStartHourHKT, effective.OpenskyNightStartHourHKT, 0, 23),
		OpenskyWarningRemainingPct:      asBoundedIntOption(update.OpenskyWarningRemainingPct, effective.OpenskyWarningRemainingPct, 1, 99),
		OpenskyCriticalRemainingPct:     asBoundedIntOption(update.OpenskyCriticalRemainingPct, effective.OpenskyCriticalRemainingPct, 0, 98),
		AisEnabled:                      asBooleanOption(update.AisEnabled, effective.AisEnabled),
		AisIntervalSec:                  asBoundedIntOption(update.AisIntervalSec, effective.AisIntervalSec, 30, 86_400),
		UnrestEnabled:                   asBooleanOption(update.UnrestEnabled, effective.UnrestEnabled),
		UnrestIntervalSec:               asBoundedIntOption(update.UnrestIntervalSec, effective.UnrestIntervalSec, 30, 86_400),
		OutagesEnabled:                  asBooleanOption(update.OutagesEnabled, effective.OutagesEnabled),
		OutagesIntervalSec:              asBoundedIntOption(update.OutagesIntervalSec, effective.OutagesIntervalSec, 30, 86_400),
		KeywordSpikeEnabled:             asBooleanOption(update.KeywordSpikeEnabled, effective.KeywordSpikeEnabled),
		KeywordSpikeIntervalSec:         asBoundedIntOption(update.KeywordSpikeIntervalSec, effective.KeywordSpikeIntervalSec, 30, 86_400),
		PizzintEnabled:                  asBooleanOption(update.PizzintEnabled, effective.PizzintEnabled),
		PizzintIntervalSec:              asBoundedIntOption(update.PizzintIntervalSec, effective.PizzintIntervalSec, 30, 86_400),
		GdeltTensionEnabled:             asBooleanOption(update.GdeltTensionEnabled, effective.GdeltTensionEnabled),
		GdeltTensionIntervalSec:         asBoundedIntOption(update.GdeltTensionIntervalSec, effective.GdeltTensionIntervalSec, 30, 86_400),
		PolymarketLeadsEnabled:          asBooleanOption(update.PolymarketLeadsEnabled, effective.PolymarketLeadsEnabled),
		PolymarketLeadsIntervalSec:      asBoundedIntOption(update.PolymarketLeadsIntervalSec, effective.PolymarketLeadsIntervalSec, 30, 86_400),
		KeywordSpikeMinCount:            asBoundedIntOption(update.KeywordSpikeMinCount, effective.KeywordSpikeMinCount, 1, 500),
		KeywordSpikeMultiplier:          asBoundedNumberOption(update.KeywordSpikeMultiplier, effective.KeywordSpikeMultiplier, 1, 100),
		PredictionShiftThreshold:        asBoundedNumberOption(update.PredictionShiftThreshold, effective.PredictionShiftThreshold, 1, 100),
		PredictionNewsActivityThreshold: asBoundedIntOption(update.PredictionNewsActivityThreshold, effective.PredictionNewsActivityThreshold, 0, 1_000),
		OpenskyBaseURL:                  openskyBaseURL,
		OpenskyTokenURL:                 openskyTokenURL,
		AisRelayBaseURL:                 aisRelayBaseURL,
		OpenskyClientID:                 resolveNextString(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.OpenskyClientID }), update.OpenskyClientID),
		OpenskyClientSecret:             openskyClientSecret,
		AisRelaySharedSecret:            aisRelaySharedSecret,
		// Historical acledAccessToken is written as JSON null and never restored
		// from a request member (the DTO has no such field).
		AcledAccessToken:   jsonNullValue,
		AcledOauthUsername: resolveNextString(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AcledOauthUsername }), update.AcledOauthUsername),
		AcledOauthPassword: acledPassword,
		AcledOauthClientID: resolveNextString(rawMember(stored, func(v *storedRealtimeSettings) json.RawMessage { return v.AcledOauthClientID }), update.AcledOauthClientID),
		CloudflareAPIToken: cloudflare,
		WingbitsAPIKey:     wingbits,
		PolymarketProxyURL: polymarketProxyURL,
	}

	// `relayBaseUrl` and `relaySharedSecret` are deliberately absent from the
	// written document: NestJS assigns undefined and JSON.stringify drops them.

	// Cross-field relations are validated on the document about to be written,
	// before the upsert and before the audit, exactly like NestJS.
	if err := validateOpenskyBudgetRelations(
		next.OpenskyDailyCreditBudget,
		next.OpenskyDayIntervalSec,
		next.OpenskyNightIntervalSec,
		next.OpenskyDayStartHourHKT,
		next.OpenskyNightStartHourHKT,
		next.OpenskyWarningRemainingPct,
		next.OpenskyCriticalRemainingPct,
	); err != nil {
		return nil, err
	}
	return next, nil
}

// validateOpenskyBudgetRelations mirrors validateOpenskyBudgetSettings for the
// plain numbers of the document being written: the first failing relation wins
// and produces the exact NestJS message.
func validateOpenskyBudgetRelations(
	dailyCreditBudget, dayIntervalSec, nightIntervalSec int,
	dayStartHourHKT, nightStartHourHKT int,
	warningRemainingPct, criticalRemainingPct int,
) error {
	if dailyCreditBudget <= 0 {
		return &httpError{status: http.StatusBadRequest, message: "openskyDailyCreditBudget must be greater than 0"}
	}
	if dayStartHourHKT >= nightStartHourHKT {
		return &httpError{status: http.StatusBadRequest, message: "openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt"}
	}
	if criticalRemainingPct >= warningRemainingPct {
		return &httpError{status: http.StatusBadRequest, message: "openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct"}
	}
	if dayIntervalSec > nightIntervalSec {
		return &httpError{status: http.StatusBadRequest, message: "openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec"}
	}
	return nil
}

// resolveNextString mirrors resolveNextString(current, next): a missing member
// keeps the normalized stored value (or null), otherwise the new value is trimmed
// and a blank becomes null.
func resolveNextString(current json.RawMessage, next optionalString) *string {
	if next.state == presenceMissing {
		return stringPtrOrNil(normalizeStringRaw(current))
	}
	return stringPtrOrNil(strings.TrimSpace(next.value))
}

// resolveNextURL mirrors resolveNextUrl(current, next, fieldName).
//
// A missing member keeps the current value (normalized, not validated); an
// explicit null clears the override; a blank string also clears it. A non-blank
// value is validated as an http(s) URL.
func (s *Service) resolveNextURL(current json.RawMessage, next optionalString, fieldName string) (*string, error) {
	if next.state == presenceMissing {
		return stringPtrOrNil(normalizeURLRaw(current)), nil
	}
	normalized := strings.TrimSpace(next.value)
	if normalized == "" {
		return nil, nil
	}
	validated, err := validateHTTPURL(normalized, fieldName)
	if err != nil {
		return nil, err
	}
	return &validated, nil
}

// resolveNextSecretRaw mirrors resolveNextSecret(current, next).
//
// A missing member keeps the stored value BYTE-IDENTICAL, so an unmodified
// ciphertext envelope is never re-encrypted with a fresh IV. An explicit null, an
// empty string or whitespace clears the secret. Anything else is trimmed and
// encoded through the shared encryption policy.
func (s *Service) resolveNextSecretRaw(ctx context.Context, current json.RawMessage, next optionalString) (json.RawMessage, error) {
	if next.state == presenceMissing {
		trimmed := bytes.TrimSpace(current)
		if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
			return jsonNullValue, nil
		}
		return current, nil
	}
	normalized := strings.TrimSpace(next.value)
	if normalized == "" {
		return jsonNullValue, nil
	}
	encoded, err := s.encodeSecretForStorage(ctx, normalized)
	if err != nil {
		return nil, err
	}
	return encoded.toRawValue()
}

// validateHTTPURL reproduces the NestJS validateUrl helper: only http/https is
// accepted, the output is the WHATWG-normalized form (lowercased scheme and host,
// default port removed) with every trailing slash stripped, and the error text is
// the exact NestJS message.
func validateHTTPURL(value, fieldName string) (string, error) {
	invalid := &httpError{status: http.StatusBadRequest, message: fieldName + " must be a valid http(s) URL"}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", invalid
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", invalid
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", invalid
	}
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	authority := host
	if port != "" {
		authority = host + ":" + port
	}
	if parsed.User != nil {
		authority = parsed.User.String() + "@" + authority
	}
	var builder strings.Builder
	builder.WriteString(scheme)
	builder.WriteString("://")
	builder.WriteString(authority)
	builder.WriteString(parsed.EscapedPath())
	if parsed.RawQuery != "" {
		builder.WriteString("?")
		builder.WriteString(parsed.RawQuery)
	}
	if parsed.Fragment != "" {
		builder.WriteString("#")
		builder.WriteString(parsed.Fragment)
	}
	return strings.TrimRight(builder.String(), "/"), nil
}

// resetRealtimeSettings mirrors resetToEnv: both rows are deleted inside the
// caller's lock, the audit is awaited, both caches are invalidated and the
// environment-backed public settings are returned. No worker state is touched and
// no scheduler is restarted.
func (s *Service) resetRealtimeSettings(ctx context.Context, orgID, actorID string) (*realtimePublicSettings, error) {
	if err := s.deleteRealtimeSettings(ctx); err != nil {
		return nil, err
	}
	metadata, err := json.Marshal(resetAuditMetadata{OK: true})
	if err != nil {
		return nil, err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, "realtime_signals_reset", metadata); err != nil {
		return nil, err
	}
	s.invalidateRealtimeSettingsCache(ctx)
	s.invalidateAcledAuthStateCache(ctx)
	return s.getRealtimePublicSettings(ctx)
}

// realtimeLockBusyMessage is the 409 message the realtime writer returns when the
// global lock is held. Byte-identical to the NestJS DataRuntimeSettings
// ConflictException text.
const realtimeLockBusyMessage = "Realtime signals settings are being updated by another request; retry later"

// nominatimLockBusyMessage is the 409 message the Nominatim writer returns.
const nominatimLockBusyMessage = "Nominatim identity settings are being updated by another request; retry later"

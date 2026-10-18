package situationsignals

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Settings constants mirrored from
// apps/api/src/modules/system-settings/situation-monitor-settings.service.ts.
const (
	settingsKey               = "situation_monitor_settings"
	settingsCacheKey          = "situation_monitor:settings"
	settingsCacheTTL          = 30 * time.Second
	defaultTelegramChannelSet = "full"
)

// liveHLSProxyChannels is the legal channel list from
// isSituationMonitorLiveHlsProxyChannel. Any other channel falls back to the
// unconfigured response and never reads a credential.
var liveHLSProxyChannels = []string{"cnn", "cnbc"}

// settingsReader resolves the effective situation monitor settings from the
// same SystemSetting key and the same 30 second Redis envelope NestJS uses, so
// both implementations observe one value.
type settingsReader struct {
	db     *sql.DB
	cache  cacheOps
	lookup func(string) (string, bool)
}

// NewSettingsReader wires the settings reader. lookup reports an environment
// variable and whether it is set at all; a missing variable and an empty one are
// different inputs for the JavaScript Number() resolvers.
func NewSettingsReader(db *sql.DB, redisClient *redis.Client, lookup func(string) (string, bool)) *settingsReader {
	if lookup == nil {
		lookup = func(string) (string, bool) { return "", false }
	}
	return &settingsReader{db: db, cache: redisCacheOps(redisClient), lookup: lookup}
}

// storedSituationMonitorSettings is the loose projection of the
// situation_monitor_settings document. Only the fields this batch reads are
// projected; every one of them is a named loose type so a document written by an
// older revision cannot break decoding.
type storedSituationMonitorSettings struct {
	TelegramEnabled         jsNumberish   `json:"telegramEnabled"`
	TelegramApiID           trimmedString `json:"telegramApiId"`
	TelegramApiHash         rawJSON       `json:"telegramApiHash"`
	TelegramSession         rawJSON       `json:"telegramSession"`
	TelegramChannelSet      trimmedString `json:"telegramChannelSet"`
	LiveHLSProxyCnnURL      trimmedString `json:"liveHlsProxyCnnUpstreamUrl"`
	LiveHLSProxyCnnReferer  trimmedString `json:"liveHlsProxyCnnReferer"`
	LiveHLSProxyCnnHosts    jsStringList  `json:"liveHlsProxyCnnAllowedHosts"`
	LiveHLSProxyCnbcURL     trimmedString `json:"liveHlsProxyCnbcUpstreamUrl"`
	LiveHLSProxyCnbcReferer trimmedString `json:"liveHlsProxyCnbcReferer"`
	LiveHLSProxyCnbcHosts   jsStringList  `json:"liveHlsProxyCnbcAllowedHosts"`
}

// cachedSettingsEnvelope is the Redis envelope NestJS writes:
// `{exists: boolean, value?: object}`.
type cachedSettingsEnvelope struct {
	Exists rawJSON `json:"exists"`
	Value  rawJSON `json:"value"`
}

// settingsCacheWrite is the envelope this package writes back so the NestJS
// reader sees exactly what it would have written itself. `value` is omitted
// when the SystemSetting row exists but holds a non-object document.
type settingsCacheWrite struct {
	Exists bool     `json:"exists"`
	Value  *rawJSON `json:"value,omitempty"`
}

// loadStored reads the stored settings document.
//
// Read order is identical to NestJS loadStoredSettings: the Redis envelope wins
// whenever it decodes to a truthy value (any object or array, or any truthy
// scalar), and MySQL is only consulted on a cache miss. The MySQL result is then
// written back with the same 30 second TTL, so the two implementations share one
// cache entry.
func (s *settingsReader) loadStored(ctx context.Context) (*storedSituationMonitorSettings, error) {
	if s == nil {
		return nil, nil
	}
	if s.cache.get != nil {
		if cached, err := s.cache.get(ctx, settingsCacheKey); err == nil && cached != "" {
			var envelope cachedSettingsEnvelope
			raw := rawJSON{raw: json.RawMessage(cached)}
			if json.Unmarshal([]byte(cached), &envelope) == nil {
				if raw.isTruthy() {
					if !envelope.Exists.isTruthy() {
						return nil, nil
					}
					value, ok := envelope.Value.asObject()
					if !ok {
						return nil, nil
					}
					encoded, err := json.Marshal(value)
					if err != nil {
						return nil, nil
					}
					return decodeStoredSettings(encoded), nil
				}
			}
		} else if err != nil && !errors.Is(err, redis.Nil) {
			log.Printf("situationsignals: settings cache read failed: %v", err)
		}
	}
	if s.db == nil {
		return nil, nil
	}

	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ?", settingsKey).Scan(&raw)
	recordExists := true
	if errors.Is(err, sql.ErrNoRows) {
		recordExists = false
	} else if err != nil {
		return nil, err
	}

	var settings *storedSituationMonitorSettings
	var storedValue rawJSON
	if recordExists && len(raw) > 0 {
		storedValue = rawJSON{raw: append([]byte(nil), raw...)}
		// `typeof raw === "object"` in JavaScript also accepts arrays; decoding
		// an array into the struct leaves every field at its zero value, which
		// is exactly what reading properties off an array yields.
		if isJSONObjectOrArray(raw) {
			settings = decodeStoredSettings(raw)
		}
	}

	if s.cache.set != nil {
		envelope := settingsCacheWrite{Exists: recordExists}
		if settings != nil {
			value := storedValue
			envelope.Value = &value
		}
		if payload, err := json.Marshal(envelope); err == nil {
			if err := s.cache.set(ctx, settingsCacheKey, payload, settingsCacheTTL); err != nil {
				log.Printf("situationsignals: settings cache write failed: %v", err)
			}
		}
	}
	return settings, nil
}

// decodeStoredSettings decodes a stored document, tolerating any shape.
func decodeStoredSettings(raw []byte) *storedSituationMonitorSettings {
	settings := &storedSituationMonitorSettings{}
	if len(raw) == 0 {
		return settings
	}
	if err := json.Unmarshal(raw, settings); err != nil {
		// A non-object document reads as "every property undefined" in
		// JavaScript; an empty projection reproduces that.
		return &storedSituationMonitorSettings{}
	}
	return settings
}

// telegramRuntime is the subset of SituationMonitorTelegramRuntimeConfig this
// batch needs: the feed response's enabled/configured/channelSet fields and the
// channelSet comparison the cached-state sync performs.
type telegramRuntime struct {
	Enabled    bool
	APIID      string
	APIHash    string
	Session    string
	ChannelSet string
}

// configured reports whether an API id, an API hash and a session are all
// present, mirroring Boolean(runtime.apiId && runtime.apiHash && runtime.session).
func (r telegramRuntime) configured() bool {
	return r.APIID != "" && r.APIHash != "" && r.Session != ""
}

// telegramRuntimeConfig resolves the effective Telegram runtime configuration.
func (s *settingsReader) telegramRuntimeConfig(ctx context.Context) (telegramRuntime, error) {
	stored, err := s.loadStored(ctx)
	if err != nil {
		return telegramRuntime{}, err
	}
	envEnabled := s.booleanEnv("SITUATION_MONITOR_TELEGRAM_ENABLED", false)

	enabled := envEnabled
	if stored != nil {
		// asBoolean: only a real boolean wins, anything else keeps the env value.
		if value, ok := stored.TelegramEnabled.Number(); ok && isJSONBooleanValue(stored.TelegramEnabled) {
			enabled = value == 1
		}
	}

	apiID := ""
	if stored != nil {
		if value, ok := stored.TelegramApiID.Value(); ok {
			apiID = value
		}
	}
	if apiID == "" {
		apiID = s.stringEnv("SITUATION_MONITOR_TELEGRAM_API_ID", "TELEGRAM_API_ID")
	}

	apiHash := s.storedSecret(stored, func(settings *storedSituationMonitorSettings) rawJSON {
		return settings.TelegramApiHash
	})
	if apiHash == "" {
		apiHash = s.stringEnv("SITUATION_MONITOR_TELEGRAM_API_HASH", "TELEGRAM_API_HASH")
	}

	// The session deliberately has no environment fallback: NestJS resolves it
	// from the stored setting only.
	session := s.storedSecret(stored, func(settings *storedSituationMonitorSettings) rawJSON {
		return settings.TelegramSession
	})

	channelSet := ""
	if stored != nil {
		if value, ok := stored.TelegramChannelSet.Value(); ok {
			channelSet = value
		}
	}
	if channelSet == "" {
		channelSet = s.stringEnv("SITUATION_MONITOR_TELEGRAM_CHANNEL_SET", "TELEGRAM_CHANNEL_SET")
	}
	if channelSet == "" {
		channelSet = defaultTelegramChannelSet
	}

	return telegramRuntime{
		Enabled:    enabled,
		APIID:      apiID,
		APIHash:    apiHash,
		Session:    session,
		ChannelSet: channelSet,
	}, nil
}

// telegramRefreshReadiness is the four booleans GET /catalog needs.
type telegramRefreshReadiness struct {
	Enabled  bool
	HasAPIID bool
	HasHash  bool
	HasSess  bool
}

// refreshReadiness resolves the five booleans refreshReadiness reports.
func (s *settingsReader) refreshReadiness(ctx context.Context) (telegramRefreshReadiness, bool, error) {
	runtime, err := s.telegramRuntimeConfig(ctx)
	if err != nil {
		return telegramRefreshReadiness{}, false, err
	}
	orefConfigured := s.stringEnv("SITUATION_MONITOR_OREF_PROXY_AUTH", "OREF_PROXY_AUTH") != ""
	return telegramRefreshReadiness{
		Enabled:  runtime.Enabled,
		HasAPIID: runtime.APIID != "",
		HasHash:  runtime.APIHash != "",
		HasSess:  runtime.Session != "",
	}, orefConfigured, nil
}

// orefEnabled reports SITUATION_MONITOR_OREF_ENABLED. The schema default is
// false, so an unset variable yields false.
func (s *settingsReader) orefEnabled() bool {
	return s.booleanEnv("SITUATION_MONITOR_OREF_ENABLED", false)
}

// orefConfigured reports whether the OREF proxy credential is present. Credential
// material is never returned, only its presence.
func (s *settingsReader) orefConfigured() bool {
	return s.stringEnv("SITUATION_MONITOR_OREF_PROXY_AUTH", "OREF_PROXY_AUTH") != ""
}

// liveHLSProxyConfig is the response shape of GET /live-hls-proxy-config. It
// never carries the credential the upstream URL may embed beyond the URL itself,
// which the settings owner configured on purpose.
type liveHLSProxyConfig struct {
	Channel      string   `json:"channel"`
	Configured   bool     `json:"configured"`
	UpstreamURL  *string  `json:"upstreamUrl"`
	Referer      *string  `json:"referer"`
	AllowedHosts []string `json:"allowedHosts"`
}

// unconfiguredLiveHLSProxy is the response for an unknown or unconfigured
// channel. `channel` keeps the caller's normalized value (or "").
func unconfiguredLiveHLSProxy(channel string) liveHLSProxyConfig {
	return liveHLSProxyConfig{
		Channel:      channel,
		Configured:   false,
		UpstreamURL:  nil,
		Referer:      nil,
		AllowedHosts: []string{},
	}
}

// liveHLSProxyChannelConfig resolves the per-channel HLS proxy configuration.
func (s *settingsReader) liveHLSProxyChannelConfig(ctx context.Context, channel string) (liveHLSProxyConfig, error) {
	stored, err := s.loadStored(ctx)
	if err != nil {
		return liveHLSProxyConfig{}, err
	}
	var rawURL, rawReferer trimmedString
	var rawHosts jsStringList
	if stored != nil {
		if channel == "cnn" {
			rawURL, rawReferer, rawHosts = stored.LiveHLSProxyCnnURL, stored.LiveHLSProxyCnnReferer, stored.LiveHLSProxyCnnHosts
		} else {
			rawURL, rawReferer, rawHosts = stored.LiveHLSProxyCnbcURL, stored.LiveHLSProxyCnbcReferer, stored.LiveHLSProxyCnbcHosts
		}
	}

	upstream := ""
	if value, ok := rawURL.Value(); ok {
		// normalizeHttpsUrl: https only, otherwise the channel counts as
		// unconfigured.
		if normalized, ok := normalizeAbsoluteURL(value, "https"); ok {
			upstream = normalized
		}
	}
	if upstream == "" {
		return unconfiguredLiveHLSProxy(channel), nil
	}

	referer := ""
	if value, ok := rawReferer.Value(); ok {
		if normalized, ok := normalizeAbsoluteURL(value, "http", "https"); ok {
			referer = normalized
		}
	}

	allowed := normalizeHostList(rawHosts.Values())
	seen := map[string]bool{}
	for _, host := range allowed {
		seen[host] = true
	}
	if parsed, err := url.Parse(upstream); err == nil {
		host := strings.ToLower(parsed.Hostname())
		if host != "" && !seen[host] {
			allowed = append(allowed, host)
		}
	}

	refererValue := referer
	return liveHLSProxyConfig{
		Channel:      channel,
		Configured:   true,
		UpstreamURL:  &upstream,
		Referer:      &refererValue,
		AllowedHosts: allowed,
	}, nil
}

// storedSecret resolves a credential-shaped stored field through
// resolveStoredApiKey: falsy -> absent, plain string -> trimmed, encrypted
// envelope -> decrypted with SYSTEM_SETTINGS_ENCRYPTION_KEY, anything else ->
// absent.
func (s *settingsReader) storedSecret(stored *storedSituationMonitorSettings, pick func(*storedSituationMonitorSettings) rawJSON) string {
	if stored == nil {
		return ""
	}
	raw := pick(stored)
	if raw.isFalsy() {
		return ""
	}
	if text, ok := raw.asString(); ok {
		return strings.TrimSpace(text)
	}
	if !raw.isEncryptedSettingsValue() {
		return ""
	}
	if s == nil || s.lookup == nil {
		return ""
	}
	key, ok := s.lookup("SYSTEM_SETTINGS_ENCRYPTION_KEY")
	if !ok || strings.TrimSpace(key) == "" {
		return ""
	}
	plain, ok := decryptSettingsSecret(raw, strings.TrimSpace(key))
	if !ok {
		return ""
	}
	return strings.TrimSpace(plain)
}

// booleanEnv resolves an envBoolean-style environment variable. Values the zod
// schema would reject cannot reach here in a running deployment (NestJS refuses
// to boot); they are treated as false instead of failing the Go request.
func (s *settingsReader) booleanEnv(key string, fallback bool) bool {
	if s == nil || s.lookup == nil {
		return fallback
	}
	value, ok := s.lookup(key)
	if !ok {
		return fallback
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off", "":
		return false
	}
	return fallback
}

// stringEnv mirrors readStringEnv: the first key that yields a non-empty trimmed
// value wins.
func (s *settingsReader) stringEnv(keys ...string) string {
	if s == nil || s.lookup == nil {
		return ""
	}
	for _, key := range keys {
		value, ok := s.lookup(key)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// isJSONObjectOrArray reports whether the raw bytes are a JSON object or array,
// which is what `typeof value === "object"` accepts in JavaScript.
func isJSONObjectOrArray(raw []byte) bool {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '{' || trimmed[0] == '['
}

// isJSONBooleanValue reports whether the loose field decoded from a real JSON
// boolean (asBoolean only accepts booleans).
func isJSONBooleanValue(value jsNumberish) bool {
	trimmed := strings.TrimSpace(string(value.raw))
	return trimmed == "true" || trimmed == "false"
}

// normalizeAbsoluteURL mirrors validateUrl: the value must parse as an absolute
// URL with one of the allowed protocols; the result is serialized and stripped
// of trailing slashes.
func normalizeAbsoluteURL(value string, schemes ...string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" {
		return "", false
	}
	allowed := false
	for _, scheme := range schemes {
		if strings.EqualFold(parsed.Scheme, scheme) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", false
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return strings.TrimRight(parsed.String(), "/"), true
}

// normalizeHostList mirrors normalizeHostList: keep the strings that parse as a
// bare hostname, lower-case them and drop duplicates while preserving order.
func normalizeHostList(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		normalized, ok := normalizeHostEntry(value)
		if !ok || seen[normalized] {
			continue
		}
		seen[normalized] = true
		out = append(out, normalized)
	}
	return out
}

// normalizeHostEntry mirrors normalizeHostEntry: a hostname only, no path, no
// port, no credentials.
func normalizeHostEntry(value string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return "", false
	}
	parsed, err := url.Parse("https://" + normalized)
	if err != nil {
		return "", false
	}
	// WHATWG's URL keeps the port out of `hostname`, so a value carrying a port
	// (`example.test:8080`) or user info never equals its own hostname and is
	// rejected, exactly like normalizeHostEntry in the NestJS settings service.
	if parsed.Hostname() != normalized || parsed.Port() != "" {
		return "", false
	}
	if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	return normalized, true
}

// encryptedSettingsEnvelope is the system-settings:v1 AES-256-GCM envelope from
// apps/api/src/modules/storage/storage-settings.crypto.ts.
type encryptedSettingsEnvelope struct {
	Tag  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	Data string `json:"data"`
	Auth string `json:"tag"`
}

// isEncryptedSettingsValue mirrors isEncryptedStringValueV1.
func (r rawJSON) isEncryptedSettingsValue() bool {
	record, ok := r.asObject()
	if !ok {
		return false
	}
	var envelope encryptedSettingsEnvelope
	if err := json.Unmarshal(r.raw, &envelope); err != nil {
		return false
	}
	if envelope.Tag != "system-settings:v1" || envelope.Alg != "aes-256-gcm" {
		return false
	}
	_, ivOK := record["iv"]
	_, tagOK := record["tag"]
	_, dataOK := record["data"]
	if !ivOK || !tagOK || !dataOK {
		return false
	}
	_, ivString := rawJSON{raw: record["iv"]}.asString()
	_, tagString := rawJSON{raw: record["tag"]}.asString()
	_, dataString := rawJSON{raw: record["data"]}.asString()
	return ivString && tagString && dataString
}

// decodeSettingsKey mirrors decodeSystemSettingsKey: 64 hex characters or a
// base64 encoding of exactly 32 bytes.
func decodeSettingsKey(raw string) ([]byte, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, false
	}
	hexCandidate := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if len(hexCandidate) == 64 && isHexString(hexCandidate) {
		decoded, err := hex.DecodeString(hexCandidate)
		if err != nil {
			return nil, false
		}
		return decoded, true
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, false
	}
	return decoded, true
}

func isHexString(value string) bool {
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		case r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

// decryptSettingsSecret mirrors decryptStringValueV1. Failure is not an error:
// the caller treats an undecryptable secret as absent, exactly like NestJS.
func decryptSettingsSecret(raw rawJSON, keyMaterial string) (string, bool) {
	key, ok := decodeSettingsKey(keyMaterial)
	if !ok {
		return "", false
	}
	var envelope encryptedSettingsEnvelope
	if err := json.Unmarshal(raw.raw, &envelope); err != nil {
		return "", false
	}
	iv, err := base64.StdEncoding.DecodeString(envelope.IV)
	if err != nil {
		return "", false
	}
	tag, err := base64.StdEncoding.DecodeString(envelope.Auth)
	if err != nil {
		return "", false
	}
	data, err := base64.StdEncoding.DecodeString(envelope.Data)
	if err != nil {
		return "", false
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", false
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", false
	}
	if len(iv) != gcm.NonceSize() {
		return "", false
	}
	sealed := make([]byte, 0, len(data)+len(tag))
	sealed = append(sealed, data...)
	sealed = append(sealed, tag...)
	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", false
	}
	return string(plain), true
}

// clampInt mirrors Math.max(min, Math.min(max, Math.trunc(value))).
func clampInt(value, min, max int) int {
	if math.IsNaN(float64(value)) {
		return min
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

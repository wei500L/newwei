// Package situationsettings owns the four situation-monitor settings HTTP
// entries under /api/system-settings/situation-monitor.
//
// It is the Go equivalent of
// apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts
// and situation-monitor-settings.service.ts. The SystemSetting row, its Redis
// envelope, the system-settings:v1 secret envelope, the audit rows and the two
// BullMQ schedules are shared with NestJS byte for byte.
package situationsettings

import (
	"encoding/json"
	"time"
)

// Storage and cache coordinates mirrored from the NestJS service.
const (
	settingsKey         = "situation_monitor_settings"
	settingsDescription = "Situation monitor settings (DeepLX translation + fallback endpoint + Finnhub/FRED API keys + Telegram ingestion config + live HLS proxy config)."
	settingsCacheKey    = "situation_monitor:settings"
	settingsCacheTTL    = 30 * time.Second

	securitySettingsKey = "system_security"
	securityCacheKey    = "system_security:settings"
	securityCacheTTL    = 60 * time.Second

	// telegramStateCacheKey is SITUATION_MONITOR_TELEGRAM_STATE_CACHE_KEY.
	telegramStateCacheKey = "situation-monitor:signals:telegram:state:v1"
	// telegramClearChannel is the cross-instance T1 broadcast.
	telegramClearChannel = "situation-monitor:telegram-clear:v1"
	telegramClearMessage = `{"version":1,"clearItems":true}`
)

// Defaults and bounds mirrored from the NestJS service.
const (
	defaultTranslationMaxConcurrency  = 2
	maxTranslationMaxConcurrency      = 5_000
	defaultTranslationAPITimeoutMS    = 15_000
	defaultTranslationAPIMaxRetries   = 2
	defaultTranslationAPIBaseURL      = "https://api.deeplx.org"
	defaultTranslationFallbackEnabled = false
	translationProviderDeepLX         = "deeplx"
	defaultTelegramChannelSet         = "full"
	defaultTelegramMaxFeedItems       = 200
	defaultTelegramMaxTextChars       = 800
	defaultTelegramChannelTimeoutMS   = 15_000
	defaultTelegramPollCycleTimeoutMS = 180_000
	defaultTelegramStartupDelayMS     = 60_000
	defaultTelegramRateLimitMS        = 800
	defaultTelegramPollIntervalMS     = 60_000
	minTranslationMaxConcurrency      = 1
	minTranslationAPITimeoutMS        = 1_000
	maxTranslationAPITimeoutMS        = 120_000
	minTranslationAPIMaxRetries       = 0
	maxTranslationAPIMaxRetries       = 5
	minTelegramMaxFeedItems           = 50
	maxTelegramMaxFeedItems           = 500
	minTelegramMaxTextChars           = 200
	maxTelegramMaxTextChars           = 10_000
	minTelegramChannelTimeoutMS       = 3_000
	maxTelegramChannelTimeoutMS       = 120_000
	minTelegramPollCycleTimeoutMS     = 30_000
	maxTelegramPollCycleTimeoutMS     = 600_000
	minTelegramStartupDelayMS         = 0
	maxTelegramStartupDelayMS         = 600_000
	minTelegramRateLimitMS            = 100
	maxTelegramRateLimitMS            = 60_000
	minTelegramPollIntervalMS         = 15_000
	maxTelegramPollIntervalMS         = 3_600_000
	maxLiveHLSProxyAllowedHosts       = 64
)

// SettingsSource is the top-level `source` member of the public settings.
type SettingsSource string

const (
	// SettingsSourceEnv means no SystemSetting row exists.
	SettingsSourceEnv SettingsSource = "env"
	// SettingsSourceDB means a SystemSetting row exists.
	SettingsSourceDB SettingsSource = "db"
)

// APIKeySource is the per-credential source member.
type APIKeySource string

const (
	APIKeySourceStored APIKeySource = "stored"
	APIKeySourceEnv    APIKeySource = "env"
	APIKeySourceNone   APIKeySource = "none"
)

// OrefSecretSource is the OREF credential source. OREF is environment-only.
type OrefSecretSource string

const (
	OrefSecretSourceEnv  OrefSecretSource = "env"
	OrefSecretSourceNone OrefSecretSource = "none"
)

// LiveHLSProxySource is the live HLS proxy source. It is stored-only.
type LiveHLSProxySource string

const (
	LiveHLSProxySourceStored LiveHLSProxySource = "stored"
	LiveHLSProxySourceNone   LiveHLSProxySource = "none"
)

// PublicSettings is SituationMonitorSettingsPublic. Field order matches the
// NestJS object literal so the JSON body is structurally identical.
type PublicSettings struct {
	Source                        SettingsSource `json:"source"`
	TranslationMaxConcurrency     int            `json:"translationMaxConcurrency"`
	TranslationProvider           string         `json:"translationProvider"`
	TranslationAPIEnabled         bool           `json:"translationApiEnabled"`
	TranslationAPIBaseURL         string         `json:"translationApiBaseUrl"`
	TranslationFallbackAPIEnabled bool           `json:"translationFallbackApiEnabled"`
	TranslationFallbackAPIBaseURL string         `json:"translationFallbackApiBaseUrl"`
	TranslationAPITimeoutMS       int            `json:"translationApiTimeoutMs"`
	TranslationAPIMaxRetries      int            `json:"translationApiMaxRetries"`
	HasTranslationAPIKey          bool           `json:"hasTranslationApiKey"`
	TranslationAPIKeySource       APIKeySource   `json:"translationApiKeySource"`
	HasFinnhubAPIKey              bool           `json:"hasFinnhubApiKey"`
	FinnhubAPIKeySource           APIKeySource   `json:"finnhubApiKeySource"`
	HasFredAPIKey                 bool           `json:"hasFredApiKey"`
	FredAPIKeySource              APIKeySource   `json:"fredApiKeySource"`
	TelegramEnabled               bool           `json:"telegramEnabled"`
	HasTelegramAPIID              bool           `json:"hasTelegramApiId"`
	TelegramAPIIDSource           APIKeySource   `json:"telegramApiIdSource"`
	// TelegramAPIID is nil when neither the row nor the environment supplies an
	// id. NestJS writes `telegramApiId: undefined`, which JSON.stringify omits.
	TelegramAPIID              *string          `json:"telegramApiId,omitempty"`
	HasTelegramAPIHash         bool             `json:"hasTelegramApiHash"`
	TelegramAPIHashSource      APIKeySource     `json:"telegramApiHashSource"`
	HasTelegramSession         bool             `json:"hasTelegramSession"`
	TelegramSessionSource      APIKeySource     `json:"telegramSessionSource"`
	OrefEnabled                bool             `json:"orefEnabled"`
	OrefConfigured             bool             `json:"orefConfigured"`
	OrefProxyAuthSource        OrefSecretSource `json:"orefProxyAuthSource"`
	TelegramChannelSet         string           `json:"telegramChannelSet"`
	TelegramMaxFeedItems       int              `json:"telegramMaxFeedItems"`
	TelegramMaxTextChars       int              `json:"telegramMaxTextChars"`
	TelegramChannelTimeoutMS   int              `json:"telegramChannelTimeoutMs"`
	TelegramPollCycleTimeoutMS int              `json:"telegramPollCycleTimeoutMs"`
	TelegramStartupDelayMS     int              `json:"telegramStartupDelayMs"`
	TelegramRateLimitMS        int              `json:"telegramRateLimitMs"`
	TelegramPollIntervalMS     int              `json:"telegramPollIntervalMs"`

	LiveHLSProxyCnnConfigured    bool               `json:"liveHlsProxyCnnConfigured"`
	LiveHLSProxyCnnSource        LiveHLSProxySource `json:"liveHlsProxyCnnSource"`
	LiveHLSProxyCnnUpstreamURL   string             `json:"liveHlsProxyCnnUpstreamUrl"`
	LiveHLSProxyCnnReferer       string             `json:"liveHlsProxyCnnReferer"`
	LiveHLSProxyCnnAllowedHosts  []string           `json:"liveHlsProxyCnnAllowedHosts"`
	LiveHLSProxyCnbcConfigured   bool               `json:"liveHlsProxyCnbcConfigured"`
	LiveHLSProxyCnbcSource       LiveHLSProxySource `json:"liveHlsProxyCnbcSource"`
	LiveHLSProxyCnbcUpstreamURL  string             `json:"liveHlsProxyCnbcUpstreamUrl"`
	LiveHLSProxyCnbcReferer      string             `json:"liveHlsProxyCnbcReferer"`
	LiveHLSProxyCnbcAllowedHosts []string           `json:"liveHlsProxyCnbcAllowedHosts"`
}

// EffectiveSettings is EffectiveSituationMonitorSettings.
type EffectiveSettings struct {
	TranslationMaxConcurrency     int
	TranslationAPIEnabled         bool
	TranslationAPIBaseURL         string
	TranslationAPIKey             string
	TranslationFallbackAPIEnabled bool
	TranslationFallbackAPIBaseURL string
	FinnhubAPIKey                 string
	FredAPIKey                    string
	TranslationAPITimeoutMS       int
	TranslationAPIMaxRetries      int
	TelegramEnabled               bool
	TelegramAPIID                 string
	TelegramAPIHash               string
	TelegramSession               string
	TelegramChannelSet            string
	TelegramMaxFeedItems          int
	TelegramMaxTextChars          int
	TelegramChannelTimeoutMS      int
	TelegramPollCycleTimeoutMS    int
	TelegramStartupDelayMS        int
	TelegramRateLimitMS           int
	TelegramPollIntervalMS        int
	LiveHLSProxyCnnUpstreamURL    *string
	LiveHLSProxyCnnReferer        *string
	LiveHLSProxyCnnAllowedHosts   []string
	LiveHLSProxyCnbcUpstreamURL   *string
	LiveHLSProxyCnbcReferer       *string
	LiveHLSProxyCnbcAllowedHosts  []string
}

// storedValue is the exact document written to SystemSetting.value by both
// implementations. Secrets are either a plain string or a system-settings:v1
// envelope, so they stay json.RawMessage; every other field is concrete.
type storedValue struct {
	TranslationMaxConcurrency     int             `json:"translationMaxConcurrency"`
	TranslationAPIEnabled         bool            `json:"translationApiEnabled"`
	TranslationAPIBaseURL         *string         `json:"translationApiBaseUrl"`
	TranslationAPIKey             json.RawMessage `json:"translationApiKey"`
	TranslationFallbackAPIEnabled bool            `json:"translationFallbackApiEnabled"`
	TranslationFallbackAPIBaseURL *string         `json:"translationFallbackApiBaseUrl"`
	FinnhubAPIKey                 json.RawMessage `json:"finnhubApiKey"`
	FredAPIKey                    json.RawMessage `json:"fredApiKey"`
	TranslationAPITimeoutMS       int             `json:"translationApiTimeoutMs"`
	TranslationAPIMaxRetries      int             `json:"translationApiMaxRetries"`
	TelegramEnabled               bool            `json:"telegramEnabled"`
	TelegramAPIID                 *string         `json:"telegramApiId"`
	TelegramAPIHash               json.RawMessage `json:"telegramApiHash"`
	TelegramSession               json.RawMessage `json:"telegramSession"`
	TelegramChannelSet            string          `json:"telegramChannelSet"`
	TelegramMaxFeedItems          int             `json:"telegramMaxFeedItems"`
	TelegramMaxTextChars          int             `json:"telegramMaxTextChars"`
	TelegramChannelTimeoutMS      int             `json:"telegramChannelTimeoutMs"`
	TelegramPollCycleTimeoutMS    int             `json:"telegramPollCycleTimeoutMs"`
	TelegramStartupDelayMS        int             `json:"telegramStartupDelayMs"`
	TelegramRateLimitMS           int             `json:"telegramRateLimitMs"`
	TelegramPollIntervalMS        int             `json:"telegramPollIntervalMs"`
	LiveHLSProxyCnnUpstreamURL    *string         `json:"liveHlsProxyCnnUpstreamUrl"`
	LiveHLSProxyCnnReferer        *string         `json:"liveHlsProxyCnnReferer"`
	LiveHLSProxyCnnAllowedHosts   []string        `json:"liveHlsProxyCnnAllowedHosts"`
	LiveHLSProxyCnbcUpstreamURL   *string         `json:"liveHlsProxyCnbcUpstreamUrl"`
	LiveHLSProxyCnbcReferer       *string         `json:"liveHlsProxyCnbcReferer"`
	LiveHLSProxyCnbcAllowedHosts  []string        `json:"liveHlsProxyCnbcAllowedHosts"`
}

// storedFields is the read projection. Every member stays raw so the loose
// NestJS `unknown` reads (Number(), typeof, Array.isArray, encrypted envelope)
// can be reproduced field by field.
type storedFields struct {
	TranslationMaxConcurrency     json.RawMessage `json:"translationMaxConcurrency"`
	TranslationAPIEnabled         json.RawMessage `json:"translationApiEnabled"`
	TranslationAPIBaseURL         json.RawMessage `json:"translationApiBaseUrl"`
	TranslationAPIKey             json.RawMessage `json:"translationApiKey"`
	TranslationFallbackAPIEnabled json.RawMessage `json:"translationFallbackApiEnabled"`
	TranslationFallbackAPIBaseURL json.RawMessage `json:"translationFallbackApiBaseUrl"`
	FinnhubAPIKey                 json.RawMessage `json:"finnhubApiKey"`
	FredAPIKey                    json.RawMessage `json:"fredApiKey"`
	TranslationAPITimeoutMS       json.RawMessage `json:"translationApiTimeoutMs"`
	TranslationAPIMaxRetries      json.RawMessage `json:"translationApiMaxRetries"`
	TelegramEnabled               json.RawMessage `json:"telegramEnabled"`
	TelegramAPIID                 json.RawMessage `json:"telegramApiId"`
	TelegramAPIHash               json.RawMessage `json:"telegramApiHash"`
	TelegramSession               json.RawMessage `json:"telegramSession"`
	TelegramChannelSet            json.RawMessage `json:"telegramChannelSet"`
	TelegramMaxFeedItems          json.RawMessage `json:"telegramMaxFeedItems"`
	TelegramMaxTextChars          json.RawMessage `json:"telegramMaxTextChars"`
	TelegramChannelTimeoutMS      json.RawMessage `json:"telegramChannelTimeoutMs"`
	TelegramPollCycleTimeoutMS    json.RawMessage `json:"telegramPollCycleTimeoutMs"`
	TelegramStartupDelayMS        json.RawMessage `json:"telegramStartupDelayMs"`
	TelegramRateLimitMS           json.RawMessage `json:"telegramRateLimitMs"`
	TelegramPollIntervalMS        json.RawMessage `json:"telegramPollIntervalMs"`
	LiveHLSProxyCnnUpstreamURL    json.RawMessage `json:"liveHlsProxyCnnUpstreamUrl"`
	LiveHLSProxyCnnReferer        json.RawMessage `json:"liveHlsProxyCnnReferer"`
	LiveHLSProxyCnnAllowedHosts   json.RawMessage `json:"liveHlsProxyCnnAllowedHosts"`
	LiveHLSProxyCnbcUpstreamURL   json.RawMessage `json:"liveHlsProxyCnbcUpstreamUrl"`
	LiveHLSProxyCnbcReferer       json.RawMessage `json:"liveHlsProxyCnbcReferer"`
	LiveHLSProxyCnbcAllowedHosts  json.RawMessage `json:"liveHlsProxyCnbcAllowedHosts"`
}

// loadedSettings is one request-scoped read: whether the row exists, its raw
// document (for spread-preserving writes) and the loose projection.
type loadedSettings struct {
	// exists reports that the SystemSetting row (or the cache envelope's
	// exists flag) is present. It is what the cache envelope records.
	exists bool
	// stored reports that the row/cache held an object-like JSON document,
	// which is what NestJS treats as `stored` for `source` and for the
	// `stored?.field` reads. `exists && !stored` means a row with a scalar or
	// null value and resolves to the environment defaults.
	stored bool
	raw    json.RawMessage
	fields storedFields
}

// settingsResponse is the controller's withExternalSnapshotStatus shape:
// `{...payload, externalSnapshotStatus, qualitySummary}`.
type settingsResponse struct {
	PublicSettings
	ExternalSnapshotStatus json.RawMessage `json:"externalSnapshotStatus"`
	QualitySummary         json.RawMessage `json:"qualitySummary"`
}

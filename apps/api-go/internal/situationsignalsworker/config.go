package situationsignalsworker

import (
	"math"
	"strconv"
	"strings"
)

// Environment defaults and lower bounds mirror
// apps/api/src/modules/config/env.schema.ts and the readNumberEnv(..., min)
// calls in situation-monitor-signals.service.ts. The zod schema gives almost
// every variable a default, so the resolved values are the same whether the
// variable is unset or empty.
const (
	defaultTelegramChannelSet         = "full"
	defaultTelegramMaxFeedItems       = 200
	defaultTelegramMaxTextChars       = 800
	defaultTelegramChannelTimeoutMS   = 15_000
	defaultTelegramPollCycleTimeoutMS = 180_000
	defaultTelegramStartupDelayMS     = 60_000
	defaultTelegramRateLimitMS        = 800
	defaultTelegramPollIntervalMS     = 60_000
	minTelegramMaxFeedItems           = 50
	minTelegramMaxTextChars           = 200
	minTelegramChannelTimeoutMS       = 3_000
	minTelegramPollCycleTimeoutMS     = 30_000
	minTelegramStartupDelayMS         = 0
	minTelegramRateLimitMS            = 100
	minTelegramPollIntervalMS         = 15_000

	defaultOrefAlertsURL          = "https://www.oref.org.il/WarningMessages/alert/alerts.json"
	defaultOrefHistoryURL         = "https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json"
	defaultOrefHistoryRetention   = 7
	defaultOrefHistoryMaxWaves    = 200
	defaultOrefCurlTimeoutSeconds = 15
	defaultOrefBootstrapRetries   = 3
	defaultOrefPollIntervalMS     = 300_000
	minOrefHistoryRetention       = 1
	minOrefHistoryMaxWaves        = 10
	minOrefCurlTimeoutSeconds     = 5
	minOrefBootstrapRetries       = 1
	minOrefPollIntervalMS         = 30_000
)

// Env is the environment-derived configuration of the signals worker.
//
// Telegram runtime configuration normally comes from the effective settings
// row (SettingsProvider); this struct only supplies the fallback NestJS uses
// when that read fails. OREF configuration is environment-only, exactly like
// NestJS. Every field is resolved and bounded by NewEnvFromLookup, so a zero
// Env can be safely expanded with applyDefaults.
type Env struct {
	// Telegram fallback, mirroring getTelegramRuntimeConfig's catch branch.
	TelegramEnabled            bool
	TelegramAPIID              string
	TelegramAPIHash            string
	TelegramChannelSet         string
	TelegramMaxFeedItems       int
	TelegramMaxTextChars       int
	TelegramChannelTimeoutMS   int
	TelegramPollCycleTimeoutMS int
	TelegramStartupDelayMS     int
	TelegramRateLimitMS        int
	TelegramPollIntervalMS     int

	// OREF, read directly from the environment by the NestJS service.
	OrefEnabled            bool
	OrefProxyAuth          string
	OrefAlertsURL          string
	OrefHistoryURL         string
	OrefHistoryRetention   int
	OrefHistoryMaxWaves    int
	OrefCurlTimeoutSeconds int
	OrefBootstrapRetries   int
	OrefPollIntervalMS     int
}

// NewEnvFromLookup resolves the environment values the same way the NestJS
// EnvService + service helpers do.
//
// Semantics mirrored from readStringEnv/readNumberEnv/readBooleanEnv:
//   - string values are trimmed, and an empty value means "unset";
//   - numbers go through JavaScript Number(), fall back on NaN/Infinity and are
//     then floored and clamped to the documented lower bound (the zod schema
//     has no upper bound for these variables, so neither does this parser);
//   - booleans accept the envBoolean spellings (true/false, 1/0, yes/no, y/n,
//     on/off) with surrounding whitespace and mixed case.
func NewEnvFromLookup(lookup func(string) (string, bool)) Env {
	if lookup == nil {
		lookup = func(string) (string, bool) { return "", false }
	}
	return Env{
		TelegramEnabled:            readBooleanEnv(lookup, "SITUATION_MONITOR_TELEGRAM_ENABLED", false),
		TelegramAPIID:              firstNonEmptyEnv(lookup, "SITUATION_MONITOR_TELEGRAM_API_ID", "TELEGRAM_API_ID"),
		TelegramAPIHash:            firstNonEmptyEnv(lookup, "SITUATION_MONITOR_TELEGRAM_API_HASH", "TELEGRAM_API_HASH"),
		TelegramChannelSet:         readChannelSetEnv(lookup),
		TelegramMaxFeedItems:       readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS", defaultTelegramMaxFeedItems, minTelegramMaxFeedItems),
		TelegramMaxTextChars:       readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS", defaultTelegramMaxTextChars, minTelegramMaxTextChars),
		TelegramChannelTimeoutMS:   readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS", defaultTelegramChannelTimeoutMS, minTelegramChannelTimeoutMS),
		TelegramPollCycleTimeoutMS: readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS", defaultTelegramPollCycleTimeoutMS, minTelegramPollCycleTimeoutMS),
		TelegramStartupDelayMS:     readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_STARTUP_DELAY_MS", defaultTelegramStartupDelayMS, minTelegramStartupDelayMS),
		TelegramRateLimitMS:        readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_RATE_LIMIT_MS", defaultTelegramRateLimitMS, minTelegramRateLimitMS),
		TelegramPollIntervalMS:     readNumberEnv(lookup, "SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS", defaultTelegramPollIntervalMS, minTelegramPollIntervalMS),

		OrefEnabled:            readBooleanEnv(lookup, "SITUATION_MONITOR_OREF_ENABLED", false),
		OrefProxyAuth:          firstNonEmptyEnv(lookup, "SITUATION_MONITOR_OREF_PROXY_AUTH", "OREF_PROXY_AUTH"),
		OrefAlertsURL:          readStringEnv(lookup, "SITUATION_MONITOR_OREF_ALERTS_URL", defaultOrefAlertsURL),
		OrefHistoryURL:         readStringEnv(lookup, "SITUATION_MONITOR_OREF_HISTORY_URL", defaultOrefHistoryURL),
		OrefHistoryRetention:   readNumberEnv(lookup, "SITUATION_MONITOR_OREF_HISTORY_RETENTION_DAYS", defaultOrefHistoryRetention, minOrefHistoryRetention),
		OrefHistoryMaxWaves:    readNumberEnv(lookup, "SITUATION_MONITOR_OREF_HISTORY_MAX_WAVES", defaultOrefHistoryMaxWaves, minOrefHistoryMaxWaves),
		OrefCurlTimeoutSeconds: readNumberEnv(lookup, "SITUATION_MONITOR_OREF_CURL_TIMEOUT_SEC", defaultOrefCurlTimeoutSeconds, minOrefCurlTimeoutSeconds),
		OrefBootstrapRetries:   readNumberEnv(lookup, "SITUATION_MONITOR_OREF_BOOTSTRAP_MAX_RETRIES", defaultOrefBootstrapRetries, minOrefBootstrapRetries),
		OrefPollIntervalMS:     readNumberEnv(lookup, "SITUATION_MONITOR_OREF_POLL_INTERVAL_MS", defaultOrefPollIntervalMS, minOrefPollIntervalMS),
	}
}

// applyDefaults fills the values a zero Env would otherwise leave unset. It is
// only a safety net for hand-built Env values: NewEnvFromLookup always returns
// a fully populated struct.
func (e Env) applyDefaults() Env {
	defaults := Env{
		TelegramChannelSet:         defaultTelegramChannelSet,
		TelegramMaxFeedItems:       defaultTelegramMaxFeedItems,
		TelegramMaxTextChars:       defaultTelegramMaxTextChars,
		TelegramChannelTimeoutMS:   defaultTelegramChannelTimeoutMS,
		TelegramPollCycleTimeoutMS: defaultTelegramPollCycleTimeoutMS,
		TelegramStartupDelayMS:     defaultTelegramStartupDelayMS,
		TelegramRateLimitMS:        defaultTelegramRateLimitMS,
		TelegramPollIntervalMS:     defaultTelegramPollIntervalMS,
		OrefAlertsURL:              defaultOrefAlertsURL,
		OrefHistoryURL:             defaultOrefHistoryURL,
		OrefHistoryRetention:       defaultOrefHistoryRetention,
		OrefHistoryMaxWaves:        defaultOrefHistoryMaxWaves,
		OrefCurlTimeoutSeconds:     defaultOrefCurlTimeoutSeconds,
		OrefBootstrapRetries:       defaultOrefBootstrapRetries,
		OrefPollIntervalMS:         defaultOrefPollIntervalMS,
	}
	if strings.TrimSpace(e.TelegramChannelSet) == "" {
		e.TelegramChannelSet = defaults.TelegramChannelSet
	}
	if e.TelegramMaxFeedItems <= 0 {
		e.TelegramMaxFeedItems = defaults.TelegramMaxFeedItems
	}
	if e.TelegramMaxTextChars <= 0 {
		e.TelegramMaxTextChars = defaults.TelegramMaxTextChars
	}
	if e.TelegramChannelTimeoutMS <= 0 {
		e.TelegramChannelTimeoutMS = defaults.TelegramChannelTimeoutMS
	}
	if e.TelegramPollCycleTimeoutMS <= 0 {
		e.TelegramPollCycleTimeoutMS = defaults.TelegramPollCycleTimeoutMS
	}
	if e.TelegramStartupDelayMS < 0 {
		e.TelegramStartupDelayMS = defaults.TelegramStartupDelayMS
	}
	if e.TelegramRateLimitMS <= 0 {
		e.TelegramRateLimitMS = defaults.TelegramRateLimitMS
	}
	if e.TelegramPollIntervalMS <= 0 {
		e.TelegramPollIntervalMS = defaults.TelegramPollIntervalMS
	}
	if strings.TrimSpace(e.OrefAlertsURL) == "" {
		e.OrefAlertsURL = defaults.OrefAlertsURL
	}
	if strings.TrimSpace(e.OrefHistoryURL) == "" {
		e.OrefHistoryURL = defaults.OrefHistoryURL
	}
	if e.OrefHistoryRetention <= 0 {
		e.OrefHistoryRetention = defaults.OrefHistoryRetention
	}
	if e.OrefHistoryMaxWaves <= 0 {
		e.OrefHistoryMaxWaves = defaults.OrefHistoryMaxWaves
	}
	if e.OrefCurlTimeoutSeconds <= 0 {
		e.OrefCurlTimeoutSeconds = defaults.OrefCurlTimeoutSeconds
	}
	if e.OrefBootstrapRetries <= 0 {
		e.OrefBootstrapRetries = defaults.OrefBootstrapRetries
	}
	if e.OrefPollIntervalMS <= 0 {
		e.OrefPollIntervalMS = defaults.OrefPollIntervalMS
	}
	return e
}

// readStringEnv mirrors readStringEnv for one canonical key with a zod default:
// the trimmed value wins when it is non-empty, otherwise the documented default.
func readStringEnv(lookup func(string) (string, bool), key, fallback string) string {
	if raw, ok := lookup(key); ok {
		if trimmed := strings.TrimSpace(raw); trimmed != "" {
			return trimmed
		}
	}
	return fallback
}

// readChannelSetEnv mirrors the telegramChannelSet read. The canonical
// variable has a zod default, so an absent variable resolves to "full" and
// shadows the alias; an explicitly empty canonical value falls through to
// TELEGRAM_CHANNEL_SET exactly like readStringEnv over the validated config.
func readChannelSetEnv(lookup func(string) (string, bool)) string {
	raw, ok := lookup("SITUATION_MONITOR_TELEGRAM_CHANNEL_SET")
	if !ok {
		return defaultTelegramChannelSet
	}
	if trimmed := strings.TrimSpace(raw); trimmed != "" {
		return trimmed
	}
	if alias, ok := lookup("TELEGRAM_CHANNEL_SET"); ok {
		if trimmed := strings.TrimSpace(alias); trimmed != "" {
			return trimmed
		}
	}
	return defaultTelegramChannelSet
}

// firstNonEmptyEnv mirrors readStringEnv over several keys: the first key with a
// non-empty trimmed value wins. It is used for the optional API_ID/API_HASH
// pair, where the schema has no default and the legacy alias is a real fallback.
func firstNonEmptyEnv(lookup func(string) (string, bool), keys ...string) string {
	for _, key := range keys {
		if raw, ok := lookup(key); ok {
			if trimmed := strings.TrimSpace(raw); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

// readBooleanEnv mirrors readBooleanEnv for a single canonical key whose zod
// default exists: the default applies whenever the variable is unset or empty.
func readBooleanEnv(lookup func(string) (string, bool), key string, fallback bool) bool {
	raw, ok := lookup(key)
	if !ok {
		return fallback
	}
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	}
	return fallback
}

// readNumberEnv mirrors readNumberEnv(key, fallback, min): Number(raw),
// fallback on NaN/Infinity, otherwise trunc and max(min, value).
func readNumberEnv(lookup func(string) (string, bool), key string, fallback, min int) int {
	raw, ok := lookup(key)
	value := parseJSNumber(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return clampNumber(fallback, min)
	}
	return clampNumber(int(math.Trunc(value)), min)
}

// clampNumber mirrors Math.max(min, value).
func clampNumber(value, min int) int {
	if value < min {
		return min
	}
	return value
}

// parseJSNumber mirrors JavaScript Number() for the string forms an environment
// variable can carry: empty and whitespace-only strings are 0, Infinity is
// accepted (callers reject it), hexadecimal/octal/binary literals are parsed,
// and anything else is NaN.
func parseJSNumber(raw string) float64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0
	}
	switch strings.ToLower(trimmed) {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	if len(trimmed) > 2 && trimmed[0] == '0' {
		switch trimmed[1] {
		case 'x', 'X':
			if value, err := strconv.ParseUint(trimmed[2:], 16, 64); err == nil {
				return float64(value)
			}
			return math.NaN()
		case 'o', 'O':
			if value, err := strconv.ParseUint(trimmed[2:], 8, 64); err == nil {
				return float64(value)
			}
			return math.NaN()
		case 'b', 'B':
			if value, err := strconv.ParseUint(trimmed[2:], 2, 64); err == nil {
				return float64(value)
			}
			return math.NaN()
		}
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return math.NaN()
	}
	return value
}

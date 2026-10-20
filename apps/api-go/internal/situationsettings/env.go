package situationsettings

import (
	"math"
	"strconv"
	"strings"
)

// Env is the environment-derived half of the effective configuration. Every
// field mirrors one EnvService getter (or zod default) consumed by
// SituationMonitorSettingsService.resolveEffectiveConfig.
type Env struct {
	TranslationAPIEnabled         bool
	TranslationAPIBaseURL         string
	TranslationAPITimeoutMS       int
	TranslationAPIMaxRetries      int
	TranslationFallbackAPIEnabled bool
	TranslationFallbackAPIBaseURL string

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

	OrefEnabled      bool
	OrefProxyAuth    string
	EncryptionKeyRaw string
	NodeEnv          string
}

// EncryptionKeyPresent mirrors the NestJS `if (!raw)` test: an empty string is
// absent, while whitespace-only is present and later fails decoding.
func (e Env) EncryptionKeyPresent() bool { return e.EncryptionKeyRaw != "" }

// NewEnvFromLookup resolves the environment defaults exactly like
// EnvService.situationMonitorTranslationConfig, resolveTelegramEnvDefaults and
// the two OREF reads.
//
// The NestJS schema gives most variables a zod default, so the SITUATION_MONITOR_*
// name always wins and the TELEGRAM_* aliases only participate where the schema
// entry is optional (API_ID / API_HASH). Values the zod schema would reject
// cannot reach a running NestJS process; they fall back to the documented
// default here instead of failing the Go request.
func NewEnvFromLookup(lookup func(string) (string, bool)) Env {
	env := Env{
		TranslationAPIEnabled:         boolEnv(lookup, "SITUATION_MONITOR_TRANSLATION_API_ENABLED", true),
		TranslationAPIBaseURL:         normalizeEnvBaseURL(stringEnv(lookup, "SITUATION_MONITOR_TRANSLATION_API_BASE_URL"), defaultTranslationAPIBaseURL),
		TranslationAPITimeoutMS:       clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS"), defaultTranslationAPITimeoutMS, minTranslationAPITimeoutMS, maxTranslationAPITimeoutMS),
		TranslationAPIMaxRetries:      clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TRANSLATION_MAX_RETRIES"), defaultTranslationAPIMaxRetries, minTranslationAPIMaxRetries, maxTranslationAPIMaxRetries),
		TranslationFallbackAPIEnabled: boolEnv(lookup, "SITUATION_MONITOR_TRANSLATION_FALLBACK_API_ENABLED", defaultTranslationFallbackEnabled),
		TranslationFallbackAPIBaseURL: normalizeEnvBaseURL(stringEnv(lookup, "SITUATION_MONITOR_TRANSLATION_FALLBACK_API_BASE_URL"), ""),

		TelegramEnabled:            boolEnv(lookup, "SITUATION_MONITOR_TELEGRAM_ENABLED", false),
		TelegramAPIID:              firstNonEmptyEnv(lookup, "SITUATION_MONITOR_TELEGRAM_API_ID", "TELEGRAM_API_ID"),
		TelegramAPIHash:            firstNonEmptyEnv(lookup, "SITUATION_MONITOR_TELEGRAM_API_HASH", "TELEGRAM_API_HASH"),
		TelegramChannelSet:         channelSetEnv(lookup),
		TelegramMaxFeedItems:       clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS"), defaultTelegramMaxFeedItems, minTelegramMaxFeedItems, maxTelegramMaxFeedItems),
		TelegramMaxTextChars:       clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS"), defaultTelegramMaxTextChars, minTelegramMaxTextChars, maxTelegramMaxTextChars),
		TelegramChannelTimeoutMS:   clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS"), defaultTelegramChannelTimeoutMS, minTelegramChannelTimeoutMS, maxTelegramChannelTimeoutMS),
		TelegramPollCycleTimeoutMS: clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS"), defaultTelegramPollCycleTimeoutMS, minTelegramPollCycleTimeoutMS, maxTelegramPollCycleTimeoutMS),
		TelegramStartupDelayMS:     clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_STARTUP_DELAY_MS"), defaultTelegramStartupDelayMS, minTelegramStartupDelayMS, maxTelegramStartupDelayMS),
		TelegramRateLimitMS:        clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_RATE_LIMIT_MS"), defaultTelegramRateLimitMS, minTelegramRateLimitMS, maxTelegramRateLimitMS),
		TelegramPollIntervalMS:     clampEnvInt(stringEnv(lookup, "SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS"), defaultTelegramPollIntervalMS, minTelegramPollIntervalMS, maxTelegramPollIntervalMS),

		OrefEnabled:      boolEnv(lookup, "SITUATION_MONITOR_OREF_ENABLED", false),
		OrefProxyAuth:    orefProxyAuthEnv(lookup),
		EncryptionKeyRaw: stringEnv(lookup, "SYSTEM_SETTINGS_ENCRYPTION_KEY"),
		NodeEnv:          stringEnv(lookup, "NODE_ENV"),
	}
	return env
}

// stringEnv returns the raw value and ignores absence; unlike firstNonEmptyEnv
// it does not trim.
func stringEnv(lookup func(string) (string, bool), key string) string {
	value, _ := lookup(key)
	return value
}

// boolEnv mirrors readBooleanEnv for a single canonical key: a real boolean
// (the validated schema value) or the documented string spellings.
func boolEnv(lookup func(string) (string, bool), key string, fallback bool) bool {
	raw, ok := lookup(key)
	if !ok {
		return fallback
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	}
	return fallback
}

// clampEnvInt mirrors readNumberEnv: Number(raw), NaN keeps the fallback,
// otherwise truncate and clamp.
func clampEnvInt(raw string, fallback, min, max int) int {
	if strings.TrimSpace(raw) == "" {
		return clampInt(fallback, min, max)
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return clampInt(fallback, min, max)
	}
	return clampInt(int(math.Trunc(parsed)), min, max)
}

// normalizeEnvBaseURL mirrors the EnvService getter: trim, strip trailing
// slashes, and use the fallback when the result is empty.
func normalizeEnvBaseURL(raw, fallback string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

// firstNonEmptyEnv mirrors readStringEnv: the first key with a non-empty
// trimmed value wins.
func firstNonEmptyEnv(lookup func(string) (string, bool), keys ...string) string {
	for _, key := range keys {
		value, ok := lookup(key)
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

// channelSetEnv mirrors readStringEnv over the canonical key and the legacy
// alias. The zod default makes the canonical name win when it is unset; an
// explicitly empty canonical value falls through to the alias.
func channelSetEnv(lookup func(string) (string, bool)) string {
	canonical, ok := lookup("SITUATION_MONITOR_TELEGRAM_CHANNEL_SET")
	if !ok {
		return defaultTelegramChannelSet
	}
	if trimmed := strings.TrimSpace(canonical); trimmed != "" {
		return trimmed
	}
	if alias, ok := lookup("TELEGRAM_CHANNEL_SET"); ok {
		if trimmed := strings.TrimSpace(alias); trimmed != "" {
			return trimmed
		}
	}
	return defaultTelegramChannelSet
}

// orefProxyAuthEnv mirrors the nullish-coalescing pair in getPublicSettings:
// the canonical variable (even when empty) shadows OREF_PROXY_AUTH.
func orefProxyAuthEnv(lookup func(string) (string, bool)) string {
	if value, ok := lookup("SITUATION_MONITOR_OREF_PROXY_AUTH"); ok {
		return strings.TrimSpace(value)
	}
	if value, ok := lookup("OREF_PROXY_AUTH"); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

// clampInt mirrors Math.max(min, Math.min(max, value)).
func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

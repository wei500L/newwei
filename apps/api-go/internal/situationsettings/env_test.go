package situationsettings

import "testing"

func lookupFrom(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestNewEnvDefaults(t *testing.T) {
	env := NewEnvFromLookup(lookupFrom(nil))
	if !env.TranslationAPIEnabled || env.TranslationAPIBaseURL != "https://api.deeplx.org" ||
		env.TranslationAPITimeoutMS != 15_000 || env.TranslationAPIMaxRetries != 2 ||
		env.TranslationFallbackAPIEnabled {
		t.Fatalf("translation env = %+v", env)
	}
	if env.TelegramEnabled || env.TelegramChannelSet != "full" || env.TelegramMaxFeedItems != 200 ||
		env.TelegramMaxTextChars != 800 || env.TelegramChannelTimeoutMS != 15_000 ||
		env.TelegramPollCycleTimeoutMS != 180_000 || env.TelegramStartupDelayMS != 60_000 ||
		env.TelegramRateLimitMS != 800 || env.TelegramPollIntervalMS != 60_000 {
		t.Fatalf("telegram env = %+v", env)
	}
	if env.OrefEnabled || env.OrefProxyAuth != "" || env.EncryptionKeyPresent() {
		t.Fatalf("oref env = %+v", env)
	}
}

func TestNewEnvParsesValuesAndClamps(t *testing.T) {
	env := NewEnvFromLookup(lookupFrom(map[string]string{
		"SITUATION_MONITOR_TRANSLATION_API_ENABLED":   "no",
		"SITUATION_MONITOR_TRANSLATION_API_BASE_URL":  " https://example.test/api/ ",
		"SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS":    "999999",
		"SITUATION_MONITOR_TRANSLATION_MAX_RETRIES":   "9",
		"SITUATION_MONITOR_TELEGRAM_ENABLED":          "yes",
		"SITUATION_MONITOR_TELEGRAM_CHANNEL_SET":      " tech ",
		"SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS":   "1",
		"SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS":   "999999",
		"SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS": "1000",
		"SITUATION_MONITOR_OREF_ENABLED":              "on",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY":              "  ",
		"NODE_ENV":                                    "production",
	}))
	if env.TranslationAPIEnabled {
		t.Fatal("translation enabled should be false")
	}
	if env.TranslationAPIBaseURL != "https://example.test/api" {
		t.Fatalf("base url = %q", env.TranslationAPIBaseURL)
	}
	if env.TranslationAPITimeoutMS != 120_000 || env.TranslationAPIMaxRetries != 5 {
		t.Fatalf("translation clamps = %+v", env)
	}
	if !env.TelegramEnabled || env.TelegramChannelSet != "tech" {
		t.Fatalf("telegram = %+v", env)
	}
	if env.TelegramMaxFeedItems != 50 || env.TelegramMaxTextChars != 10_000 || env.TelegramPollIntervalMS != 15_000 {
		t.Fatalf("telegram clamps = %+v", env)
	}
	if !env.OrefEnabled || !env.EncryptionKeyPresent() || env.NodeEnv != "production" {
		t.Fatalf("oref/key = %+v", env)
	}
}

func TestTelegramAliases(t *testing.T) {
	env := NewEnvFromLookup(lookupFrom(map[string]string{
		"TELEGRAM_API_ID":   "12345",
		"TELEGRAM_API_HASH": "abcdef",
	}))
	if env.TelegramAPIID != "12345" || env.TelegramAPIHash != "abcdef" {
		t.Fatalf("aliases = %+v", env)
	}

	// The canonical name wins when both are set.
	env = NewEnvFromLookup(lookupFrom(map[string]string{
		"SITUATION_MONITOR_TELEGRAM_API_ID":   "canonical",
		"TELEGRAM_API_ID":                     "alias",
		"SITUATION_MONITOR_TELEGRAM_API_HASH": "canonical-hash",
		"TELEGRAM_API_HASH":                   "alias-hash",
	}))
	if env.TelegramAPIID != "canonical" || env.TelegramAPIHash != "canonical-hash" {
		t.Fatalf("canonical = %+v", env)
	}

	// The zod default makes an unset canonical channel set win over the alias.
	env = NewEnvFromLookup(lookupFrom(map[string]string{"TELEGRAM_CHANNEL_SET": "alias"}))
	if env.TelegramChannelSet != "full" {
		t.Fatalf("channel set = %q", env.TelegramChannelSet)
	}
	// An explicitly empty canonical value falls through to the alias.
	env = NewEnvFromLookup(lookupFrom(map[string]string{
		"SITUATION_MONITOR_TELEGRAM_CHANNEL_SET": "",
		"TELEGRAM_CHANNEL_SET":                   "alias",
	}))
	if env.TelegramChannelSet != "alias" {
		t.Fatalf("channel set = %q", env.TelegramChannelSet)
	}
}

func TestOrefProxyAuthCanonicalShadowsAlias(t *testing.T) {
	env := NewEnvFromLookup(lookupFrom(map[string]string{
		"SITUATION_MONITOR_OREF_PROXY_AUTH": "",
		"OREF_PROXY_AUTH":                   "alias",
	}))
	if env.OrefProxyAuth != "" {
		t.Fatalf("canonical empty must shadow the alias: %q", env.OrefProxyAuth)
	}
	env = NewEnvFromLookup(lookupFrom(map[string]string{"OREF_PROXY_AUTH": " alias "}))
	if env.OrefProxyAuth != "alias" {
		t.Fatalf("alias = %q", env.OrefProxyAuth)
	}
}

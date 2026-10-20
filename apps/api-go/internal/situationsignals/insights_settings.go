package situationsignals

import (
	"context"
	"encoding/json"
	"math"
	"strings"
)

const (
	insightsDefaultTranslationConcurrency = 2
	insightsDefaultTranslationTimeoutMS   = 15_000
	insightsDefaultTranslationRetries     = 2
	insightsDefaultTranslationBaseURL     = "https://api.deeplx.org"
)

type insightsTranslationRuntime struct {
	Provider        string
	MaxConcurrency  int
	Enabled         bool
	BaseURL         string
	APIKey          string
	FallbackEnabled bool
	FallbackBaseURL string
	TimeoutMS       int
	MaxRetries      int
}

// getTranslationRuntime mirrors SituationMonitorSettingsService.getTranslationRuntimeConfig.
func (s *insightsService) getTranslationRuntime(ctx context.Context) (insightsTranslationRuntime, error) {
	stored, err := s.settings.loadStored(ctx)
	if err != nil {
		return insightsTranslationRuntime{}, err
	}
	envEnabled := s.settings.booleanEnv("SITUATION_MONITOR_TRANSLATION_API_ENABLED", true)
	envBaseURL := insightsNormalizeURL(s.settings.stringEnv("SITUATION_MONITOR_TRANSLATION_API_BASE_URL"))
	envFallbackBaseURL := insightsNormalizeURL(s.settings.stringEnv("SITUATION_MONITOR_TRANSLATION_FALLBACK_API_BASE_URL"))
	envFallbackEnabled := s.settings.booleanEnv("SITUATION_MONITOR_TRANSLATION_FALLBACK_API_ENABLED", false)
	envTimeout := s.settings.boundedIntEnv("SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS", insightsDefaultTranslationTimeoutMS, 1000, 120000)
	envRetries := s.settings.boundedIntEnv("SITUATION_MONITOR_TRANSLATION_MAX_RETRIES", insightsDefaultTranslationRetries, 0, 5)

	config := insightsTranslationRuntime{
		Provider:        "deeplx",
		MaxConcurrency:  insightsDefaultTranslationConcurrency,
		Enabled:         envEnabled,
		BaseURL:         firstInsightsNonEmpty(envBaseURL, insightsDefaultTranslationBaseURL),
		FallbackEnabled: envFallbackEnabled,
		FallbackBaseURL: envFallbackBaseURL,
		TimeoutMS:       envTimeout,
		MaxRetries:      envRetries,
	}
	if stored == nil {
		return config, nil
	}
	config.MaxConcurrency = storedBoundedInt(stored.TranslationMaxConcurrency, insightsDefaultTranslationConcurrency, 1, 5000)
	if value, ok := stored.rawBoolean(stored.TranslationAPIEnabled); ok {
		config.Enabled = value
	}
	config.BaseURL = firstInsightsNonEmpty(insightsNormalizeURL(storedString(stored.TranslationAPIBaseURL)), envBaseURL, insightsDefaultTranslationBaseURL)
	if value, ok := stored.rawBoolean(stored.TranslationFallbackAPIEnabled); ok {
		config.FallbackEnabled = value
	}
	config.FallbackBaseURL = firstInsightsNonEmpty(insightsNormalizeURL(storedString(stored.TranslationFallbackAPIBaseURL)), envFallbackBaseURL)
	config.TimeoutMS = storedBoundedInt(stored.TranslationAPITimeoutMS, envTimeout, 1000, 120000)
	config.MaxRetries = storedBoundedInt(stored.TranslationAPIMaxRetries, envRetries, 0, 5)
	config.APIKey = s.settings.storedSecret(stored, func(settings *storedSituationMonitorSettings) rawJSON {
		return settings.TranslationAPIKey
	})
	return config, nil
}

// finnhubAPIKey and fredAPIKey implement F1: the stored SystemSetting value
// wins, then the container environment. This mirrors the effective provider
// credentials the admin UI reports.
func (s *insightsService) finnhubAPIKey(ctx context.Context) string {
	if s.finnhubKeyResolver != nil {
		return s.finnhubKeyResolver(ctx)
	}
	return s.externalAPIKey(ctx, func(settings *storedSituationMonitorSettings) rawJSON {
		return settings.FinnhubAPIKey
	}, "FINNHUB_API_KEY")
}

func (s *insightsService) fredAPIKey(ctx context.Context) string {
	if s.fredKeyResolver != nil {
		return s.fredKeyResolver(ctx)
	}
	return s.externalAPIKey(ctx, func(settings *storedSituationMonitorSettings) rawJSON {
		return settings.FredAPIKey
	}, "FRED_API_KEY")
}

func (s *insightsService) externalAPIKey(ctx context.Context, pick func(*storedSituationMonitorSettings) rawJSON, envKey string) string {
	stored, err := s.settings.loadStored(ctx)
	if err == nil && stored != nil {
		if value := s.settings.storedSecret(stored, pick); value != "" {
			return value
		}
	}
	return strings.TrimSpace(s.settings.stringEnv(envKey))
}

func (s *insightsService) isGdeltEnabled() bool {
	return s.settings.booleanEnv("SITUATION_MONITOR_GDELT_ENABLED", true)
}

func (s *settingsReader) boundedIntEnv(key string, fallback, min, max int) int {
	if s == nil || s.lookup == nil {
		return fallback
	}
	value, ok := s.lookup(key)
	if !ok {
		return fallback
	}
	parsed, valid := insightsInt(value)
	if !valid {
		return fallback
	}
	if parsed < min {
		return min
	}
	if parsed > max {
		return max
	}
	return parsed
}

// storedBoundedInt mirrors asBoundedInt: Number(value), Math.round, clamp; an
// absent member uses the fallback. JSON null becomes Number(null)=0 and is
// clamped to the lower bound, exactly like NestJS.
func storedBoundedInt(value rawJSON, fallback, min, max int) int {
	if len(value.raw) == 0 {
		return fallback
	}
	number, ok := jsNumber(value.raw, true)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	rounded := int(math.Trunc(number))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

func storedString(value rawJSON) string {
	if text, ok := value.asString(); ok {
		return text
	}
	return ""
}

func (s *storedSituationMonitorSettings) rawBoolean(value rawJSON) (bool, bool) {
	if len(value.raw) == 0 || strings.TrimSpace(string(value.raw)) == "null" {
		return false, false
	}
	var parsed bool
	if err := json.Unmarshal(value.raw, &parsed); err != nil {
		return false, false
	}
	return parsed, true
}

func insightsNormalizeURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

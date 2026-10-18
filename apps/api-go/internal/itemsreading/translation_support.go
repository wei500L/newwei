package itemsreading

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
)

// This file exposes the narrow, strongly typed port the RSS translation chain
// reads: the resolved DeepLX/fallback runtime and the provider status list. The
// status list is already exported through RssTranslationStatus; the runtime is
// added here because the status computation only needed the enabled/URL/key
// flags while the request path also needs the timeout, retry budget and
// concurrency limit. No private helper is exported and the items HTTP surface
// stays closed.

// TranslationRuntimeConfig is the resolved Situation Monitor translation
// runtime. The values follow the NestJS stored -> env -> default precedence and
// the NestJS bounds: timeout 1000..120000 ms, retries 0..5, concurrency
// 1..5000. The API key is already decrypted with the shared
// SYSTEM_SETTINGS_ENCRYPTION_KEY envelope.
type TranslationRuntimeConfig struct {
	Enabled         bool
	BaseURL         string
	APIKey          string
	FallbackEnabled bool
	FallbackBaseURL string
	TimeoutMs       int
	MaxRetries      int
	MaxConcurrency  int
}

// TranslationRuntime resolves the DeepLX/fallback runtime for the RSS
// translation request path. A settings read failure is returned so the caller
// can keep the NestJS error level instead of silently degrading.
func (s *Service) TranslationRuntime(ctx context.Context) (TranslationRuntimeConfig, error) {
	return s.translationRuntimeConfig(ctx)
}

// translationStoredIntDefault mirrors asBoundedInt stored -> env -> default:
// the env value is bounded first, then a stored numeric overrides it and is
// bounded again. A missing or non-numeric stored value keeps the env default.
func translationStoredIntDefault(raw json.RawMessage, envName string, fallback, min, max int) int {
	envValue := clampTranslationInt(envIntDefaultValue(envName, fallback), min, max)
	return clampTranslationInt(jsNumericTrunc(raw, envValue), min, max)
}

// envIntDefaultValue reads a positive integer environment variable. An empty or
// unparsable value falls back exactly like the NestJS env schema default.
func envIntDefaultValue(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

// clampTranslationInt applies the NestJS Math.max(min, Math.min(max, value)).
func clampTranslationInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// jsNumericTrunc mirrors `Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback`.
// A JSON null is 0, a boolean is 0/1, a string is parsed like Number(), and an
// absent, array or object value is not finite and keeps the fallback.
func jsNumericTrunc(raw json.RawMessage, fallback int) int {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return fallback
	}
	switch trimmed {
	case "null":
		return 0
	case "true":
		return 1
	case "false":
		return 0
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return fallback
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return fallback
		}
		return int(math.Trunc(parsed))
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		return fallback
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return int(math.Trunc(parsed))
}

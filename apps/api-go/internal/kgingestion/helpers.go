package kgingestion

import (
	"errors"
	"time"
	"unicode/utf16"
)

// errCompleterUnavailable reports a missing model completer. The NestJS quality
// path never reaches this state because LiteLlmService is always injected; the
// Go wiring fails the startup instead of running half configured, so this only
// guards direct construction in tests.
var errCompleterUnavailable = errors.New("knowledge graph model completer is not configured")

// errServiceUnavailable reports a half-built service. The production wiring
// fails startup before this can happen.
var errServiceUnavailable = errors.New("knowledge graph ingestion service is not configured")

// errInvalidSettingsCache reports a Redis settings document that is not valid
// JSON. The read falls back to MySQL exactly like CacheService.get throwing.
var errInvalidSettingsCache = errors.New("knowledge graph settings cache is not valid JSON")

// errInvalidValidationResponse reports a model response that does not satisfy
// the relation validation schema.
var errInvalidValidationResponse = errors.New("Invalid validation response")

// formatISO8601Millis renders a time exactly like Date.prototype.toISOString.
func formatISO8601Millis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// truncateUTF16 mirrors String.prototype.slice(value, 0, limit) for the
// non-negative limits this package uses: the count is UTF-16 code units, not
// runes.
func truncateUTF16(value string, limit int) string {
	if limit < 0 {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

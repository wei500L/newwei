package dashboardstats

import (
	"regexp"
	"strings"
)

// NestJS DashboardService.stats maps every queued task log through
// redactSensitiveFields (apps/api/src/modules/queue/queue.service.ts), because a
// failure message can embed an authorization header or a DSN. This file is the
// same 9-pattern list from packages/utils/src/error-sanitizer.ts, kept in order:
// each pattern scans the output of the previous one.
const redactedMarker = "[REDACTED]"

var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)password\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)token\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)apiKey\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)api_key\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)secret\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)credential\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)auth\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)bearer\s+[a-zA-Z0-9._-]+`),
	regexp.MustCompile(`(?i)basic\s+[a-zA-Z0-9+/=]+`),
}

// redactSensitiveFields mirrors the TS helper: a match that contains a
// key/value separator keeps "key=" (or "key:") and drops the value; a
// bearer/basic prefix keeps its scheme word; anything else becomes the marker.
func redactSensitiveFields(input string) string {
	result := input
	for _, pattern := range sensitivePatterns {
		result = pattern.ReplaceAllStringFunc(result, redactMatch)
	}
	return result
}

func redactMatch(match string) string {
	if index := strings.IndexAny(match, "=:"); index >= 0 {
		return match[:index+1] + redactedMarker
	}
	if len(match) >= len("bearer") && strings.EqualFold(match[:len("bearer")], "bearer") {
		return "Bearer " + redactedMarker
	}
	if len(match) >= len("basic") && strings.EqualFold(match[:len("basic")], "basic") {
		return "Basic " + redactedMarker
	}
	return redactedMarker
}

package crawlmetadata

import (
	"regexp"
	"strings"
)

// This file ports apps/api/src/modules/crawl/deep-discovery-failure.ts: the
// `[SEED_DEEP_*] message detail` parser used by the news-source preview to turn a
// deep-discovery failure into a preview warning, plus the two Redis cache keys
// the failure state and the 24h statistics use.

const (
	// DeepDiscoveryUnknownErrorCode is DEEP_DISCOVERY_UNKNOWN_ERROR_CODE.
	DeepDiscoveryUnknownErrorCode = "SEED_DEEP_UNKNOWN"
	// DeepDiscoveryFailureStateTTLSeconds is the state cache TTL (7 days).
	DeepDiscoveryFailureStateTTLSeconds = 7 * 24 * 60 * 60
	// DeepDiscoveryFailureStatsTTLSeconds is the statistics cache TTL (24h).
	DeepDiscoveryFailureStatsTTLSeconds = 24 * 60 * 60
)

// DeepDiscoveryErrorInfo is DeepDiscoveryErrorInfo.
type DeepDiscoveryErrorInfo struct {
	Code       string
	Message    string
	Detail     string
	RawMessage string
}

// DeepDiscoveryFailureState is DeepDiscoveryFailureState.
type DeepDiscoveryFailureState struct {
	Streak           int
	LastFailureAt    string
	LastCode         string
	LastMessage      string
	LastDetail       string
	RetryAt          string
	NextRunAt        string
	CircuitOpenUntil *string
}

// DeepDiscoveryFailureStats24h is DeepDiscoveryFailureStats24h.
type DeepDiscoveryFailureStats24h struct {
	Total     int
	ByCode    map[string]int
	UpdatedAt string
}

var (
	deepExceptionPrefix = regexp.MustCompile(`^[A-Z][A-Za-z\s]+Exception:\s*`)
	deepErrorHeader     = regexp.MustCompile(`^\[([A-Z0-9_]+)\]\s*([\s\S]*)$`)
	deepLineBreak       = regexp.MustCompile(`\r?\n`)
	deepDetailMarkers   = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\s(?:Adjust|Refine|Tighten)\b`),
		regexp.MustCompile(`(?i)\sdiscovered=`),
	}
)

// DeepDiscoveryFailureStateCacheKey is deepDiscoveryFailureStateCacheKey.
func DeepDiscoveryFailureStateCacheKey(sourceID string) string {
	return "news-source:deep-failure:state:" + sourceID
}

// DeepDiscoveryFailureStatsCacheKey is deepDiscoveryFailureStatsCacheKey.
func DeepDiscoveryFailureStatsCacheKey(sourceID string) string {
	return "news-source:deep-failure:stats24h:" + sourceID
}

// ParseDeepDiscoveryError ports parseDeepDiscoveryError. It returns ok=false
// when the error text is not a `[SEED_DEEP_*]` failure.
func ParseDeepDiscoveryError(err error) (DeepDiscoveryErrorInfo, bool) {
	if err == nil {
		return DeepDiscoveryErrorInfo{}, false
	}
	rawMessage := normalizeRawDeepErrorMessage(err.Error())
	if rawMessage == "" {
		return DeepDiscoveryErrorInfo{}, false
	}
	matched := deepErrorHeader.FindStringSubmatch(rawMessage)
	if matched == nil {
		return DeepDiscoveryErrorInfo{}, false
	}
	code := matched[1]
	if !strings.HasPrefix(code, "SEED_DEEP_") {
		return DeepDiscoveryErrorInfo{}, false
	}
	body := strings.TrimSpace(matched[2])
	if body == "" {
		return DeepDiscoveryErrorInfo{Code: code, Message: rawMessage, RawMessage: rawMessage}, true
	}
	message, detail := splitDeepErrorBody(body)
	if message == "" {
		message = body
	}
	info := DeepDiscoveryErrorInfo{Code: code, Message: message, RawMessage: rawMessage}
	if strings.TrimSpace(detail) != "" {
		info.Detail = strings.TrimSpace(detail)
	}
	return info, true
}

func normalizeRawDeepErrorMessage(raw string) string {
	return strings.TrimSpace(deepExceptionPrefix.ReplaceAllString(raw, ""))
}

func splitDeepErrorBody(body string) (string, string) {
	lines := []string{}
	for _, line := range deepLineBreak.Split(body, -1) {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) > 1 {
		return lines[0], strings.Join(lines[1:], " ")
	}
	firstMatch := -1
	for _, pattern := range deepDetailMarkers {
		location := pattern.FindStringIndex(body)
		if location == nil || location[0] <= 0 {
			continue
		}
		if firstMatch == -1 || location[0] < firstMatch {
			firstMatch = location[0]
		}
	}
	if firstMatch == -1 {
		return strings.TrimSpace(body), ""
	}
	return strings.TrimSpace(body[:firstMatch]), strings.TrimSpace(body[firstMatch:])
}

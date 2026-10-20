package newssources

import (
	"regexp"
	"strings"
)

// This file ports the query-parameter allowlist normalization of
// packages/utils/src/url-canonical.ts (DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
// normalizeUrlQueryParamAllowlist, parseAllowlistInput, normalizeParamKey). The
// canonicalizer itself is not ported: the news-source preview only stores the
// resolved allowlist in its seed response.

// DefaultURLQueryParamAllowlist is DEFAULT_URL_QUERY_PARAM_ALLOWLIST.
var DefaultURLQueryParamAllowlist = []string{
	"id", "story", "article", "post", "item", "p", "page", "v", "ver", "lang", "locale", "hl",
}

const (
	maxURLQueryParamAllowlistSize = 64
	maxQueryParamKeyLength        = 64
)

var queryParamKeyPattern = regexp.MustCompile(`^[a-z0-9_.-]+$`)

// NormalizeURLQueryParamAllowlist ports normalizeUrlQueryParamAllowlist.
func NormalizeURLQueryParamAllowlist(value any, fallback []string) []string {
	if value != nil {
		return normalizeAllowlistEntries(parseAllowlistInput(value))
	}
	return normalizeAllowlistEntries(parseAllowlistInput(fallback))
}

func normalizeAllowlistEntries(input []string) []string {
	normalized := []string{}
	seen := map[string]bool{}
	for _, entry := range input {
		key := normalizeParamKey(entry)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		normalized = append(normalized, key)
		if len(normalized) >= maxURLQueryParamAllowlistSize {
			break
		}
	}
	return normalized
}

func parseAllowlistInput(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, entry := range typed {
			if text, ok := entry.(string); ok {
				out = append(out, text)
			}
		}
		return out
	case string:
		out := []string{}
		for _, part := range regexp.MustCompile(`[,\n]`).Split(typed, -1) {
			trimmed := strings.TrimSpace(part)
			if trimmed != "" {
				out = append(out, trimmed)
			}
		}
		return out
	default:
		return nil
	}
}

func normalizeParamKey(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" || len(trimmed) > maxQueryParamKeyLength {
		return ""
	}
	if !queryParamKeyPattern.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

// resolveQueryParamAllowlist ports resolveQueryParamAllowlist with the default
// fallback.
func resolveQueryParamAllowlist(value any) []string {
	return NormalizeURLQueryParamAllowlist(value, DefaultURLQueryParamAllowlist)
}

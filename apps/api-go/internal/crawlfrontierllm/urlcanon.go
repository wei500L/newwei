package crawlfrontierllm

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strings"
)

// This file ports packages/utils/src/url-canonical.ts
// (canonicalizeUrlWithQueryAllowlist + normalizeUrlQueryParamAllowlist) and
// apps/api/src/modules/crawl/url-fingerprint.ts buildCanonicalUrlFingerprint.
// The values it produces are the dedup keys materialization writes, so the
// normalization order (hash, credentials, host case, path slashes, default
// ports, then the sorted allowlisted query) matches the TypeScript source.

// DefaultURLQueryParamAllowlist is DEFAULT_URL_QUERY_PARAM_ALLOWLIST.
var DefaultURLQueryParamAllowlist = []string{
	"id", "story", "article", "post", "item", "p", "page", "v", "ver", "lang", "locale", "hl",
}

const maxURLQueryParamAllowlistSize = 64

// NormalizeURLQueryParamAllowlist mirrors normalizeUrlQueryParamAllowlist.
func NormalizeURLQueryParamAllowlist(raw []string, fallback []string) []string {
	input := raw
	if input == nil {
		input = fallback
	}
	out := make([]string, 0, len(input))
	seen := map[string]struct{}{}
	for _, entry := range input {
		key := normalizeQueryParamKey(entry)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
		if len(out) >= maxURLQueryParamAllowlistSize {
			break
		}
	}
	return out
}

func normalizeQueryParamKey(value string) string {
	trimmed := strings.ToLower(jsTrim(value))
	if trimmed == "" || len(trimmed) > 64 {
		return ""
	}
	for _, char := range trimmed {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_' || char == '.' || char == '-' {
			continue
		}
		return ""
	}
	return trimmed
}

// CanonicalURL is buildCanonicalUrlFingerprint's result.
type CanonicalURL struct {
	CanonicalURL string
	Fingerprint  string
}

// BuildCanonicalURLFingerprint mirrors buildCanonicalUrlFingerprint. A value
// without a parseable http(s) URL returns nil.
func BuildCanonicalURLFingerprint(value string, allowlist []string) *CanonicalURL {
	canonical := CanonicalizeURLWithQueryAllowlist(value, allowlist)
	if canonical == "" {
		return nil
	}
	sum := sha256.Sum256([]byte(canonical))
	return &CanonicalURL{CanonicalURL: canonical, Fingerprint: hex.EncodeToString(sum[:])}
}

// CanonicalizeURLWithQueryAllowlist mirrors canonicalizeUrlWithQueryAllowlist.
func CanonicalizeURLWithQueryAllowlist(value string, allowlist []string) string {
	parsed, ok := parseHTTPURL(value)
	if !ok {
		return ""
	}
	effective := NormalizeURLQueryParamAllowlist(allowlist, DefaultURLQueryParamAllowlist)
	allowed := map[string]struct{}{}
	for _, key := range effective {
		allowed[key] = struct{}{}
	}

	parsed.Fragment = ""
	parsed.User = nil
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Path = normalizeURLPath(parsed.Path)
	if parsed.Scheme == "http" && parsed.Port() == "80" {
		parsed.Host = parsed.Hostname()
	}
	if parsed.Scheme == "https" && parsed.Port() == "443" {
		parsed.Host = parsed.Hostname()
	}
	parsed.RawQuery = normalizedSearch(parsed.Query(), allowed)
	parsed.ForceQuery = false
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String()
}

func parseHTTPURL(value string) (*url.URL, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return nil, false
	}
	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		trimmed = "https://" + trimmed
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	if parsed.Hostname() == "" {
		return nil, false
	}
	return parsed, true
}

func normalizeURLPath(value string) string {
	collapsed := value
	for strings.Contains(collapsed, "//") {
		collapsed = strings.ReplaceAll(collapsed, "//", "/")
	}
	if collapsed == "/" || collapsed == "" {
		return "/"
	}
	return strings.TrimRight(collapsed, "/")
}

func normalizedSearch(values url.Values, allowed map[string]struct{}) string {
	if len(allowed) == 0 {
		return ""
	}
	type pair struct{ key, value string }
	accepted := make([]pair, 0, len(values))
	for rawKey, entries := range values {
		key := normalizeQueryParamKey(rawKey)
		if key == "" {
			continue
		}
		if _, ok := allowed[key]; !ok {
			continue
		}
		for _, entry := range entries {
			accepted = append(accepted, pair{key: key, value: entry})
		}
	}
	sort.SliceStable(accepted, func(left, right int) bool {
		if accepted[left].key != accepted[right].key {
			return accepted[left].key < accepted[right].key
		}
		return accepted[left].value < accepted[right].value
	})
	ordered := url.Values{}
	for _, entry := range accepted {
		ordered.Add(entry.key, entry.value)
	}
	return ordered.Encode()
}

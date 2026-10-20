package newssourcescheduler

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strings"

	"golang.org/x/net/idna"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// This file ports packages/utils/src/url-canonical.ts and
// apps/api/src/modules/crawl/url-fingerprint.ts: canonicalizeUrlWithQueryAllowlist,
// buildCanonicalUrlFingerprint and resolveQueryParamAllowlist. The canonical URL
// and the SHA-256 fingerprint of its UTF-8 bytes are what Article,
// PipelineJob.urlFingerprint and the dispatch dedupe sets key on, so the
// normalization order matters:
//
//  1. add https:// when the value has no scheme, reject non-http(s);
//  2. drop credentials, the fragment, redundant slashes, dot segments and the
//     trailing slash (except "/");
//  3. lower-case the host, punycode it, drop the scheme's default port;
//  4. keep only allowlisted query keys, normalize each key, then re-serialize
//     the accepted pairs sorted by key and value using the root collation that
//     Intl.Collator (Node's default ICU locale) uses.
//
// The query pair ordering is compared with x/text/collate root, because
// JavaScript's default localeCompare is ICU root and byte order splits
// punctuated keys differently (same reason as the seed candidate ordering in
// discovery.go).

// defaultURLQueryParamAllowlist is DEFAULT_URL_QUERY_PARAM_ALLOWLIST.
func defaultURLQueryParamAllowlist() []string {
	return append([]string(nil), newssources.DefaultURLQueryParamAllowlist...)
}

// resolveQueryParamAllowlist is resolveQueryParamAllowlist: nil/undefined keeps
// the fallback, anything else is normalized on its own.
func resolveQueryParamAllowlist(value any) []string {
	return newssources.NormalizeURLQueryParamAllowlist(value, newssources.DefaultURLQueryParamAllowlist)
}

// normalizeSeedQueryParamAllowlist is
// normalizeSeedQueryParamAllowlist: the source override with an empty fallback,
// so an explicit [] strips every query parameter.
func normalizeSeedQueryParamAllowlist(value any) []string {
	return newssources.NormalizeURLQueryParamAllowlist(value, []string{})
}

// rootCollator builds a collator for Intl.Collator's default root behaviour.
// Callers must not share the value across goroutines.
func rootCollator() *collate.Collator {
	return collate.New(language.Und)
}

// localeCompare is a.localeCompare(b) under the default ICU root collation.
func localeCompare(left, right string) int {
	if left == right {
		return 0
	}
	return rootCollator().CompareString(left, right)
}

// buildCanonicalURLFingerprint is buildCanonicalUrlFingerprint.
func buildCanonicalURLFingerprint(value string, allowlistInput any) (canonicalURL string, fingerprint string, ok bool) {
	canonical, ok := canonicalizeURLWithQueryAllowlist(value, allowlistInput)
	if !ok {
		return "", "", false
	}
	sum := sha256.Sum256([]byte(canonical))
	return canonical, hex.EncodeToString(sum[:]), true
}

// canonicalizeURLWithQueryAllowlist is canonicalizeUrlWithQueryAllowlist.
func canonicalizeURLWithQueryAllowlist(value string, allowlistInput any) (string, bool) {
	parsed, ok := parseHTTPURL(value)
	if !ok {
		return "", false
	}
	allowlist := resolveQueryParamAllowlist(allowlistInput)
	allowed := make(map[string]bool, len(allowlist))
	for _, key := range allowlist {
		allowed[key] = true
	}

	host := strings.ToLower(parsed.Hostname())
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		host = ascii
	}
	port := parsed.Port()
	if parsed.Scheme == "http" && port == "80" {
		port = ""
	}
	if parsed.Scheme == "https" && port == "443" {
		port = ""
	}

	path := normalizeCanonicalPath(parsed.EscapedPath())
	query := normalizeCanonicalSearch(parsed.RawQuery, allowed)

	var builder strings.Builder
	builder.WriteString(parsed.Scheme)
	builder.WriteString("://")
	builder.WriteString(host)
	if port != "" {
		builder.WriteString(":")
		builder.WriteString(port)
	}
	builder.WriteString(path)
	if query != "" {
		builder.WriteString("?")
		builder.WriteString(query)
	}
	return builder.String(), true
}

// parseHTTPURL is parseHttpUrl: a missing scheme defaults to https://, and only
// http/https survive.
func parseHTTPURL(value string) (*url.URL, bool) {
	trimmed := trimJS(value)
	if trimmed == "" {
		return nil, false
	}
	withProtocol := trimmed
	lowered := strings.ToLower(trimmed)
	if !strings.HasPrefix(lowered, "http://") && !strings.HasPrefix(lowered, "https://") {
		withProtocol = "https://" + trimmed
	}
	parsed, err := url.Parse(withProtocol)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	if parsed.Hostname() == "" {
		return nil, false
	}
	// The JS canonicalizer clears the fragment and the credentials outright.
	parsed.Fragment = ""
	parsed.RawFragment = ""
	parsed.User = nil
	return parsed, true
}

// normalizeCanonicalPath ports normalizePathname after the WHATWG parser has
// already resolved dot segments: collapse repeated slashes and drop the
// trailing slash unless the path is exactly "/".
func normalizeCanonicalPath(escapedPath string) string {
	path := escapedPath
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")
	resolved := make([]string, 0, len(segments))
	for index, segment := range segments {
		if segment == "" {
			// Collapse empty segments produced by "//"; the leading empty
			// segment (index 0) is the path's absolute marker and is kept.
			if index == 0 {
				resolved = append(resolved, "")
			}
			continue
		}
		if segment == "." {
			continue
		}
		if segment == ".." {
			if len(resolved) > 1 {
				resolved = resolved[:len(resolved)-1]
			}
			continue
		}
		resolved = append(resolved, segment)
	}
	if len(resolved) == 0 {
		return "/"
	}
	normalized := strings.Join(resolved, "/")
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	if normalized == "/" {
		return "/"
	}
	return strings.TrimRight(normalized, "/")
}

// normalizeCanonicalSearch keeps the allowlisted pairs, normalizes their keys
// and re-serializes them as application/x-www-form-urlencoded, sorted by key and
// then value with the root collation.
func normalizeCanonicalSearch(rawQuery string, allowed map[string]bool) string {
	if len(allowed) == 0 {
		return ""
	}
	type pair struct {
		key   string
		value string
	}
	accepted := make([]pair, 0, 4)
	for _, field := range strings.Split(rawQuery, "&") {
		if field == "" {
			continue
		}
		rawKey := field
		rawValue := ""
		if index := strings.Index(field, "="); index >= 0 {
			rawKey = field[:index]
			rawValue = field[index+1:]
		}
		key := normalizeQueryParamKey(decodeFormComponent(rawKey))
		if key == "" || !allowed[key] {
			continue
		}
		accepted = append(accepted, pair{key: key, value: decodeFormComponent(rawValue)})
	}
	sort.SliceStable(accepted, func(left, right int) bool {
		if accepted[left].key != accepted[right].key {
			return localeCompare(accepted[left].key, accepted[right].key) < 0
		}
		return localeCompare(accepted[left].value, accepted[right].value) < 0
	})
	var builder strings.Builder
	for index, entry := range accepted {
		if index > 0 {
			builder.WriteString("&")
		}
		builder.WriteString(encodeFormComponent(entry.key))
		builder.WriteString("=")
		builder.WriteString(encodeFormComponent(entry.value))
	}
	return builder.String()
}

// normalizeQueryParamKey is normalizeParamKey.
func normalizeQueryParamKey(value string) string {
	trimmed := strings.ToLower(trimJS(value))
	if trimmed == "" || len(trimmed) > 64 {
		return ""
	}
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' {
			continue
		}
		return ""
	}
	return trimmed
}

// decodeFormComponent is URLSearchParams' form decoding: '+' is a space and
// %XX is the byte escape.
func decodeFormComponent(value string) string {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return strings.ReplaceAll(value, "+", " ")
	}
	return decoded
}

// encodeFormComponent is the URLSearchParams serializer: encodeURIComponent
// with spaces written as '+'.
func encodeFormComponent(value string) string {
	var builder strings.Builder
	for _, b := range []byte(value) {
		switch {
		case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
			builder.WriteByte(b)
		case b == '-', b == '_', b == '.', b == '!', b == '~', b == '*', b == '\'', b == '(', b == ')':
			builder.WriteByte(b)
		case b == ' ':
			builder.WriteByte('+')
		default:
			const hexDigits = "0123456789ABCDEF"
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[b>>4])
			builder.WriteByte(hexDigits[b&0x0f])
		}
	}
	return builder.String()
}

package crawlexecution

// This file ports apps/api/src/modules/crawl/url-fingerprint.ts
// (buildCanonicalUrlFingerprint) on top of the canonicalizer in
// packages/utils/src/url-canonical.ts. The same canonicalization is used by the
// discovery migration (internal/newssourcescheduler/urls.go); it is duplicated
// here because that helper is package-private and the result fingerprints must
// match the NestJS-written CrawlResult.sourceUrlFingerprint rows byte for byte.
//
// Normalization order:
//  1. add https:// when the value has no scheme, reject non-http(s);
//  2. drop credentials and the fragment;
//  3. lower-case and punycode the host, drop the scheme's default port;
//  4. collapse slashes, resolve dot segments, drop the trailing slash;
//  5. keep only allowlisted query keys, normalize each key, then re-serialize
//     the accepted pairs sorted by key and value with the ICU root collation.

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/net/idna"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// canonicalURL is buildCanonicalUrlFingerprint's result.
type canonicalURL struct {
	CanonicalURL string
	Fingerprint  string
}

// buildCanonicalURLFingerprint is buildCanonicalUrlFingerprint.
func buildCanonicalURLFingerprint(value string, allowlist []string) *canonicalURL {
	canonical := canonicalizeURLWithQueryAllowlist(value, allowlist)
	if canonical == "" {
		return nil
	}
	sum := sha256.Sum256([]byte(canonical))
	return &canonicalURL{CanonicalURL: canonical, Fingerprint: hex.EncodeToString(sum[:])}
}

// canonicalizeURLWithQueryAllowlist is canonicalizeUrlWithQueryAllowlist.
func canonicalizeURLWithQueryAllowlist(value string, allowlist []string) string {
	parsed, ok := parseCanonicalHTTPURL(value)
	if !ok {
		return ""
	}
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
	return builder.String()
}

func parseCanonicalHTTPURL(value string) (*url.URL, bool) {
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
	parsed.Fragment = ""
	parsed.RawFragment = ""
	parsed.User = nil
	return parsed, true
}

// normalizeCanonicalPath collapses repeated slashes, resolves dot segments and
// drops the trailing slash unless the path is exactly "/".
func normalizeCanonicalPath(escapedPath string) string {
	path := escapedPath
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")
	resolved := make([]string, 0, len(segments))
	for index, segment := range segments {
		if segment == "" {
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

// normalizeCanonicalSearch keeps allowlisted pairs, normalizes their keys and
// re-serializes them as application/x-www-form-urlencoded, sorted by key then
// value with the ICU root collation.
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
			return canonicalLocaleCompare(accepted[left].key, accepted[right].key) < 0
		}
		return canonicalLocaleCompare(accepted[left].value, accepted[right].value) < 0
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

func decodeFormComponent(value string) string {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return strings.ReplaceAll(value, "+", " ")
	}
	return decoded
}

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

func canonicalLocaleCompare(left, right string) int {
	if left == right {
		return 0
	}
	return collate.New(language.Und).CompareString(left, right)
}

// trimJS is String.prototype.trim: JS whitespace plus the BOM.
func trimJS(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\uFEFF'
	})
}

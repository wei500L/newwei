package itemsingest

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
)

// comparableURLVariants mirrors packages/mongo/src/url-comparison.ts. Only
// absolute HTTP(S) URLs produce values; every other input stores null in all
// three RawItem columns without rejecting the payload.
type comparableURLVariants struct {
	Full     string
	Base     string
	FullHash string
}

// buildComparableURLVariants normalizes an HTTP(S) URL the way the Mongoose
// pre-validate hook does: drop the fragment, lowercase the host, remove
// default ports, strip trailing slashes (except the root), keep the query for
// full and drop it for base, then hash the full variant.
func buildComparableURLVariants(value string) *comparableURLVariants {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" {
		return nil
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil
	}
	parsed.Scheme = scheme
	parsed.Fragment = ""
	parsed.Host = normalizeURLHost(parsed.Scheme, parsed.Host)

	full := normalizeComparableHTTPURL(parsed, true)
	base := normalizeComparableHTTPURL(parsed, false)
	sum := sha256.Sum256([]byte(full))
	return &comparableURLVariants{
		Full:     full,
		Base:     base,
		FullHash: hex.EncodeToString(sum[:]),
	}
}

func normalizeURLHost(scheme, host string) string {
	host = strings.ToLower(host)
	// JS URL drops the default port; Go keeps it.
	if scheme == "http" && strings.HasSuffix(host, ":80") {
		return strings.TrimSuffix(host, ":80")
	}
	if scheme == "https" && strings.HasSuffix(host, ":443") {
		return strings.TrimSuffix(host, ":443")
	}
	return host
}

func normalizeComparableHTTPURL(parsed *url.URL, keepSearch bool) string {
	copyURL := *parsed
	copyURL.Fragment = ""
	if !keepSearch {
		copyURL.RawQuery = ""
	}
	if copyURL.Path == "" {
		copyURL.Path = "/"
	}
	if copyURL.Path != "/" {
		copyURL.Path = strings.TrimRight(copyURL.Path, "/")
		if copyURL.Path == "" {
			copyURL.Path = "/"
		}
	}
	normalized := copyURL.String()
	if strings.HasSuffix(normalized, "/") && copyURL.Path == "/" {
		return normalized[:len(normalized)-1]
	}
	return normalized
}

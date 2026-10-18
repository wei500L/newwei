package newssources

import "context"

// ValidateOutboundTargetURL exposes the existing news-source SSRF check to
// other packages that must fetch a caller-supplied URL (crawl metadata page
// fetch and sitemap discovery). It is a thin wrapper around validateSourceURL
// and changes none of its rules: http/https only, no localhost variations, no
// private/reserved IP literal, no cloud metadata host or path, plus a DNS
// lookup whose failure is tolerated exactly like validateSsrfUrlAsync's default
// allowUnresolved behavior.
//
// The first return value is the rejection reason (empty when allowed) and the
// second reports whether the target is allowed.
func ValidateOutboundTargetURL(ctx context.Context, raw string) (string, bool) {
	return validateSourceURL(ctx, raw)
}

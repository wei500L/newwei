package crawlmetadata

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// validateSafeURL mirrors the IsSafeUrl validator: the synchronous scheme,
// hostname, private-IP and cloud-metadata rules first, then the DNS-backed
// check. It reuses the news-source SSRF helper instead of copying the rules.
func validateSafeURL(ctx context.Context, raw string) (string, bool) {
	reason, ok := newssources.ValidateOutboundTargetURL(ctx, raw)
	if ok {
		return "", true
	}
	if reason == "" {
		reason = "URL is not safe (potential SSRF vulnerability)"
	}
	return reason, false
}

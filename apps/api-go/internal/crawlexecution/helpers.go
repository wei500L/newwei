package crawlexecution

// This file ports apps/api/src/modules/crawl/crawl-execution.helpers.ts (the URL
// helpers the anti-bot and detail-expansion branches use) plus the small sleep.

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// maxAPISideRedirectHops is MAX_API_SIDE_REDIRECT_HOPS.
const maxAPISideRedirectHops = 5

// blockedDetailPathSegments is BLOCKED_DETAIL_PATH_SEGMENTS.
var blockedDetailPathSegments = map[string]struct{}{
	"video": {}, "videos": {}, "photo": {}, "photos": {}, "pictures": {},
	"gallery": {}, "graphics": {}, "podcast": {}, "podcasts": {}, "tag": {},
	"tags": {}, "topic": {}, "topics": {}, "section": {}, "sections": {},
	"author": {}, "authors": {}, "archive": {}, "latest": {}, "live": {},
	"newsletter": {}, "newsletters": {}, "country": {}, "countries": {},
	"special-report": {}, "special-reports": {}, "europe-poll-of-polls": {},
	"poll-of-polls": {},
}

// articleLeadPathSegments is ARTICLE_LEAD_PATH_SEGMENTS.
var articleLeadPathSegments = map[string]struct{}{
	"article": {}, "articles": {}, "news": {}, "story": {}, "stories": {},
}

// normalizeComparableURL is normalizeComparableUrl: clear the hash, drop a
// trailing slash (except "/") and re-serialize.
func normalizeComparableURL(value string) string {
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	path := parsed.Path
	for len(path) > 1 && strings.HasSuffix(path, "/") {
		path = strings.TrimSuffix(path, "/")
	}
	parsed.Path = path
	parsed.RawPath = ""
	return parsed.String()
}

// getRootDomain is getRootDomain: the last two hostname labels.
func getRootDomain(hostname string) string {
	normalized := strings.ToLower(strings.TrimSpace(hostname))
	parts := make([]string, 0, 4)
	for _, entry := range strings.Split(normalized, ".") {
		if entry != "" {
			parts = append(parts, entry)
		}
	}
	if len(parts) <= 2 {
		return normalized
	}
	return strings.Join(parts[len(parts)-2:], ".")
}

// isBlockedDetailPathSegment is isBlockedDetailPathSegment.
func isBlockedDetailPathSegment(segment string) bool {
	if segment == "" {
		return false
	}
	if _, blocked := blockedDetailPathSegments[segment]; blocked {
		return true
	}
	return strings.HasSuffix(segment, "-newsletter") ||
		strings.HasSuffix(segment, "-newsletters") ||
		strings.HasSuffix(segment, "-special-report") ||
		strings.HasSuffix(segment, "-poll-of-polls") ||
		strings.HasPrefix(segment, "newsletter-") ||
		strings.HasPrefix(segment, "country-")
}

// hasBlockedDetailPathSegments is hasBlockedDetailPathSegments.
func hasBlockedDetailPathSegments(segments []string) bool {
	for _, segment := range segments {
		if isBlockedDetailPathSegment(segment) {
			return true
		}
	}
	return false
}

// hasArticleLeadPathSegment is hasArticleLeadPathSegment.
func hasArticleLeadPathSegment(segments []string) bool {
	if len(segments) == 0 {
		return false
	}
	_, ok := articleLeadPathSegments[segments[0]]
	return ok
}

// isLikelyPathCategoryToken is isLikelyPathCategoryToken.
func isLikelyPathCategoryToken(value string) bool {
	compact := strings.ToLower(strings.TrimSpace(value))
	if compact == "" {
		return false
	}
	if _, blocked := blockedDetailPathSegments[compact]; blocked {
		return true
	}
	return compact == "overview" || compact == "all" || compact == "index" ||
		strings.HasSuffix(compact, "-index") || strings.HasSuffix(compact, "-overview")
}

// urlMatchesPattern is urlMatchesPattern: a /regex/ pattern, a wildcard pattern
// or a substring test, all case-insensitive.
func urlMatchesPattern(targetURL, pattern string) bool {
	normalizedPattern := strings.TrimSpace(pattern)
	if normalizedPattern == "" {
		return false
	}
	normalizedURL := strings.ToLower(targetURL)
	loweredPattern := strings.ToLower(normalizedPattern)
	if strings.HasPrefix(loweredPattern, "/") && strings.HasSuffix(loweredPattern, "/") && len(loweredPattern) > 2 {
		body := normalizedPattern[1 : len(normalizedPattern)-1]
		if compiled, err := regexp.Compile("(?i)" + body); err == nil {
			return compiled.MatchString(targetURL)
		}
		return strings.Contains(normalizedURL, loweredPattern)
	}
	if strings.Contains(loweredPattern, "*") {
		escaped := regexp.QuoteMeta(loweredPattern)
		escaped = strings.ReplaceAll(escaped, "\\*", ".*")
		if compiled, err := regexp.Compile("(?i)^" + escaped + "$"); err == nil {
			return compiled.MatchString(targetURL)
		}
		return false
	}
	return strings.Contains(normalizedURL, loweredPattern)
}

// urlMatchesAnyPattern is urlMatchesAnyPattern.
func urlMatchesAnyPattern(targetURL string, patterns []string) bool {
	for _, pattern := range patterns {
		if urlMatchesPattern(targetURL, pattern) {
			return true
		}
	}
	return false
}

var (
	mediaPathTokenPattern = regexp.MustCompile(`(?i)\b(video|videos|photo|photos|pictures|gallery|podcast|graphics)\b`)
	listPathTokenPattern  = regexp.MustCompile(`(?i)\b(tag|tags|topic|topics|section|sections|author|authors|archive|latest|live)\b`)
)

// isLikelyDetailArticleURL is isLikelyDetailArticleUrl.
func isLikelyDetailArticleURL(targetURL, baseURL string, requireSameDomain, allowExternalLinks bool) bool {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return false
	}
	base, baseErr := url.Parse(baseURL)
	if baseErr != nil {
		return false
	}
	sameRootDomain := getRootDomain(parsed.Hostname()) == getRootDomain(base.Hostname())
	if requireSameDomain && !sameRootDomain {
		return false
	}
	if !allowExternalLinks && !sameRootDomain {
		return false
	}

	pathname := parsed.Path
	for strings.Contains(pathname, "//") {
		pathname = strings.ReplaceAll(pathname, "//", "/")
	}
	for len(pathname) > 1 && strings.HasSuffix(pathname, "/") {
		pathname = strings.TrimSuffix(pathname, "/")
	}
	segments := make([]string, 0, 8)
	for _, entry := range strings.Split(pathname, "/") {
		if entry != "" {
			segments = append(segments, entry)
		}
	}
	if len(segments) < 2 {
		return false
	}
	segmentsLower := make([]string, len(segments))
	for index, segment := range segments {
		segmentsLower[index] = strings.ToLower(segment)
	}
	if hasBlockedDetailPathSegments(segmentsLower) {
		return false
	}
	joined := strings.Join(segmentsLower, "/")
	if mediaPathTokenPattern.MatchString(joined) {
		return false
	}
	if listPathTokenPattern.MatchString(joined) {
		return false
	}

	lastSegment := segments[len(segments)-1]
	lastSegmentLower := strings.ToLower(lastSegment)
	likelySectionTail := map[string]struct{}{
		"world": {}, "business": {}, "markets": {}, "technology": {}, "tech": {},
		"opinion": {}, "sport": {}, "sports": {}, "news": {}, "japan": {}, "us": {},
		"china": {}, "europe": {}, "ukraine": {}, "russia": {}, "latest": {},
		"archive": {},
	}

	articleDateSuffix := regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)
	reutersStyleID := regexp.MustCompile(`[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$`)
	reutersWireID := regexp.MustCompile(`(?i)(?:^|-)id[a-z0-9]{7,}$`)
	if articleDateSuffix.MatchString(lastSegment) ||
		reutersStyleID.MatchString(lastSegment) ||
		reutersWireID.MatchString(lastSegment) {
		return true
	}

	tail := segments
	if len(tail) > 3 {
		tail = tail[len(tail)-3:]
	}
	if regexp.MustCompile(`^\d{4}/\d{2}/\d{2}`).MatchString(strings.Join(tail, "/")) {
		return true
	}
	for _, segment := range segments {
		if segment == "article" || segment == "articles" {
			return true
		}
	}
	slugLike := regexp.MustCompile(`(?i)[a-z0-9]-[a-z0-9]`)
	if len(segments) >= 4 && len(lastSegment) >= 14 && slugLike.MatchString(lastSegment) {
		return true
	}
	if len(segments) >= 2 && len(lastSegment) >= 18 && slugLike.MatchString(lastSegment) &&
		!isLikelyPathCategoryToken(lastSegmentLower) {
		return true
	}
	if len(segments) >= 2 && regexp.MustCompile(`^\d{7,}$`).MatchString(lastSegment) {
		return true
	}
	if len(segments) >= 2 && regexp.MustCompile(`^[a-z0-9]{8,}$`).MatchString(lastSegmentLower) {
		if _, section := likelySectionTail[lastSegmentLower]; !section &&
			!regexp.MustCompile(`^\d+$`).MatchString(lastSegmentLower) &&
			!isLikelyPathCategoryToken(lastSegmentLower) {
			return true
		}
	}
	if len(segments) >= 3 && len(lastSegment) >= 24 && regexp.MustCompile(`(?i)[a-z0-9]`).MatchString(lastSegment) &&
		!isLikelyPathCategoryToken(lastSegmentLower) {
		return true
	}
	if len(segments) <= 3 {
		if _, section := likelySectionTail[lastSegmentLower]; section {
			return false
		}
	}
	return false
}

// sleepWithContext is the NestJS sleep with cancellation.
func sleepWithContext(ctx context.Context, duration time.Duration) {
	if duration <= 0 {
		return
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

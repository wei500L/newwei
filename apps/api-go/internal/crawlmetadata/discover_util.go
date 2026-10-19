package crawlmetadata

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// This file ports the shared discovery helpers of
// apps/api/src/modules/crawl/crawl-metadata.service.ts:1419-1979 (timestamps,
// article/hub/pagination heuristics, URL comparison, deep-link scoring) plus the
// published-at head fetch (:1676-1781). Every heuristic keeps the source's
// regular expressions and thresholds so candidate sets stay identical.

var (
	// ARTICLE_SIGNAL_PATTERN.
	articleSignalPattern = regexp.MustCompile(`(?i)/(20\d{2}/\d{1,2}/\d{1,2}/|article/|articles/|story/|stories/|content/)`)
	// DATED_ARTICLE_SLUG_PATTERN.
	datedArticleSlugPattern = regexp.MustCompile(`(?i)(?:^|/)[^/?#]+-\d{4}-\d{1,2}-\d{1,2}/?$`)
	// LIST_SIGNAL_PATTERN.
	listSignalPattern = regexp.MustCompile(`(?i)(?:[?&](?:page|p)=\d+\b|/page/\d+(?:/|$)|/(?:latest|archive|archives|index)(?:/|$))`)
	// CATEGORY_SIGNAL_PATTERN.
	categorySignalPattern = regexp.MustCompile(`(?i)/(?:section|sections|category|categories|channel|channels|desk|desks|vertical|verticals)(?:/|$)`)
	// NON_ARTICLE_SIGNAL_PATTERN.
	nonArticleSignalPattern = regexp.MustCompile(`(?i)/(?:section|sections|topic|topics|tag|tags|author|authors|profile|profiles|series|search|newsletter|newsletters|gallery|galleries|video|videos|podcast|podcasts)(?:/|$)`)
	// Media/feed extensions rejected by isLikelyArticleUrl.
	blockedURLSuffixPattern = regexp.MustCompile(`(?i)\.(?:jpg|jpeg|png|gif|webp|svg|pdf|xml|rss|atom|mp4|mp3|zip)$`)
	// Slash-dated path (parsePublishedAtFromUrl first form).
	slashDatePattern = regexp.MustCompile(`/(20\d{2})/([01]\d)/([0-3]\d)(?:/|$)`)
	// Dashed-dated path (parsePublishedAtFromUrl second form).
	dashedDatePattern = regexp.MustCompile(`(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)`)
	// Pagination path/query forms.
	paginationPathPattern  = regexp.MustCompile(`(?i)(?:^|/)page(?:/|=|\?|$)`)
	paginationQueryPattern = regexp.MustCompile(`(?i)(?:[?&])(page|p|pg|offset|start|cursor)=`)
	paginationLatestPath   = regexp.MustCompile(`(?i)/latest(?:/|$)`)
	// Hub anchor-text prefix.
	hubAnchorPattern = regexp.MustCompile(`(?i)^(latest|news|more|world|politics|business|economy)\b`)
	// Pagination anchor-text prefix.
	paginationAnchorPattern = regexp.MustCompile(`(?i)^(next|older|more|load\s*more|next\s*page|previous|prev|newer)\b`)
)

// hubPathTokens is the hubTokens set of isLikelySecondaryHubLink.
var hubPathTokens = map[string]bool{
	"latest": true, "news": true, "world": true, "politics": true,
	"business": true, "economy": true, "markets": true, "finance": true,
	"technology": true, "tech": true, "science": true, "opinion": true,
	"analysis": true, "europe": true, "international": true, "archive": true,
	"section": true, "sections": true, "topic": true, "topics": true,
}

// articleLeadSegments is the leadSegments set of isLikelyArticleUrl.
var articleLeadSegments = map[string]bool{
	"article": true, "articles": true, "news": true, "story": true, "stories": true,
}

// articleBlockedSegments is the blockedSegments set of isLikelyArticleUrl.
var articleBlockedSegments = map[string]bool{
	"video": true, "videos": true, "photo": true, "photos": true, "gallery": true,
	"podcasts": true, "podcast": true, "tag": true, "tags": true, "topic": true,
	"topics": true, "section": true, "sections": true, "author": true,
	"authors": true, "newsletter": true, "newsletters": true, "live": true,
	"latest": true, "archive": true, "category": true, "categories": true,
}

// normalizeURLForComparison implements normalizeUrlForComparison: a trimmed
// absolute URL with the fragment removed; anything unparsable is dropped.
func normalizeURLForComparison(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" {
		return "", false
	}
	parsed.Fragment = ""
	return parsed.String(), true
}

// resolveBetterTimestamp keeps the larger of two normalized timestamps.
func resolveBetterTimestamp(first, second *int64) *int64 {
	left := normalizeTimestamp(first)
	right := normalizeTimestamp(second)
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if *right > *left {
		return right
	}
	return left
}

// resolveEffectiveTimestamp prefers publishedAtTs, then crawledAtTs, else -1.
func resolveEffectiveTimestamp(publishedAtTs, crawledAtTs *int64) int64 {
	if published := normalizeTimestamp(publishedAtTs); published != nil {
		return *published
	}
	if crawled := normalizeTimestamp(crawledAtTs); crawled != nil {
		return *crawled
	}
	return -1
}

// isLikelySecondaryHubLink implements the hub heuristic.
func isLikelySecondaryHubLink(rawURL, anchorText string) bool {
	if isLikelyArticleURL(rawURL) {
		return false
	}
	normalizedText := strings.ToLower(strings.TrimSpace(anchorText))
	if hubAnchorPattern.MatchString(normalizedText) {
		return true
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	segments := pathSegments(parsed.Path)
	if len(segments) == 0 || len(segments) > 3 {
		return false
	}
	for _, segment := range segments {
		if hubPathTokens[segment] {
			return true
		}
	}
	return false
}

// isLikelyArticleURL implements isLikelyArticleUrl.
func isLikelyArticleURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	path := strings.ToLower(parsed.Path)
	if path == "" || path == "/" {
		return false
	}
	if blockedURLSuffixPattern.MatchString(path) {
		return false
	}
	segments := pathSegments(path)
	if len(segments) == 0 {
		return false
	}
	for _, segment := range segments {
		if articleLeadSegments[segment] {
			return true
		}
	}
	if parsePublishedAtFromURL(rawURL) != nil {
		return true
	}
	for _, segment := range segments {
		if articleBlockedSegments[segment] {
			return false
		}
	}
	slug := segments[len(segments)-1]
	slugParts := 0
	for _, part := range strings.Split(slug, "-") {
		if part != "" {
			slugParts++
		}
	}
	return jsLen(slug) >= 18 && slugParts >= 3
}

// pathSegments splits a pathname into trimmed lowercase non-empty segments.
func pathSegments(path string) []string {
	segments := []string{}
	for _, segment := range strings.Split(path, "/") {
		normalized := strings.ToLower(strings.TrimSpace(segment))
		if normalized != "" {
			segments = append(segments, normalized)
		}
	}
	return segments
}

// parsePublishedAtFromURL implements parsePublishedAtFromUrl: it only accepts a
// real calendar date, so a rolled-over value such as 2026-00-99 is dropped.
func parsePublishedAtFromURL(rawURL string) *int64 {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil
	}
	path := parsed.Path
	if match := slashDatePattern.FindStringSubmatch(path); match != nil {
		if ts := utcDateTimestamp(match[1], match[2], match[3]); ts != nil {
			return ts
		}
	}
	if match := dashedDatePattern.FindStringSubmatch(path); match != nil {
		if ts := utcDateTimestamp(match[1], match[2], match[3]); ts != nil {
			return ts
		}
	}
	return nil
}

func utcDateTimestamp(yearText, monthText, dayText string) *int64 {
	year, yearErr := strconv.Atoi(yearText)
	month, monthErr := strconv.Atoi(monthText)
	day, dayErr := strconv.Atoi(dayText)
	if yearErr != nil || monthErr != nil || dayErr != nil {
		return nil
	}
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return nil
	}
	parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day {
		return nil
	}
	return normalizeTimestamp(millisPtr(parsed.UnixMilli()))
}

// isLikelyPaginationLink implements the pagination heuristic.
func isLikelyPaginationLink(candidateURL, currentPageURL, anchorText, rel string) bool {
	normalizedText := strings.ToLower(strings.TrimSpace(anchorText))
	normalizedRel := strings.ToLower(strings.TrimSpace(rel))
	if strings.Contains(normalizedRel, "next") || strings.Contains(normalizedRel, "prev") {
		return true
	}
	if paginationAnchorPattern.MatchString(normalizedText) {
		return true
	}
	candidate, err := url.Parse(candidateURL)
	if err != nil {
		return false
	}
	current, err := url.Parse(currentPageURL)
	if err != nil {
		return false
	}
	if candidate.Scheme+"://"+candidate.Host != current.Scheme+"://"+current.Host {
		return false
	}
	if candidate.Path == current.Path && candidate.RawQuery == current.RawQuery {
		return false
	}
	combined := strings.ToLower(candidate.Path) + strings.ToLower("?"+candidate.RawQuery)
	if candidate.RawQuery == "" {
		combined = strings.ToLower(candidate.Path)
	}
	if paginationPathPattern.MatchString(combined) || paginationQueryPattern.MatchString(combined) {
		return true
	}
	if paginationLatestPath.MatchString(strings.ToLower(candidate.Path)) && candidate.RawQuery != "" {
		return true
	}
	return false
}

// deepNormalizedLink is normalizeDeepDiscoveryLink's result.
type deepNormalizedLink struct {
	URL        string
	AnchorText string
	Rel        string
	LinkScore  float64
}

// normalizeDeepDiscoveryLink resolves one crawl4ai link entry against the page
// URL, drops non-http(s) schemes and the fragment.
func normalizeDeepDiscoveryLink(entry crawl4ai.Link, baseURL string) (deepNormalizedLink, bool) {
	href := strings.TrimSpace(entry.Href)
	if href == "" || href == "#" || strings.HasPrefix(strings.ToLower(href), "javascript:") {
		return deepNormalizedLink{}, false
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return deepNormalizedLink{}, false
	}
	reference, err := url.Parse(href)
	if err != nil {
		return deepNormalizedLink{}, false
	}
	resolved := base.ResolveReference(reference)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return deepNormalizedLink{}, false
	}
	resolved.Fragment = ""
	anchorText := entry.Text
	if anchorText == "" {
		anchorText = entry.Title
	}
	return deepNormalizedLink{
		URL:        resolved.String(),
		AnchorText: anchorText,
		Rel:        entry.Rel,
		LinkScore:  extractDeepLinkScore(entry),
	}, true
}

// extractDeepLinkScore implements extractDeepLinkScore: total, then contextual,
// then intrinsic score, normalized to 0..1 with three decimals.
func extractDeepLinkScore(entry crawl4ai.Link) float64 {
	var raw *float64
	switch {
	case entry.TotalScore != nil:
		raw = entry.TotalScore
	case entry.ContextualScore != nil:
		raw = entry.ContextualScore
	case entry.IntrinsicScore != nil:
		raw = entry.IntrinsicScore
	}
	if raw == nil || math.IsNaN(*raw) {
		return 0
	}
	value := *raw
	switch {
	case value <= 0:
		return 0
	case value <= 1:
		return roundTo(value, 3)
	case value <= 10:
		return roundTo(value/10, 3)
	default:
		return 1
	}
}

// computeLinkRelevance implements computeLinkRelevance: the share of query
// tokens found in "url text", with three decimals. No tokens means no score.
func computeLinkRelevance(rawURL, text string, tokens []string) *float64 {
	if len(tokens) == 0 {
		return nil
	}
	haystack := strings.ToLower(rawURL + " " + text)
	hits := 0
	for _, token := range tokens {
		if strings.Contains(haystack, token) {
			hits++
		}
	}
	score := roundTo(float64(hits)/float64(len(tokens)), 3)
	return &score
}

// compareDeepCandidates implements compareDeepCandidates: newest effective
// timestamp, then link score, then relevance, then URL.
func compareDeepCandidates(left, right deepDiscoveryCandidate) int {
	leftTs := resolveEffectiveTimestamp(left.PublishedAtTs, left.CrawledAtTs)
	rightTs := resolveEffectiveTimestamp(right.PublishedAtTs, right.CrawledAtTs)
	if leftTs != rightTs {
		if rightTs > leftTs {
			return 1
		}
		return -1
	}
	if left.LinkScore != right.LinkScore {
		if right.LinkScore > left.LinkScore {
			return 1
		}
		return -1
	}
	leftRelevance := 0.0
	if left.RelevanceScore != nil {
		leftRelevance = *left.RelevanceScore
	}
	rightRelevance := 0.0
	if right.RelevanceScore != nil {
		rightRelevance = *right.RelevanceScore
	}
	if leftRelevance != rightRelevance {
		if rightRelevance > leftRelevance {
			return 1
		}
		return -1
	}
	return strings.Compare(left.URL, right.URL)
}

// sortDeepCandidates sorts in place with compareDeepCandidates.
func sortDeepCandidates(candidates []deepDiscoveryCandidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		return compareDeepCandidates(candidates[i], candidates[j]) < 0
	})
}

// trimDeepCandidates keeps the top `limit` candidates by the same ranking.
func trimDeepCandidates(candidates map[string]deepDiscoveryCandidate, limit int) {
	if len(candidates) <= limit {
		return
	}
	pool := make([]deepDiscoveryCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		pool = append(pool, candidate)
	}
	sortDeepCandidates(pool)
	if len(pool) > limit {
		pool = pool[:limit]
	}
	for key := range candidates {
		delete(candidates, key)
	}
	for _, candidate := range pool {
		candidates[candidate.URL] = candidate
	}
}

// selectDiscoveryResultArticle implements selectDiscoveryResultArticle: the
// successful result whose URL matches the requested page, else the first
// successful result, else the first result.
func selectDiscoveryResultArticle(results []crawl4ai.Article, normalizedSeedURL string) (crawl4ai.Article, bool) {
	if len(results) == 0 {
		return crawl4ai.Article{}, false
	}
	var firstSuccessful *crawl4ai.Article
	for index := range results {
		result := results[index]
		if result.Success == nil || !*result.Success {
			continue
		}
		if firstSuccessful == nil {
			firstSuccessful = &results[index]
		}
		if normalized, ok := normalizeURLForComparison(result.URL); ok && normalized == normalizedSeedURL {
			return result, true
		}
	}
	if firstSuccessful != nil {
		return *firstSuccessful, true
	}
	return results[0], true
}

// fetchPublishedAtTimestamp performs the head fetch used to fill a missing
// publishedAtTs; every failure is "no timestamp".
func (s *Service) fetchPublishedAtTimestamp(ctx context.Context, rawURL string, timeoutMs int) *int64 {
	response, err := s.fetchWithStatus(ctx, rawURL, timeoutMs, nil)
	if err != nil || !response.HasBody {
		return nil
	}
	return extractPublishedAtTimestampFromHTML(response.Body)
}

// extractPublishedAtTimestampFromHTML implements the meta/time/JSON-LD scan of
// the head.
func extractPublishedAtTimestampFromHTML(htmlBody string) *int64 {
	document, err := htmlParse(htmlBody)
	if err != nil {
		return nil
	}
	head := findFirstElement(document, "head")
	if head == nil {
		return nil
	}
	candidates := []string{}
	for _, selector := range metaPublishedAtSelectors {
		if node := findFirstMeta(head, selector.attribute, selector.value); node != nil {
			if content := strings.TrimSpace(findAttribute(node, "content")); content != "" {
				candidates = append(candidates, content)
			}
		}
	}
	for _, node := range elementDescendants(head) {
		if node.Data != "time" {
			continue
		}
		if value := strings.TrimSpace(findAttribute(node, "datetime")); value != "" {
			candidates = append(candidates, value)
			break
		}
	}
	for _, candidate := range candidates {
		if ts := parseJSTimestamp(candidate); ts != nil {
			return ts
		}
	}

	scripts := []string{}
	for _, node := range elementDescendants(head) {
		if node.Data != "script" {
			continue
		}
		if !strings.EqualFold(findAttribute(node, "type"), jsonLdScriptTypeValue) {
			continue
		}
		raw := strings.TrimSpace(nodeText(node))
		if raw == "" {
			continue
		}
		scripts = append(scripts, raw)
		if len(scripts) >= 8 {
			break
		}
	}
	for _, raw := range scripts {
		var parsed any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			continue
		}
		if found := findJSONLdDate(parsed); found != nil {
			return found
		}
	}
	return nil
}

// metaPublishedAtSelector is one (attribute, value) meta pair.
type metaPublishedAtSelector struct {
	attribute string
	value     string
}

// metaPublishedAtSelectors lists the meta tags in the source's first-match
// order.
var metaPublishedAtSelectors = []metaPublishedAtSelector{
	{"property", "article:published_time"},
	{"property", "og:published_time"},
	{"name", "pubdate"},
	{"name", "publishdate"},
	{"name", "date"},
	{"itemprop", "datePublished"},
}

// findFirstMeta returns the first meta element whose attribute equals value.
func findFirstMeta(node *html.Node, attribute, value string) *html.Node {
	for _, descendant := range elementDescendants(node) {
		if descendant.Data != "meta" {
			continue
		}
		if findAttribute(descendant, attribute) == value {
			return descendant
		}
	}
	return nil
}

// findJSONLdDate implements findJsonLdDate: datePublished, dateCreated,
// dateModified, then a recursive scan of nested values.
func findJSONLdDate(value any) *int64 {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if found := findJSONLdDate(item); found != nil {
				return found
			}
		}
		return nil
	case map[string]any:
		for _, key := range []string{"datePublished", "dateCreated", "dateModified"} {
			if text, ok := typed[key].(string); ok {
				if ts := parseJSTimestamp(text); ts != nil {
					return ts
				}
			}
		}
		for _, nested := range typed {
			if found := findJSONLdDate(nested); found != nil {
				return found
			}
		}
		return nil
	default:
		return nil
	}
}

// jsTimestampLayouts is the Date.parse subset used for published-at values.
var jsTimestampLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"2006/01/02",
	time.RFC1123,
	time.RFC1123Z,
	time.RFC850,
	time.ANSIC,
	time.RFC822,
	time.RFC822Z,
}

// parseJSTimestamp mirrors Date.parse for the timestamp spellings found in meta
// tags and JSON-LD.
func parseJSTimestamp(value string) *int64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	for _, layout := range jsTimestampLayouts {
		var (
			parsed time.Time
			err    error
		)
		switch layout {
		case time.RFC3339Nano, time.RFC3339, "2006-01-02", time.RFC1123, time.RFC1123Z,
			time.RFC850, time.RFC822, time.RFC822Z:
			parsed, err = time.Parse(layout, trimmed)
		default:
			parsed, err = time.ParseInLocation(layout, trimmed, time.Local)
		}
		if err == nil {
			return normalizeTimestamp(millisPtr(parsed.UnixMilli()))
		}
	}
	return nil
}

// truncateText implements truncateText: collapse whitespace, then cut to
// maxChars with a trailing ellipsis.
func truncateText(value *string, maxChars int) *string {
	if value == nil {
		return nil
	}
	normalized := jsTrim(collapseWhitespace(*value))
	if normalized == "" {
		return nil
	}
	if jsLen(normalized) <= maxChars {
		return &normalized
	}
	cut := sliceUTF16(normalized, maxChars-1)
	cut = strings.TrimRightFunc(cut, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	result := cut + "…"
	return &result
}

var whitespaceRun = regexp.MustCompile(`\s+`)

// collapseWhitespace implements value.replace(/\s+/g, " ").
func collapseWhitespace(value string) string {
	return whitespaceRun.ReplaceAllString(value, " ")
}

// sliceUTF16 cuts a string to at most max UTF-16 code units, mirroring
// String.prototype.slice on the code-unit index.
func sliceUTF16(value string, max int) string {
	if max <= 0 {
		return ""
	}
	units := 0
	for index, char := range value {
		width := 1
		if char > 0xFFFF {
			width = 2
		}
		if units+width > max {
			return value[:index]
		}
		units += width
	}
	return value
}

// toPrefetchedMarkdown implements toPrefetchedMarkdown: normalize newlines,
// strip HTML tags through a DOM text extraction, collapse blank lines and clamp
// to RSS_PREFETCH_MAX_MARKDOWN_CHARS.
func toPrefetchedMarkdown(value *string) *string {
	if value == nil {
		return nil
	}
	normalizedInput := strings.TrimSpace(normalizeNewlines(*value))
	if normalizedInput == "" {
		return nil
	}
	normalized := normalizedInput
	if htmlTagPattern.MatchString(normalizedInput) {
		document, err := htmlParse("<body>" + normalizedInput + "</body>")
		if err == nil {
			if body := findFirstElement(document, "body"); body != nil {
				normalized = nodeText(body)
			}
		}
	}
	collapsed := strings.TrimSpace(collapseBlankLines(normalized))
	if collapsed == "" {
		return nil
	}
	if jsLen(collapsed) <= rssPrefetchMaxMarkdownChars {
		return &collapsed
	}
	cut := strings.TrimRightFunc(sliceUTF16(collapsed, rssPrefetchMaxMarkdownChars-1), func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	result := cut + "…"
	return &result
}

var (
	htmlTagPattern   = regexp.MustCompile(`(?i)<[a-z][\s\S]*>`)
	spaceBeforeLine  = regexp.MustCompile(`[ \t]+\n`)
	blankLineRuns    = regexp.MustCompile(`\n{3,}`)
	lineBreakPattern = regexp.MustCompile(`\r\n?`)
)

func normalizeNewlines(value string) string {
	return lineBreakPattern.ReplaceAllString(value, "\n")
}

// collapseBlankLines implements `[ \t]+\n` -> "\n" then `\n{3,}` -> "\n\n".
func collapseBlankLines(value string) string {
	return blankLineRuns.ReplaceAllString(spaceBeforeLine.ReplaceAllString(value, "\n"), "\n\n")
}

// buildRSSStubMarkdown implements buildRssStubMarkdown.
func buildRSSStubMarkdown(title, description *string) *string {
	normalizedTitle := truncateText(title, rssPrefetchMaxTitleChars)
	normalizedDescription := toPrefetchedMarkdown(description)
	if normalizedTitle == nil && normalizedDescription == nil {
		return nil
	}
	sections := []string{}
	if normalizedTitle != nil {
		sections = append(sections, "# "+*normalizedTitle)
	}
	if normalizedDescription != nil {
		sections = append(sections, *normalizedDescription)
	}
	joined := strings.TrimSpace(strings.Join(sections, "\n\n"))
	if joined == "" {
		return nil
	}
	return &joined
}

// normalizeRSSFetchOptions implements normalizeRssFetchOptions.
func normalizeRSSFetchOptions(options *RSSFetchOptions) RSSFetchOptions {
	resolved := RSSFetchOptions{
		RequestTimeoutMs:   intPtrValue(15_000),
		BodySourceStrategy: RSSBodySourceContentFirst,
		NoBodyPolicy:       RSSNoBodyPolicySkip,
	}
	if options == nil {
		return resolved
	}
	if options.RequestTimeoutMs != nil {
		resolved.RequestTimeoutMs = intPtrValue(maxInt(1000, *options.RequestTimeoutMs))
	}
	switch options.BodySourceStrategy {
	case RSSBodySourceContentOnly, RSSBodySourceSummaryOnly:
		resolved.BodySourceStrategy = options.BodySourceStrategy
	}
	if options.NoBodyPolicy == RSSNoBodyPolicyTitleDescriptionStub {
		resolved.NoBodyPolicy = RSSNoBodyPolicyTitleDescriptionStub
	}
	return resolved
}

// resolveRSSPrefetchedContent implements resolveRssPrefetchedContent.
func resolveRSSPrefetchedContent(entry rssDiscoveryEntry, options RSSFetchOptions) *PrefetchedArticle {
	contentMarkdown := toPrefetchedMarkdown(entry.Content)
	descriptionMarkdown := toPrefetchedMarkdown(entry.Description)

	switch options.BodySourceStrategy {
	case RSSBodySourceContentOnly:
		if contentMarkdown != nil {
			return prefetchedArticle(entry, contentMarkdown, "content")
		}
	case RSSBodySourceSummaryOnly:
		if descriptionMarkdown != nil {
			return prefetchedArticle(entry, descriptionMarkdown, "description")
		}
	default:
		if contentMarkdown != nil {
			return prefetchedArticle(entry, contentMarkdown, "content")
		}
		if descriptionMarkdown != nil {
			return prefetchedArticle(entry, descriptionMarkdown, "description")
		}
	}

	if options.NoBodyPolicy == RSSNoBodyPolicyTitleDescriptionStub {
		if stub := buildRSSStubMarkdown(entry.Title, entry.Description); stub != nil {
			return prefetchedArticle(entry, stub, "stub")
		}
	}
	return nil
}

func prefetchedArticle(entry rssDiscoveryEntry, markdown *string, source string) *PrefetchedArticle {
	article := &PrefetchedArticle{
		Title:          truncateText(entry.Title, rssPrefetchMaxTitleChars),
		Description:    truncateText(entry.Description, rssPrefetchMaxDescriptionChars),
		Author:         truncateText(entry.Author, rssPrefetchMaxAuthorChars),
		Markdown:       *markdown,
		MarkdownSource: source,
	}
	if entry.PublishedAtTs != nil {
		article.PublishedAt = isoFromMillis(entry.PublishedAtTs)
	}
	return article
}

// isoFromMillis implements `new Date(ms).toISOString()`.
func isoFromMillis(millis *int64) *string {
	if millis == nil {
		return nil
	}
	value := time.UnixMilli(*millis).UTC().Format("2006-01-02T15:04:05.000Z")
	return &value
}

func millisPtr(value int64) *int64 { return &value }

func intPtrValue(value int) *int { return &value }

// htmlParse is the single HTML5 parse entry for the discovery helpers.
func htmlParse(body string) (*html.Node, error) {
	return html.Parse(strings.NewReader(body))
}

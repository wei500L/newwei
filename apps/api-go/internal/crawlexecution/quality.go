package crawlexecution

// Crawl quality signals (CrawlQualityStrategyService).
//
// assessPageSignals decides whether a crawl result is a detail page or a list
// page and whether the detail-expansion branch should run. Its three extra
// inputs over the original partial port are:
//
//   - the publish-time signal (article.publishedAt, metadata meta tags, JSON-LD,
//     the article URL date), which lets a short but fresh bulletin count as a
//     detail page instead of low-signal markdown;
//   - the media density, which counts the article.media inventory and lets a
//     short page with several images count as a mixed-media detail;
//   - the DOM list risk, which combines the link inventory, the link density,
//     the bullet-line count and list-like URL path tokens into a list-page
//     likelihood that feeds both isListLike and isLowSignal.
//
// Every function here is pure so the decisions are testable without a crawler.

import (
	"bytes"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// Publish-time sources, in CrawlPublishTimeSource order of preference.
const (
	publishTimeSourceMeta    = "meta"
	publishTimeSourceTimeTag = "time_tag"
	publishTimeSourceJSONLD  = "jsonld"
	publishTimeSourceURLPath = "url_path"
	publishTimeSourceNone    = "none"
)

// CrawlArticleSignal member thresholds. They are named because several
// decisions share them.
const (
	mediaDensityMixedBodyThreshold = 0.012
	domListRiskListLikeThreshold   = 0.72
	domListRiskLowSignalThreshold  = 0.78
	publishConfidenceBulletin      = 0.75
)

var (
	// paragraphSplitPattern is /\n\s*\n/.
	paragraphSplitPattern = regexp.MustCompile(`\n\s*\n`)
	// markdownHeadingPattern is /^#{1,6}\s+/gm.
	markdownHeadingPattern = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	// markdownInlineLinkPattern is /\]\((https?:\/\/|\/)/g.
	markdownInlineLinkPattern = regexp.MustCompile(`\]\((https?://|/)`)
	// rawURLPattern is /https?:\/\/\S+/g.
	rawURLPattern = regexp.MustCompile(`https?://\S+`)
	// cjkCharPattern is the JavaScript \p{Script=Han} union: one match per rune.
	cjkCharPattern = regexp.MustCompile(`[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]`)
	// listPathTokenSegmentPattern is hasListPathTokens' path test.
	listPathTokenSegmentPattern = regexp.MustCompile(`/(latest|archive|tag|tags|topic|topics|category|categories|section|sections|author|authors)(/|$)`)
)

// domListMetrics is estimateDomListRisk's metrics argument.
type domListMetrics struct {
	ParagraphCount int
	LinkCount      int
	LinkDensity    float64
	BulletLines    int
}

// estimateMarkdownWordUnits is estimateMarkdownWordUnits: whitespace words plus
// a CJK adjustment. The scoring count weights a CJK character at half a word and
// the density count at a sixth, because link density is measured per word.
func estimateMarkdownWordUnits(markdown string) (scoreWordCount, densityWordCount int) {
	words := len(strings.Fields(markdown))
	cjkCount := len(cjkCharPattern.FindAllString(markdown, -1))
	return words + int(jsRound(float64(cjkCount)/2)), words + int(jsRound(float64(cjkCount)/6))
}

// selectMarkdownForQuality is selectMarkdownForQuality: the quality profile can
// prefer the fit_markdown projection, then the primary projection, then the raw,
// citations and references projections.
func selectMarkdownForQuality(result markdownResult, preferFitMarkdown bool) string {
	if preferFitMarkdown && result.Fit != nil {
		if trimmed := strings.TrimSpace(*result.Fit); trimmed != "" {
			return trimmed
		}
	}
	for _, candidate := range []*string{result.Primary, result.Raw, result.Citations, result.References} {
		if candidate == nil {
			continue
		}
		if trimmed := strings.TrimSpace(*candidate); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// assessArticleMarkdownSignal is assessArticleMarkdownSignal.
func assessArticleMarkdownSignal(article crawl4ai.PipelineArticle, preferFitMarkdown bool, now time.Time) articleSignal {
	markdown := selectMarkdownForQuality(extractMarkdownResult(article.Markdown), preferFitMarkdown)
	publishTimeConfidence, publishTimeSource := resolvePublishTimeSignal(article, now)
	if markdown == "" {
		return articleSignal{
			PublishTimeConfidence: publishTimeConfidence,
			PublishTimeSource:     publishTimeSource,
			Score:                 math.Inf(-1),
		}
	}

	scoreWordCount, densityWordCount := estimateMarkdownWordUnits(markdown)
	wordCount := densityWordCount
	paragraphCount := countMarkdownParagraphs(markdown)
	headingCount := len(markdownHeadingPattern.FindAllString(markdown, -1))
	markdownLinkCount := len(markdownInlineLinkPattern.FindAllString(markdown, -1))
	rawURLCount := len(rawURLPattern.FindAllString(markdown, -1))
	linkCount := markdownLinkCount + rawURLCount
	bulletLines := countMarkdownBulletLines(markdown)
	linkDensity := float64(linkCount)
	if wordCount > 0 {
		linkDensity = float64(linkCount) / float64(wordCount)
	}
	mediaDensity := estimateMediaDensity(article, wordCount)
	domListRisk := estimateDomListRisk(article, domListMetrics{
		ParagraphCount: paragraphCount,
		LinkCount:      linkCount,
		LinkDensity:    linkDensity,
		BulletLines:    bulletLines,
	})

	listLikeSignals := (linkCount >= 16 && wordCount <= 1500) ||
		(bulletLines >= 10 && linkCount >= 10) ||
		(linkDensity >= 0.09 && wordCount <= 1200) ||
		domListRisk >= domListRiskListLikeThreshold
	hasArticleLikeBody := paragraphCount >= 8 && wordCount >= 260 && linkDensity <= 0.22
	isShortHighValueBulletin := wordCount >= 60 &&
		paragraphCount >= 2 &&
		publishTimeConfidence >= publishConfidenceBulletin &&
		linkDensity <= 0.16
	hasMixedMediaBody := mediaDensity >= mediaDensityMixedBodyThreshold &&
		paragraphCount >= 4 &&
		wordCount >= 90 &&
		linkDensity <= 0.2
	isListLike := listLikeSignals && !hasArticleLikeBody && !isShortHighValueBulletin && !hasMixedMediaBody
	boilerplateRatio := estimateBoilerplateRatio(markdown)

	score := math.Min(float64(scoreWordCount), 12_000) +
		float64(minIntValue(paragraphCount, 220))*6 +
		float64(headingCount)*3 -
		float64(linkCount)*6 -
		float64(bulletLines)*2 -
		jsRound(boilerplateRatio*320) +
		jsRound(math.Min(mediaDensity*2200, 90)) +
		jsRound(publishTimeConfidence*140) -
		jsRound(domListRisk*80)
	return articleSignal{
		WordCount:             wordCount,
		ParagraphCount:        paragraphCount,
		HeadingCount:          headingCount,
		LinkCount:             linkCount,
		LinkDensity:           linkDensity,
		BulletLines:           bulletLines,
		PublishTimeConfidence: publishTimeConfidence,
		PublishTimeSource:     publishTimeSource,
		MediaDensity:          mediaDensity,
		DomListRisk:           domListRisk,
		Score:                 score,
		IsListLike:            isListLike,
	}
}

// countMarkdownParagraphs is markdown.split(/\n\s*\n/).filter(non-empty).length.
func countMarkdownParagraphs(markdown string) int {
	count := 0
	for _, entry := range paragraphSplitPattern.Split(markdown, -1) {
		if strings.TrimSpace(entry) != "" {
			count++
		}
	}
	return count
}

// countMarkdownBulletLines counts list bullets at line starts.
func countMarkdownBulletLines(markdown string) int {
	count := 0
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") ||
			strings.HasPrefix(trimmed, "• ") {
			count++
		}
	}
	return count
}

// resolvePublishTimeSignal is resolvePublishTimeSignal.
func resolvePublishTimeSignal(article crawl4ai.PipelineArticle, now time.Time) (confidence float64, source string) {
	if timestamp, ok := parseDateValue(article.PublishedAt); ok {
		return normalizePublishTimeConfidence(timestamp, 0.92, now), publishTimeSourceMeta
	}
	if metadata := decodeMetadataMap(article.Metadata); metadata != nil {
		if timestamp, ok := resolvePublishTimeFromMetaRecord(metadata); ok {
			return normalizePublishTimeConfidence(timestamp, 0.86, now), publishTimeSourceMeta
		}
		if timestamp, ok := parseDateValue(metadata["datetime"]); ok {
			return normalizePublishTimeConfidence(timestamp, 0.82, now), publishTimeSourceTimeTag
		}
		if timestamp, ok := parseDateValue(metadata["time"]); ok {
			return normalizePublishTimeConfidence(timestamp, 0.82, now), publishTimeSourceTimeTag
		}
		if timestamp, ok := findJSONLDPublishDate(article.Metadata); ok {
			return normalizePublishTimeConfidence(timestamp, 0.9, now), publishTimeSourceJSONLD
		}
	}
	if timestamp, ok := parseDateFromArticleURL(article.URL); ok {
		return normalizePublishTimeConfidence(timestamp, 0.62, now), publishTimeSourceURLPath
	}
	return 0, publishTimeSourceNone
}

// resolvePublishTimeFromMetaRecord is resolvePublishTimeFromMetaRecord: the
// direct meta keys first, then the nested meta containers.
func resolvePublishTimeFromMetaRecord(record map[string]json.RawMessage) (int64, bool) {
	directKeys := []string{
		"article:published_time",
		"og:published_time",
		"publishdate",
		"publishDate",
		"pubdate",
		"date",
		"datePublished",
	}
	for _, key := range directKeys {
		if timestamp, ok := parseDateValue(record[key]); ok {
			return timestamp, true
		}
	}
	for _, key := range []string{"meta", "metadata", "openGraph", "open_graph"} {
		nested := decodeOrderedObject(record[key])
		if nested == nil {
			continue
		}
		if timestamp, ok := resolvePublishTimeFromMetaRecord(nested.record()); ok {
			return timestamp, true
		}
	}
	return 0, false
}

// findJSONLDPublishDate is findJsonLdPublishDate: the JSON-LD containers first,
// then the schema.org date members, then a depth-first walk of every member.
func findJSONLDPublishDate(raw json.RawMessage) (int64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '[' {
		var entries []json.RawMessage
		if err := json.Unmarshal(trimmed, &entries); err != nil {
			return 0, false
		}
		for _, entry := range entries {
			if timestamp, ok := findJSONLDPublishDate(entry); ok {
				return timestamp, true
			}
		}
		return 0, false
	}
	if trimmed[0] != '{' {
		return 0, false
	}
	object := decodeOrderedObject(trimmed)
	if object == nil {
		return 0, false
	}
	for _, key := range []string{"jsonld", "jsonLd", "structuredData", "ldJson"} {
		if value, ok := object.lookup(key); ok {
			if timestamp, found := findJSONLDPublishDate(value); found {
				return timestamp, true
			}
		}
	}
	for _, key := range []string{"datePublished", "dateCreated", "dateModified"} {
		if value, ok := object.lookup(key); ok {
			if timestamp, found := parseDateValue(value); found {
				return timestamp, true
			}
		}
	}
	for _, value := range object.Values {
		if timestamp, found := findJSONLDPublishDate(value); found {
			return timestamp, true
		}
	}
	return 0, false
}

// orderedJSONObject is one JSON object decoded in document order so the
// depth-first JSON-LD walk matches Object.values order.
type orderedJSONObject struct {
	Keys   []string
	Values []json.RawMessage
}

// record projects the object onto a key/value map (used for the meta record
// recursion, whose lookups are key-based).
func (o *orderedJSONObject) record() map[string]json.RawMessage {
	record := make(map[string]json.RawMessage, len(o.Keys))
	for index, key := range o.Keys {
		record[key] = o.Values[index]
	}
	return record
}

// lookup finds a member value by key.
func (o *orderedJSONObject) lookup(key string) (json.RawMessage, bool) {
	for index, candidate := range o.Keys {
		if candidate == key {
			return o.Values[index], true
		}
	}
	return nil, false
}

// decodeOrderedObject decodes a JSON object while keeping member order. It
// returns nil for anything that is not a JSON object.
func decodeOrderedObject(raw json.RawMessage) *orderedJSONObject {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil
	}
	object := &orderedJSONObject{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}
		object.Keys = append(object.Keys, key)
		object.Values = append(object.Values, value)
	}
	if _, err := decoder.Token(); err != nil {
		return nil
	}
	return object
}

// parseDateValue is parseDateValue: only JSON strings are considered, the value
// is trimmed and Date.parse must succeed with a positive timestamp. It returns
// Unix milliseconds.
func parseDateValue(raw json.RawMessage) (int64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return 0, false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false
	}
	return parseJSDateMilliseconds(strings.TrimSpace(value))
}

// jsDateLayouts are the accepted Date.parse shapes, most specific first. A
// date-time without an offset is treated as UTC, whereas Node treats it as local
// time; the publish confidence only measures age, so the difference is below the
// rounding of the freshness buckets.
var jsDateLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
	"2006/01/02 15:04:05",
	"2006/01/02",
	time.RFC1123Z,
	time.RFC1123,
	time.RFC822Z,
	time.RFC822,
	"Mon, 2 Jan 2006 15:04:05 MST",
	"02 Jan 2006 15:04:05 MST",
	"Jan 2, 2006 15:04:05 MST",
	"Jan 2, 2006 15:04:05",
	"Jan 2, 2006",
	"January 2, 2006 15:04:05",
	"January 2, 2006",
	"2 Jan 2006 15:04:05",
	"2 Jan 2006",
}

// parseJSDateMilliseconds parses the supported Date.parse shapes into Unix
// milliseconds.
func parseJSDateMilliseconds(value string) (int64, bool) {
	if value == "" {
		return 0, false
	}
	for _, layout := range jsDateLayouts {
		parsed, err := time.Parse(layout, value)
		if err != nil {
			continue
		}
		milliseconds := parsed.UnixMilli()
		if milliseconds <= 0 {
			return 0, false
		}
		return milliseconds, true
	}
	return 0, false
}

// parseDateFromArticleURL is parseDateFromArticleUrl: the /YYYY/MM/DD/ and
// YYYY-MM-DD shapes of the pathname, validated as real calendar dates.
func parseDateFromArticleURL(value string) (int64, bool) {
	if value == "" {
		return 0, false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return 0, false
	}
	path := strings.ToLower(parsed.Path)
	if match := articleDateSlash.FindStringSubmatch(path); match != nil {
		if timestamp, ok := utcDateMilliseconds(match[1], match[2], match[3]); ok {
			return timestamp, true
		}
	}
	if match := articleDateDashed.FindStringSubmatch(path); match != nil {
		return utcDateMilliseconds(match[1], match[2], match[3])
	}
	return 0, false
}

// utcDateMilliseconds is the Date.UTC + calendar round-trip validation.
func utcDateMilliseconds(yearText, monthText, dayText string) (int64, bool) {
	year, err := strconv.Atoi(yearText)
	if err != nil {
		return 0, false
	}
	month, err := strconv.Atoi(monthText)
	if err != nil {
		return 0, false
	}
	day, err := strconv.Atoi(dayText)
	if err != nil {
		return 0, false
	}
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return 0, false
	}
	value := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if value.Year() != year || int(value.Month()) != month || value.Day() != day {
		return 0, false
	}
	milliseconds := value.UnixMilli()
	if milliseconds <= 0 {
		return 0, false
	}
	return milliseconds, true
}

// normalizePublishTimeConfidence is normalizePublishTimeConfidence: fresh dates
// get a small boost, implausible dates (before 2000 or more than two days in the
// future) keep only a third of the base confidence. The result is rounded to
// three decimals like Number(x.toFixed(3)).
func normalizePublishTimeConfidence(timestamp int64, base float64, now time.Time) float64 {
	if timestamp <= 0 {
		return 0
	}
	nowMilliseconds := now.UTC().UnixMilli()
	year2000 := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	maxFuture := nowMilliseconds + 2*24*60*60*1000
	if timestamp < year2000 || timestamp > maxFuture {
		return roundTo(clampUnitInterval(base*0.35), 3)
	}
	ageDays := math.Abs(float64(nowMilliseconds-timestamp)) / float64(24*60*60*1000)
	freshnessBoost := 0.0
	if ageDays <= 10 {
		freshnessBoost = 0.08
	} else if ageDays <= 45 {
		freshnessBoost = 0.03
	}
	return roundTo(clampUnitInterval(base+freshnessBoost), 3)
}

// clampUnitInterval is Math.max(0, Math.min(1, value)).
func clampUnitInterval(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// estimateMediaDensity is estimateMediaDensity: images per word, clamped to
// [0, 1] and rounded to four decimals.
func estimateMediaDensity(article crawl4ai.PipelineArticle, wordCount int) float64 {
	imageCount := countArticleImageInventory(article)
	if imageCount <= 0 {
		return 0
	}
	density := float64(imageCount) / float64(maxIntValue(wordCount, 1))
	return roundTo(clampUnitInterval(density), 4)
}

// countArticleImageInventory is countArticleImageInventory: an image bucket
// counts one per entry, a photo bucket one per entry and every other media
// bucket at most two.
func countArticleImageInventory(article crawl4ai.PipelineArticle) int {
	if len(article.Media) == 0 {
		return 0
	}
	var buckets map[string]json.RawMessage
	if err := json.Unmarshal(article.Media, &buckets); err != nil {
		return 0
	}
	total := 0
	for key, raw := range buckets {
		var entries []json.RawMessage
		if err := json.Unmarshal(raw, &entries); err != nil || len(entries) == 0 {
			continue
		}
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		switch {
		case strings.Contains(normalizedKey, "image"), normalizedKey == "img", normalizedKey == "images":
			total += len(entries)
		case strings.Contains(normalizedKey, "photo"):
			total += len(entries)
		default:
			total += minIntValue(2, len(entries))
		}
	}
	return total
}

// estimateDomListRisk is estimateDomListRisk: a 0..1 list-page likelihood built
// from the link inventory, the link density, the bullet-line count, the
// paragraph/link shape and list-like URL path tokens.
func estimateDomListRisk(article crawl4ai.PipelineArticle, metrics domListMetrics) float64 {
	risk := 0.0
	linkInventory := countArticleLinks(article.Links)
	switch {
	case linkInventory >= 60:
		risk += 0.5
	case linkInventory >= 40:
		risk += 0.35
	case linkInventory >= 24:
		risk += 0.2
	}
	switch {
	case metrics.LinkDensity >= 0.14:
		risk += 0.35
	case metrics.LinkDensity >= 0.09:
		risk += 0.2
	}
	switch {
	case metrics.BulletLines >= 12:
		risk += 0.25
	case metrics.BulletLines >= 8:
		risk += 0.12
	}
	if metrics.ParagraphCount <= 2 && metrics.LinkCount >= 10 {
		risk += 0.2
	}
	if hasListPathTokens(article.URL) {
		risk += 0.25
	}
	return roundTo(clampUnitInterval(risk), 3)
}

// hasListPathTokens is hasListPathTokens.
func hasListPathTokens(value string) bool {
	if value == "" {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	return listPathTokenSegmentPattern.MatchString(strings.ToLower(parsed.Path))
}

// isLowSignal is isLowSignal: the two detail-shaped exceptions first, then the
// list-like, DOM-risk, density, link-count and inventory rules.
func isLowSignal(quality articleSignal, linkInventory int) bool {
	likelyHighValueBulletin := quality.PublishTimeConfidence >= publishConfidenceBulletin &&
		quality.WordCount >= 60 &&
		quality.ParagraphCount >= 2 &&
		quality.LinkDensity <= 0.16
	if likelyHighValueBulletin {
		return false
	}
	likelyMixedMediaDetail := quality.MediaDensity >= mediaDensityMixedBodyThreshold &&
		quality.WordCount >= 90 &&
		quality.ParagraphCount >= 4 &&
		quality.LinkDensity <= 0.2
	if likelyMixedMediaDetail {
		return false
	}
	if quality.IsListLike {
		return true
	}
	if quality.DomListRisk >= domListRiskLowSignalThreshold && quality.WordCount <= 1800 {
		return true
	}
	if quality.LinkDensity >= 0.14 && quality.WordCount <= 1600 {
		return true
	}
	if quality.LinkCount >= 12 && quality.WordCount <= 520 {
		return true
	}
	if linkInventory >= 40 && quality.WordCount <= 900 {
		return true
	}
	return false
}

// Domestic opinion index read path, ported from
// apps/api/src/modules/news-aggregator/newsnow-domestic-opinion-index.service.ts.
//
// Only the read path is ported: getDomesticOpinionIndex and its helpers. The
// persistence path (persistSnapshots, buildPersistedCandidate, buildKeywords,
// summarizeKeywords, buildIndexSnapshot, loadLatestSentimentLabels) is out of
// scope for this package, and the MySQL/Mongo scans live in the sibling store
// files, which hand BuildDomesticOpinionIndex already-decoded rows.
package newsnowclusteringops

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Domestic opinion index constants, mirroring the module-level constants of the
// NestJS service.
const (
	// defaultTrendHours is DEFAULT_TREND_HOURS.
	defaultTrendHours = 24

	// maxTrendHours is MAX_TREND_HOURS.
	maxTrendHours = 168

	// maxKeywordsPerCandidate is MAX_KEYWORDS_PER_CANDIDATE.
	maxKeywordsPerCandidate = 10

	// maxKeywordsPerIndex is MAX_KEYWORDS_PER_INDEX.
	maxKeywordsPerIndex = 12

	// maxTopCandidates is MAX_TOP_CANDIDATES.
	maxTopCandidates = 6

	// newsnowBlendWeight is NEWSNOW_BLEND_WEIGHT.
	newsnowBlendWeight = 0.75

	// pipelineBlendWeight is PIPELINE_BLEND_WEIGHT.
	pipelineBlendWeight = 0.25

	// pipelineKeywordNegativeBoost is PIPELINE_KEYWORD_NEGATIVE_BOOST.
	pipelineKeywordNegativeBoost = 1.2

	// pipelineFallbackQualityScore is PIPELINE_FALLBACK_QUALITY_SCORE.
	pipelineFallbackQualityScore = 0.5

	// isoMillisLayout is the exact Date.prototype.toISOString() shape: RFC3339
	// in UTC with three fractional digits. It is used for generatedAt and for
	// every bucketStart string. Bucket starts are hour-aligned, so their
	// fraction is always "000".
	isoMillisLayout = "2006-01-02T15:04:05.000Z"
)

var (
	// pipelineAttentionNormalizer is PIPELINE_ATTENTION_NORMALIZER, Math.log1p(12).
	pipelineAttentionNormalizer = math.Log1p(12)

	// pipelineBreadthNormalizer is PIPELINE_BREADTH_NORMALIZER, Math.log1p(6).
	pipelineBreadthNormalizer = math.Log1p(6)

	// cjkKeywordRe mirrors CJK_KEYWORD_RE /[\u3400-\u9fff]{2,8}/g.
	cjkKeywordRe = regexp.MustCompile(`[\x{3400}-\x{9fff}]{2,8}`)

	// latinKeywordRe mirrors LATIN_KEYWORD_RE /[A-Za-z0-9][A-Za-z0-9.+-]{1,30}/g.
	latinKeywordRe = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9.+-]{1,30}`)
)

// sentimentLabel is the normalized ProcessedItem sentiment vocabulary. It is
// produced by normalizeSentimentLabel in store_clustering.go, which returns the
// raw string form because the Mongo projection stays typed as *string.
type sentimentLabel string

const (
	// sentimentLabelPositive marks a positive document.
	sentimentLabelPositive sentimentLabel = "positive"
	// sentimentLabelNeutral marks a neutral document.
	sentimentLabelNeutral sentimentLabel = "neutral"
	// sentimentLabelNegative marks a negative document and applies the keyword
	// boost.
	sentimentLabelNegative sentimentLabel = "negative"
)

// ---------------------------------------------------------------------------
// Row models handed in by the store layer
// ---------------------------------------------------------------------------

// newsSignalEntity is one entity of a processed article.
type newsSignalEntity struct {
	Name       string   `json:"name"`
	Type       *string  `json:"type"`
	Confidence *float64 `json:"confidence"`
}

// opinionSnapshotRow is one MySQL NewsnowDomesticOpinionIndexSnapshot row.
type opinionSnapshotRow struct {
	BucketStart        time.Time
	IndexValue         float64
	AttentionScore     float64
	BreadthScore       float64
	FreshnessScore     float64
	SentimentPressure  float64
	CandidateCount     int
	KeywordSummaryJSON []byte // the raw JSON column; parse with sanitizeKeywordSummary
}

// opinionCandidateRow is one NewsnowCandidateSnapshot row for the latest bucket.
// The caller scopes the query to the latest snapshot bucket and to
// isDomestic = true, exactly like the Prisma where clause of
// loadTopCandidatesForBucket.
type opinionCandidateRow struct {
	Label          string
	CandidateScore float64
	DomesticRatio  float64
	SourceCount    int
}

// opinionPipelineArticleRow is one ProcessedArticle joined with Article rows.
type opinionPipelineArticleRow struct {
	ID                    string
	Title                 *string
	Summary               *string
	TopicsJSON            []byte
	EntitiesJSON          []byte
	QualityScore          *float64
	Language              *string
	Location              *string
	PublishedAt           *time.Time
	EventAt               time.Time
	ProcessedAt           time.Time
	CleanedMarkdownRef    *string
	CrawlAt               time.Time
	ArticleSourceID       *string
	ArticleSourceLanguage *string
}

// processedItemSignal is the Mongo-derived sentiment/source hint for one
// ProcessedItem. SourceID is the already-trimmed source id (nil when the
// document has none) and Sentiment is the raw result.sentiment_label value,
// normalized with normalizeSentimentLabel when it is consumed.
type processedItemSignal struct {
	SourceID  *string
	Sentiment *string
}

// ---------------------------------------------------------------------------
// Module-level pure helpers
// ---------------------------------------------------------------------------

// clamp01 clamps to [0,1] and rounds to 4 decimals, mirroring the opinion index
// module clamp01, which is Math.max(0, Math.min(1, Number(value.toFixed(4)))).
func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Max(0, math.Min(1, math.Round(value*1e4)/1e4))
}

// roundMetric mirrors roundMetric: non-finite input becomes 0, otherwise the
// value is rounded to 4 decimals exactly like Number(value.toFixed(4)).
func roundMetric(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Round(value*1e4) / 1e4
}

// normalizeKeywordDisplay collapses whitespace runs into single spaces and trims
// the result, mirroring value.replace(/\s+/g, " ").trim(). strings.Fields uses
// the Unicode whitespace set, which is the closest Go equivalent of JS \s.
func normalizeKeywordDisplay(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

// normalizeKeywordKey mirrors normalizeKeywordKey: the display form lowercased.
func normalizeKeywordKey(value string) string {
	return strings.ToLower(normalizeKeywordDisplay(value))
}

// extractTitleFallbackKeywords mirrors extractTitleFallbackKeywords: up to 10
// de-duplicated CJK matches first, then Latin matches, each normalized.
func extractTitleFallbackKeywords(title string) []string {
	normalized := normalizeKeywordDisplay(title)
	if normalized == "" {
		return []string{}
	}

	results := make([]string, 0, maxKeywordsPerCandidate)
	seen := make(map[string]struct{}, maxKeywordsPerCandidate)

	for _, match := range cjkKeywordRe.FindAllString(normalized, -1) {
		keyword := normalizeKeywordDisplay(match)
		key := normalizeKeywordKey(keyword)
		if keyword == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		results = append(results, keyword)
		if len(results) >= maxKeywordsPerCandidate {
			return results
		}
	}

	for _, match := range latinKeywordRe.FindAllString(normalized, -1) {
		keyword := normalizeKeywordDisplay(match)
		key := normalizeKeywordKey(keyword)
		if keyword == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		results = append(results, keyword)
		if len(results) >= maxKeywordsPerCandidate {
			break
		}
	}

	return results
}

// toUtcHourStart mirrors toUtcHourStart: the start of the UTC hour that
// contains value.
func toUtcHourStart(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), utc.Hour(), 0, 0, 0, time.UTC)
}

// toISOStringMillis renders a timestamp exactly like
// Date.prototype.toISOString().
func toISOStringMillis(value time.Time) string {
	return value.UTC().Format(isoMillisLayout)
}

// decodeJSONArray decodes a JSON column into per-element raw messages.
// Element-wise decoding is the only way to keep the ProcessedArticle "string or
// {name: ...}" unions strongly typed without falling back to an untyped map.
func decodeJSONArray(raw []byte) []json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	return entries
}

// sanitizeKeywordSummary mirrors sanitizeKeywordSummary for a raw keywordSummary
// JSON column: entries with a non-empty keyword and a positive weight survive,
// every other entry is dropped.
func sanitizeKeywordSummary(raw []byte) []CandidateKeywordSummary {
	entries := decodeJSONArray(raw)
	out := make([]CandidateKeywordSummary, 0, len(entries))
	for _, entry := range entries {
		var row struct {
			Keyword *string  `json:"keyword"`
			Weight  *float64 `json:"weight"`
		}
		if err := json.Unmarshal(entry, &row); err != nil {
			continue
		}
		keyword := ""
		if row.Keyword != nil {
			keyword = normalizeKeywordDisplay(*row.Keyword)
		}
		weight := 0.0
		if row.Weight != nil {
			weight = roundMetric(*row.Weight)
		}
		if keyword == "" || weight <= 0 {
			continue
		}
		out = append(out, CandidateKeywordSummary{Keyword: keyword, Weight: weight})
	}
	return out
}

// sanitizeStringList mirrors sanitizeStringList: the string entries of a JSON
// array, whitespace-collapsed, with non-strings and empties dropped.
func sanitizeStringList(raw []byte) []string {
	entries := decodeJSONArray(raw)
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err != nil {
			continue
		}
		if display := normalizeKeywordDisplay(text); display != "" {
			out = append(out, display)
		}
	}
	return out
}

// decodeStringArray decodes a JSON array into its string entries, trimmed, with
// non-strings and empty values dropped. It mirrors the classifier
// normalizeStringArray used on the ProcessedArticle topics column, which trims
// without collapsing inner whitespace.
func decodeStringArray(raw []byte) []string {
	entries := decodeJSONArray(raw)
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err != nil {
			continue
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// decodeNewsSignalEntities decodes a JSON array of plain strings or
// {"name": ...} objects into typed entities, keeping the classifier
// normalizeEntityNames semantics (trimmed name, empty names dropped).
func decodeNewsSignalEntities(raw []byte) []newsSignalEntity {
	entries := decodeJSONArray(raw)
	out := make([]newsSignalEntity, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err == nil {
			if name := strings.TrimSpace(text); name != "" {
				out = append(out, newsSignalEntity{Name: name})
			}
			continue
		}
		var object struct {
			Name       *string  `json:"name"`
			Type       *string  `json:"type"`
			Confidence *float64 `json:"confidence"`
		}
		if err := json.Unmarshal(entry, &object); err != nil || object.Name == nil {
			continue
		}
		name := strings.TrimSpace(*object.Name)
		if name == "" {
			continue
		}
		out = append(out, newsSignalEntity{Name: name, Type: object.Type, Confidence: object.Confidence})
	}
	return out
}

// sanitizeEntityNames mirrors the opinion index sanitizeEntityNames: plain
// strings and {"name": ...} objects become whitespace-collapsed names.
func sanitizeEntityNames(raw []byte) []string {
	entries := decodeJSONArray(raw)
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err == nil {
			if display := normalizeKeywordDisplay(text); display != "" {
				out = append(out, display)
			}
			continue
		}
		var object struct {
			Name *string `json:"name"`
		}
		if err := json.Unmarshal(entry, &object); err != nil || object.Name == nil {
			continue
		}
		if display := normalizeKeywordDisplay(*object.Name); display != "" {
			out = append(out, display)
		}
	}
	return out
}

// isZhLanguage mirrors isZhLanguage for a nullable language column.
func isZhLanguage(value *string) bool {
	if value == nil {
		return false
	}
	normalized := strings.ToLower(strings.TrimSpace(*value))
	return strings.HasPrefix(normalized, "zh") || normalized == "cn" || strings.Contains(normalized, "chinese")
}

// computeIndexValue mirrors computeIndexValue: the weighted blend of the four
// normalized metrics, clamped to [0,1] at 4 decimals.
func computeIndexValue(attentionScore, breadthScore, freshnessScore, sentimentPressure float64) float64 {
	return clamp01(
		attentionScore*0.5 +
			breadthScore*0.2 +
			freshnessScore*0.2 +
			sentimentPressure*0.1,
	)
}

// mergeWeightedMetric mirrors mergeWeightedMetric. A nil side marks a source
// that has no bucket for the hour: a single side passes through rounded, both
// nil returns 0, a non-positive total weight falls back to the plain mean, and
// otherwise the weighted mean is returned.
func mergeWeightedMetric(newsnowValue, pipelineValue *float64, newsnowWeight, pipelineWeight float64) float64 {
	if newsnowValue == nil && pipelineValue == nil {
		return 0
	}
	if newsnowValue == nil {
		return roundMetric(floatValue(pipelineValue))
	}
	if pipelineValue == nil {
		return roundMetric(*newsnowValue)
	}
	totalWeight := newsnowWeight + pipelineWeight
	if totalWeight <= 0 {
		return roundMetric((*newsnowValue + *pipelineValue) / 2)
	}
	return roundMetric((*newsnowValue*newsnowWeight + *pipelineValue*pipelineWeight) / totalWeight)
}

// floatValue dereferences an optional metric, treating nil as 0.
func floatValue(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

// float64Pointer returns a pointer to a copy of value.
func float64Pointer(value float64) *float64 {
	return &value
}

// stringValue dereferences an optional string, treating nil as the empty string.
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// compareKeywordLocale approximates the JavaScript localeCompare used as the
// keyword tie-break. V8's default collation is case-insensitive at the primary
// level, so the lowercased forms are compared first; a raw byte comparison then
// makes the order total and deterministic. It only ever decides ties, because
// keyword weights inside one list are distinct in practice.
func compareKeywordLocale(left, right string) int {
	leftLower := strings.ToLower(left)
	rightLower := strings.ToLower(right)
	if leftLower != rightLower {
		if leftLower < rightLower {
			return -1
		}
		return 1
	}
	if left == right {
		return 0
	}
	if left < right {
		return -1
	}
	return 1
}

// sortKeywordSummaries sorts by descending weight and then by localeCompare
// order, stably, mirroring Array.prototype.sort.
func sortKeywordSummaries(entries []CandidateKeywordSummary) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Weight != entries[j].Weight {
			return entries[i].Weight > entries[j].Weight
		}
		return compareKeywordLocale(entries[i].Keyword, entries[j].Keyword) < 0
	})
}

// mergeKeywordSummaries mirrors mergeKeywordSummaries: keywords are de-duplicated
// by normalized key, their weights summed and rounded, then sorted and capped at
// MAX_KEYWORDS_PER_INDEX.
func mergeKeywordSummaries(values []CandidateKeywordSummary) []CandidateKeywordSummary {
	weighted := make(map[string]CandidateKeywordSummary, len(values))
	order := make([]string, 0, len(values))
	for _, entry := range values {
		keyword := normalizeKeywordDisplay(entry.Keyword)
		weight := roundMetric(entry.Weight)
		if keyword == "" || weight <= 0 {
			continue
		}
		key := normalizeKeywordKey(keyword)
		if current, exists := weighted[key]; exists {
			current.Weight = roundMetric(current.Weight + weight)
			weighted[key] = current
			continue
		}
		weighted[key] = CandidateKeywordSummary{Keyword: keyword, Weight: weight}
		order = append(order, key)
	}

	out := make([]CandidateKeywordSummary, 0, len(order))
	for _, key := range order {
		out = append(out, weighted[key])
	}
	sortKeywordSummaries(out)
	if len(out) > maxKeywordsPerIndex {
		out = out[:maxKeywordsPerIndex]
	}
	return out
}

// ---------------------------------------------------------------------------
// Pipeline trend
// ---------------------------------------------------------------------------

// pipelineBucketAccumulator collects the domestic articles of one UTC hour.
// KeywordOrder keeps the JavaScript Map insertion order so equal-weight keyword
// ties stay deterministic.
type pipelineBucketAccumulator struct {
	BucketStart       time.Time
	ArticleCount      int
	SourceIDs         map[string]struct{}
	NewestArticleAt   time.Time
	SentimentDocCount int
	NegativeCount     int
	KeywordWeights    map[string]CandidateKeywordSummary
	KeywordOrder      []string
}

// pipelineBucketSummary is one finalized pipeline hour.
type pipelineBucketSummary struct {
	BucketStart       time.Time
	IndexValue        float64
	AttentionScore    float64
	BreadthScore      float64
	FreshnessScore    float64
	SentimentPressure float64
	ArticleCount      int
	SourceCount       int
	Keywords          []CandidateKeywordSummary
}

// mergedBucketSummary is one hour of the blended trend with the two unblended
// contributions kept for the breakdown block.
type mergedBucketSummary struct {
	BucketStart time.Time
	Point       DomesticOpinionIndexPoint
	Newsnow     *opinionSnapshotRow
	Pipeline    *pipelineBucketSummary
}

// articleEventAt mirrors the JS fallback chain
// `eventAt ?? publishedAt ?? article.crawlAt ?? processedAt`. A zero time is the
// Go equivalent of the JS null.
func articleEventAt(row opinionPipelineArticleRow) time.Time {
	if !row.EventAt.IsZero() {
		return row.EventAt
	}
	if row.PublishedAt != nil && !row.PublishedAt.IsZero() {
		return *row.PublishedAt
	}
	if !row.CrawlAt.IsZero() {
		return row.CrawlAt
	}
	return row.ProcessedAt
}

// processedItemSignalFor resolves the ProcessedItem signal of a
// cleanedMarkdownRef, returning false when the reference is missing or empty,
// exactly like the JS `ref && ref.trim().length > 0 ? map.get(trim) ?? null : null`.
func processedItemSignalFor(cleanedMarkdownRef *string, signals map[string]processedItemSignal) (processedItemSignal, bool) {
	if cleanedMarkdownRef == nil {
		return processedItemSignal{}, false
	}
	key := strings.TrimSpace(*cleanedMarkdownRef)
	if key == "" {
		return processedItemSignal{}, false
	}
	signal, ok := signals[key]
	return signal, ok
}

// loadPipelineTrend mirrors loadPipelineTrend: it filters the processed articles
// down to the domestic ones, buckets the survivors by UTC hour and finalizes
// every bucket.
//
// articles must arrive in the same order as the Prisma orderBy
// (eventAt desc, id desc); that order only affects which spelling wins for two
// equal-weight keywords that share a normalized key.
func loadPipelineTrend(
	since time.Time,
	articles []opinionPipelineArticleRow,
	signals map[string]processedItemSignal,
) []pipelineBucketSummary {
	if len(articles) == 0 {
		return []pipelineBucketSummary{}
	}

	buckets := make(map[int64]*pipelineBucketAccumulator, len(articles))
	order := make([]int64, 0, len(articles))

	for _, row := range articles {
		eventAt := articleEventAt(row)
		if eventAt.IsZero() {
			continue
		}
		if eventAt.Before(since) {
			continue
		}

		bucketStart := toUtcHourStart(eventAt)
		if bucketStart.Before(since) {
			continue
		}

		processedSignal, hasSignal := processedItemSignalFor(row.CleanedMarkdownRef, signals)
		var processedSourceID *string
		if hasSignal {
			if trimmed := strings.TrimSpace(stringValue(processedSignal.SourceID)); trimmed != "" {
				processedSourceID = &trimmed
			}
		}

		sourceKey := ""
		if processedSourceID != nil {
			sourceKey = *processedSourceID
		} else if row.ArticleSourceID != nil {
			sourceKey = *row.ArticleSourceID
		}

		isDomesticSource := false
		if processedSourceID != nil {
			_, isDomesticSource = domesticSourceIDs[*processedSourceID]
		}
		hasZhSignal := isZhLanguage(row.Language) || isZhLanguage(row.ArticleSourceLanguage)

		// isDomesticByRule is only consulted when the processed source did not
		// already prove the article domestic, exactly like the NestJS branch.
		isDomesticByRule := false
		if !isDomesticSource && hasZhSignal {
			isDomesticByRule = ruleVerticalForArticle(
				stringValue(row.Title),
				stringValue(row.Summary),
				stringValue(row.Location),
				"",
				decodeStringArray(row.TopicsJSON),
				decodeNewsSignalEntities(row.EntitiesJSON),
			) == ArchiveVerticalDomesticAffairs
		}
		if !isDomesticSource && !isDomesticByRule {
			continue
		}

		bucketKey := bucketStart.UnixMilli()
		bucket, exists := buckets[bucketKey]
		if !exists {
			bucket = &pipelineBucketAccumulator{
				BucketStart:    bucketStart,
				SourceIDs:      make(map[string]struct{}),
				KeywordWeights: make(map[string]CandidateKeywordSummary),
			}
			buckets[bucketKey] = bucket
			order = append(order, bucketKey)
		}

		bucket.ArticleCount++
		if eventAt.After(bucket.NewestArticleAt) {
			bucket.NewestArticleAt = eventAt
		}
		if trimmed := strings.TrimSpace(sourceKey); trimmed != "" {
			bucket.SourceIDs[trimmed] = struct{}{}
		}

		sentiment := sentimentLabel("")
		if hasSignal {
			if label := normalizeSentimentLabel(processedSignal.Sentiment); label != nil {
				sentiment = sentimentLabel(*label)
			}
		}
		if sentiment != sentimentLabel("") {
			bucket.SentimentDocCount++
			if sentiment == sentimentLabelNegative {
				bucket.NegativeCount++
			}
		}

		for _, keyword := range buildPipelineKeywords(row, sentiment) {
			key := normalizeKeywordKey(keyword.Keyword)
			if current, ok := bucket.KeywordWeights[key]; ok {
				current.Weight = roundMetric(current.Weight + keyword.Weight)
				bucket.KeywordWeights[key] = current
				continue
			}
			bucket.KeywordWeights[key] = keyword
			bucket.KeywordOrder = append(bucket.KeywordOrder, key)
		}
	}

	summaries := make([]pipelineBucketSummary, 0, len(order))
	for _, key := range order {
		summaries = append(summaries, finalizePipelineBucket(buckets[key]))
	}
	sort.SliceStable(summaries, func(i, j int) bool {
		return summaries[i].BucketStart.Before(summaries[j].BucketStart)
	})
	return summaries
}

// buildPipelineKeywords mirrors buildPipelineKeywords: topics weigh 1, entity
// names weigh 0.8 and title fallback keywords weigh 0.45, each scaled by the
// quality weight and the negative-sentiment boost.
func buildPipelineKeywords(row opinionPipelineArticleRow, sentiment sentimentLabel) []CandidateKeywordSummary {
	normalizedTopics := sanitizeStringList(row.TopicsJSON)
	normalizedEntities := sanitizeEntityNames(row.EntitiesJSON)

	qualityScore := float64(pipelineFallbackQualityScore)
	if row.QualityScore != nil && !math.IsNaN(*row.QualityScore) && !math.IsInf(*row.QualityScore, 0) {
		qualityScore = clamp01(*row.QualityScore)
	}
	qualityWeight := 0.6 + 0.4*qualityScore
	sentimentWeight := 1.0
	if sentiment == sentimentLabelNegative {
		sentimentWeight = pipelineKeywordNegativeBoost
	}

	weighted := make(map[string]CandidateKeywordSummary, len(normalizedTopics)+len(normalizedEntities))
	order := make([]string, 0, len(normalizedTopics)+len(normalizedEntities))
	push := func(value string, baseWeight float64) {
		keyword := normalizeKeywordDisplay(value)
		if keyword == "" {
			return
		}
		weight := roundMetric(baseWeight * qualityWeight * sentimentWeight)
		if weight <= 0 {
			return
		}
		key := normalizeKeywordKey(keyword)
		current, exists := weighted[key]
		if !exists {
			weighted[key] = CandidateKeywordSummary{Keyword: keyword, Weight: weight}
			order = append(order, key)
			return
		}
		if weight > current.Weight {
			weighted[key] = CandidateKeywordSummary{Keyword: keyword, Weight: weight}
		}
	}

	for _, topic := range normalizedTopics {
		push(topic, 1)
	}
	for _, entity := range normalizedEntities {
		push(entity, 0.8)
	}
	if len(weighted) == 0 {
		for _, keyword := range extractTitleFallbackKeywords(stringValue(row.Title)) {
			push(keyword, 0.45)
		}
	}

	out := make([]CandidateKeywordSummary, 0, len(order))
	for _, key := range order {
		out = append(out, weighted[key])
	}
	sortKeywordSummaries(out)
	if len(out) > maxKeywordsPerCandidate {
		out = out[:maxKeywordsPerCandidate]
	}
	return out
}

// finalizePipelineBucket mirrors finalizePipelineBucket: the four normalized
// metrics, the blended index value and the keyword list of one pipeline hour.
// Freshness decays linearly from the end of the hour towards the newest article.
func finalizePipelineBucket(bucket *pipelineBucketAccumulator) pipelineBucketSummary {
	articleCount := bucket.ArticleCount
	sourceCount := len(bucket.SourceIDs)
	bucketEnd := bucket.BucketStart.Add(time.Hour)

	freshnessScore := 0.0
	if !bucket.NewestArticleAt.IsZero() {
		freshnessScore = clamp01(1 - float64(bucketEnd.Sub(bucket.NewestArticleAt))/float64(time.Hour))
	}
	attentionScore := 0.0
	if articleCount > 0 {
		attentionScore = clamp01(math.Log1p(float64(articleCount)) / pipelineAttentionNormalizer)
	}
	breadthScore := 0.0
	if sourceCount > 0 {
		breadthScore = clamp01(math.Log1p(float64(sourceCount)) / pipelineBreadthNormalizer)
	}
	sentimentPressure := 0.0
	if bucket.SentimentDocCount > 0 {
		sentimentPressure = clamp01(float64(bucket.NegativeCount) / float64(bucket.SentimentDocCount))
	}

	keywords := make([]CandidateKeywordSummary, 0, len(bucket.KeywordOrder))
	for _, key := range bucket.KeywordOrder {
		keywords = append(keywords, bucket.KeywordWeights[key])
	}
	sortKeywordSummaries(keywords)
	if len(keywords) > maxKeywordsPerIndex {
		keywords = keywords[:maxKeywordsPerIndex]
	}
	capped := make([]CandidateKeywordSummary, 0, len(keywords))
	for _, keyword := range keywords {
		capped = append(capped, CandidateKeywordSummary{Keyword: keyword.Keyword, Weight: roundMetric(keyword.Weight)})
	}

	return pipelineBucketSummary{
		BucketStart:       bucket.BucketStart,
		IndexValue:        roundMetric(computeIndexValue(attentionScore, breadthScore, freshnessScore, sentimentPressure)),
		AttentionScore:    roundMetric(attentionScore),
		BreadthScore:      roundMetric(breadthScore),
		FreshnessScore:    roundMetric(freshnessScore),
		SentimentPressure: roundMetric(sentimentPressure),
		ArticleCount:      articleCount,
		SourceCount:       sourceCount,
		Keywords:          capped,
	}
}

// ---------------------------------------------------------------------------
// Merged trend and breakdown
// ---------------------------------------------------------------------------

// mergeTrendRows mirrors mergeTrendRows: the union of both bucket key sets in
// ascending order, with the single-source hours passed through and the shared
// hours blended.
func mergeTrendRows(newsnowRows []opinionSnapshotRow, pipelineRows []pipelineBucketSummary) []mergedBucketSummary {
	newsnowByBucket := make(map[int64]opinionSnapshotRow, len(newsnowRows))
	for _, row := range newsnowRows {
		newsnowByBucket[row.BucketStart.UnixMilli()] = row
	}
	pipelineByBucket := make(map[int64]pipelineBucketSummary, len(pipelineRows))
	for _, row := range pipelineRows {
		pipelineByBucket[row.BucketStart.UnixMilli()] = row
	}

	bucketKeys := make([]int64, 0, len(newsnowByBucket)+len(pipelineByBucket))
	for key := range newsnowByBucket {
		bucketKeys = append(bucketKeys, key)
	}
	for key := range pipelineByBucket {
		if _, exists := newsnowByBucket[key]; !exists {
			bucketKeys = append(bucketKeys, key)
		}
	}
	sort.Slice(bucketKeys, func(i, j int) bool { return bucketKeys[i] < bucketKeys[j] })

	merged := make([]mergedBucketSummary, 0, len(bucketKeys))
	for _, bucketKey := range bucketKeys {
		bucketStart := time.UnixMilli(bucketKey).UTC()
		newsnow, hasNewsnow := newsnowByBucket[bucketKey]
		pipeline, hasPipeline := pipelineByBucket[bucketKey]

		if hasNewsnow && !hasPipeline {
			newsnowCopy := newsnow
			merged = append(merged, mergedBucketSummary{
				BucketStart: bucketStart,
				Point: DomesticOpinionIndexPoint{
					BucketStart:       toISOStringMillis(bucketStart),
					IndexValue:        roundMetric(newsnow.IndexValue),
					AttentionScore:    roundMetric(newsnow.AttentionScore),
					BreadthScore:      roundMetric(newsnow.BreadthScore),
					FreshnessScore:    roundMetric(newsnow.FreshnessScore),
					SentimentPressure: roundMetric(newsnow.SentimentPressure),
					CandidateCount:    newsnow.CandidateCount,
				},
				Newsnow: &newsnowCopy,
			})
			continue
		}
		if hasPipeline && !hasNewsnow {
			pipelineCopy := pipeline
			merged = append(merged, mergedBucketSummary{
				BucketStart: bucketStart,
				Point: DomesticOpinionIndexPoint{
					BucketStart:       toISOStringMillis(bucketStart),
					IndexValue:        roundMetric(pipeline.IndexValue),
					AttentionScore:    roundMetric(pipeline.AttentionScore),
					BreadthScore:      roundMetric(pipeline.BreadthScore),
					FreshnessScore:    roundMetric(pipeline.FreshnessScore),
					SentimentPressure: roundMetric(pipeline.SentimentPressure),
					CandidateCount:    0,
				},
				Pipeline: &pipelineCopy,
			})
			continue
		}

		// The fusion formula of the NestJS service: attention, breadth and
		// freshness use the fixed NEWSNOW_BLEND_WEIGHT / PIPELINE_BLEND_WEIGHT
		// pair (0.75 snapshot / 0.25 pipeline), while sentimentPressure is
		// weighted by how much evidence each side actually contributed, i.e. the
		// snapshot candidateCount against the pipeline articleCount.
		attentionScore := mergeWeightedMetric(
			float64Pointer(newsnow.AttentionScore),
			float64Pointer(pipeline.AttentionScore),
			newsnowBlendWeight,
			pipelineBlendWeight,
		)
		breadthScore := mergeWeightedMetric(
			float64Pointer(newsnow.BreadthScore),
			float64Pointer(pipeline.BreadthScore),
			newsnowBlendWeight,
			pipelineBlendWeight,
		)
		freshnessScore := mergeWeightedMetric(
			float64Pointer(newsnow.FreshnessScore),
			float64Pointer(pipeline.FreshnessScore),
			newsnowBlendWeight,
			pipelineBlendWeight,
		)
		sentimentPressure := mergeWeightedMetric(
			float64Pointer(newsnow.SentimentPressure),
			float64Pointer(pipeline.SentimentPressure),
			float64(newsnow.CandidateCount),
			float64(pipeline.ArticleCount),
		)

		newsnowCopy := newsnow
		pipelineCopy := pipeline
		merged = append(merged, mergedBucketSummary{
			BucketStart: bucketStart,
			Point: DomesticOpinionIndexPoint{
				BucketStart:       toISOStringMillis(bucketStart),
				IndexValue:        roundMetric(computeIndexValue(attentionScore, breadthScore, freshnessScore, sentimentPressure)),
				AttentionScore:    attentionScore,
				BreadthScore:      breadthScore,
				FreshnessScore:    freshnessScore,
				SentimentPressure: sentimentPressure,
				CandidateCount:    newsnow.CandidateCount,
			},
			Newsnow:  &newsnowCopy,
			Pipeline: &pipelineCopy,
		})
	}
	return merged
}

// buildBreakdownTopKeywords mirrors buildBreakdownTopKeywords: the latest
// bucket's keywords split by source. Both lists are always non-nil.
func buildBreakdownTopKeywords(latest mergedBucketSummary) DomesticOpinionIndexBreakdownTopKeywords {
	newsnow := []CandidateKeywordSummary{}
	if latest.Newsnow != nil {
		newsnow = sanitizeKeywordSummary(latest.Newsnow.KeywordSummaryJSON)
	}
	pipeline := []CandidateKeywordSummary{}
	if latest.Pipeline != nil {
		pipeline = latest.Pipeline.Keywords
	}
	return DomesticOpinionIndexBreakdownTopKeywords{Newsnow: newsnow, Pipeline: pipeline}
}

// toBreakdownPoint mirrors toBreakdownPoint.
func toBreakdownPoint(row mergedBucketSummary) DomesticOpinionIndexBreakdownPoint {
	point := DomesticOpinionIndexBreakdownPoint{BucketStart: toISOStringMillis(row.BucketStart)}
	if row.Newsnow != nil {
		point.Newsnow = &DomesticOpinionIndexBreakdownSourcePoint{
			BucketStart:       toISOStringMillis(row.Newsnow.BucketStart),
			IndexValue:        roundMetric(row.Newsnow.IndexValue),
			AttentionScore:    roundMetric(row.Newsnow.AttentionScore),
			BreadthScore:      roundMetric(row.Newsnow.BreadthScore),
			FreshnessScore:    roundMetric(row.Newsnow.FreshnessScore),
			SentimentPressure: roundMetric(row.Newsnow.SentimentPressure),
			CandidateCount:    row.Newsnow.CandidateCount,
		}
	}
	if row.Pipeline != nil {
		point.Pipeline = &DomesticOpinionIndexPipelineBreakdownSourcePoint{
			BucketStart:       toISOStringMillis(row.Pipeline.BucketStart),
			IndexValue:        roundMetric(row.Pipeline.IndexValue),
			AttentionScore:    roundMetric(row.Pipeline.AttentionScore),
			BreadthScore:      roundMetric(row.Pipeline.BreadthScore),
			FreshnessScore:    roundMetric(row.Pipeline.FreshnessScore),
			SentimentPressure: roundMetric(row.Pipeline.SentimentPressure),
			ArticleCount:      row.Pipeline.ArticleCount,
			SourceCount:       row.Pipeline.SourceCount,
		}
	}
	return point
}

// loadTopCandidatesForBucket mirrors loadTopCandidatesForBucket for rows the
// caller already scoped to the latest snapshot bucket and to isDomestic = true:
// ranked by candidateScore * domesticRatio, then by sourceCount, then capped.
func loadTopCandidatesForBucket(candidates []opinionCandidateRow) []DomesticOpinionIndexTopCandidate {
	sorted := make([]opinionCandidateRow, len(candidates))
	copy(sorted, candidates)
	sort.SliceStable(sorted, func(i, j int) bool {
		leftScore := sorted[i].CandidateScore * sorted[i].DomesticRatio
		rightScore := sorted[j].CandidateScore * sorted[j].DomesticRatio
		if leftScore != rightScore {
			return leftScore > rightScore
		}
		return sorted[i].SourceCount > sorted[j].SourceCount
	})
	if len(sorted) > maxTopCandidates {
		sorted = sorted[:maxTopCandidates]
	}

	out := make([]DomesticOpinionIndexTopCandidate, 0, len(sorted))
	for _, row := range sorted {
		out = append(out, DomesticOpinionIndexTopCandidate{
			Label:          row.Label,
			CandidateScore: roundMetric(row.CandidateScore),
			SourceCount:    row.SourceCount,
		})
	}
	return out
}

// buildEmptyResponse mirrors buildEmptyResponse. now replaces the JS
// `new Date()` so the caller controls the clock, and every array field is a
// non-nil empty slice so the payload serializes as [] instead of null.
func buildEmptyResponse(now time.Time, diagnostics DomesticOpinionIndexDiagnostics) DomesticOpinionIndexResponse {
	reason := NewsnowDomesticOpinionEmptyReasonNoRecentSnapshotsOrPipelineData
	return DomesticOpinionIndexResponse{
		GeneratedAt:   toISOStringMillis(now),
		DataState:     NewsnowDataStateEmpty,
		EmptyReason:   &reason,
		Diagnostics:   diagnostics,
		Latest:        nil,
		Trend:         []DomesticOpinionIndexPoint{},
		TopKeywords:   []CandidateKeywordSummary{},
		TopCandidates: []DomesticOpinionIndexTopCandidate{},
		Breakdown: DomesticOpinionIndexBreakdown{
			Latest: nil,
			Trend:  []DomesticOpinionIndexBreakdownPoint{},
			TopKeywords: DomesticOpinionIndexBreakdownTopKeywords{
				Newsnow:  []CandidateKeywordSummary{},
				Pipeline: []CandidateKeywordSummary{},
			},
		},
	}
}

// BuildDomesticOpinionIndex merges the MySQL snapshot trend with the
// processed-article pipeline trend using the 0.75/0.25 weighted fusion and
// returns the exact payload of GET /api/news-aggregator/domestic-opinion-index.
//
// hours is validated by the caller to 1..168 and is clamped again here; a
// non-positive value falls back to the 24 hour default. snapshots, candidates,
// articles and signals are the already-decoded rows of the four source queries:
// the caller applies the same window, ordering and isDomestic predicates as the
// NestJS Prisma queries, and candidates are scoped to the latest snapshot
// bucket.
func BuildDomesticOpinionIndex(
	hours int,
	now time.Time,
	snapshots []opinionSnapshotRow,
	candidates []opinionCandidateRow,
	articles []opinionPipelineArticleRow,
	signals map[string]processedItemSignal,
) DomesticOpinionIndexResponse {
	requestedHours := hours
	if requestedHours <= 0 {
		requestedHours = defaultTrendHours
	}
	requestedHours = min(max(requestedHours, 1), maxTrendHours)

	since := now.Add(-time.Duration(requestedHours) * time.Hour)

	trendRows := make([]opinionSnapshotRow, 0, len(snapshots))
	for _, row := range snapshots {
		if row.BucketStart.Before(since) {
			continue
		}
		trendRows = append(trendRows, row)
	}
	sort.SliceStable(trendRows, func(i, j int) bool {
		return trendRows[i].BucketStart.Before(trendRows[j].BucketStart)
	})

	pipelineTrend := loadPipelineTrend(since, articles, signals)
	mergedTrend := mergeTrendRows(trendRows, pipelineTrend)

	diagnostics := DomesticOpinionIndexDiagnostics{
		RequestedHours:      requestedHours,
		SnapshotCount:       len(trendRows),
		PipelineBucketCount: len(pipelineTrend),
	}
	if len(mergedTrend) == 0 {
		return buildEmptyResponse(now, diagnostics)
	}

	latest := mergedTrend[len(mergedTrend)-1]

	topCandidates := []DomesticOpinionIndexTopCandidate{}
	if latest.Newsnow != nil {
		topCandidates = loadTopCandidatesForBucket(candidates)
	}

	breakdownTopKeywords := buildBreakdownTopKeywords(latest)
	combinedKeywords := make([]CandidateKeywordSummary, 0, len(breakdownTopKeywords.Newsnow)+len(breakdownTopKeywords.Pipeline))
	combinedKeywords = append(combinedKeywords, breakdownTopKeywords.Newsnow...)
	combinedKeywords = append(combinedKeywords, breakdownTopKeywords.Pipeline...)

	trend := make([]DomesticOpinionIndexPoint, 0, len(mergedTrend))
	breakdownTrend := make([]DomesticOpinionIndexBreakdownPoint, 0, len(mergedTrend))
	for _, row := range mergedTrend {
		trend = append(trend, row.Point)
		breakdownTrend = append(breakdownTrend, toBreakdownPoint(row))
	}

	latestPoint := latest.Point
	latestBreakdown := toBreakdownPoint(latest)

	return DomesticOpinionIndexResponse{
		GeneratedAt:   toISOStringMillis(now),
		DataState:     NewsnowDataStateReady,
		EmptyReason:   nil,
		Diagnostics:   diagnostics,
		Latest:        &latestPoint,
		Trend:         trend,
		TopKeywords:   mergeKeywordSummaries(combinedKeywords),
		TopCandidates: topCandidates,
		Breakdown: DomesticOpinionIndexBreakdown{
			Latest:      &latestBreakdown,
			Trend:       breakdownTrend,
			TopKeywords: breakdownTopKeywords,
		},
	}
}

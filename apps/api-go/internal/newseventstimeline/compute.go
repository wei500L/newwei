package newseventstimeline

import (
	"math"
	"sort"
	"strings"
	"time"
)

// This file is the pure half of news-events-timeline.service.ts. Every function
// maps one-to-one onto a NestJS method so the unit tests can compare fixed input
// vectors with values derived from the NestJS source.

// normalizeConfidence mirrors normalizeConfidence: numbers only, clamped to 0..1,
// null for anything else (including NaN and infinities).
func normalizeConfidence(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	clamped := math.Max(0, math.Min(1, *value))
	return &clamped
}

// normalizeLegacyCategory mirrors normalizeLegacyCategory: trim, JavaScript
// lowercase, then the closed six-value whitelist.
func normalizeLegacyCategory(value *string) *string {
	trimmed := normalizeOptionalString(value)
	if trimmed == nil {
		return nil
	}
	normalized := jsToLower(*trimmed)
	if _, ok := legacyCategories[normalized]; !ok {
		return nil
	}
	return &normalized
}

// normalizeCategoryPath mirrors normalizeCategoryPath: trim, lowercase,
// backslashes to slashes, every \s+ run to "-", every "/"+ run to "/", then strip
// leading and trailing slashes.
func normalizeCategoryPath(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := jsTrim(*value)
	normalized = jsToLower(normalized)
	normalized = strings.ReplaceAll(normalized, "\\", "/")
	normalized = collapseWhitespaceRuns(normalized)
	normalized = collapseSlashRuns(normalized)
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return nil
	}
	return &normalized
}

// collapseWhitespaceRuns replaces every run matched by the JavaScript \s+ with a
// single dash.
func collapseWhitespaceRuns(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	inRun := false
	for _, r := range value {
		if jsIsSpace(r) {
			if !inRun {
				builder.WriteByte('-')
				inRun = true
			}
			continue
		}
		inRun = false
		builder.WriteRune(r)
	}
	return builder.String()
}

// collapseSlashRuns replaces every "/"+ run with a single slash.
func collapseSlashRuns(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	inRun := false
	for _, r := range value {
		if r == '/' {
			if !inRun {
				builder.WriteRune(r)
				inRun = true
			}
			continue
		}
		inRun = false
		builder.WriteRune(r)
	}
	return builder.String()
}

// normalizeCategoryPrefix mirrors normalizeCategoryPrefix.
func normalizeCategoryPrefix(path *string) string {
	normalized := "uncategorized"
	if value := normalizeCategoryPath(path); value != nil {
		normalized = *value
	}
	segments := make([]string, 0, 3)
	for _, segment := range strings.Split(normalized, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) >= 2 {
		return segments[0] + "/" + segments[1]
	}
	if len(segments) == 1 {
		return segments[0]
	}
	return "uncategorized"
}

// resolveCategoryPath mirrors resolveCategoryPath.
func resolveCategoryPath(item timelineSourceItem) string {
	if path := normalizeCategoryPath(item.CategoryPath); path != nil {
		return *path
	}
	if legacy := normalizeLegacyCategory(item.LegacyCategory); legacy != nil {
		return *legacy
	}
	return "uncategorized"
}

// computeItemImportance mirrors computeItemImportance.
func computeItemImportance(item timelineSourceItem, settings timelineRuntimeSettings) float64 {
	confidence := normalizeConfidence(item.CategoryConfidence)
	effectiveConfidence := 0.0
	if confidence != nil {
		effectiveConfidence = *confidence
	} else if fallback := normalizeConfidence(&settings.ConfidenceFallback); fallback != nil {
		effectiveConfidence = *fallback
	} else {
		effectiveConfidence = 0.5
	}
	quality := 0.5
	if normalized := normalizeConfidence(item.QualityScore); normalized != nil {
		quality = *normalized
	}
	score := 0.72*effectiveConfidence + 0.28*quality
	if effectiveConfidence < settings.LowConfidenceThreshold {
		score *= 0.82
	} else if effectiveConfidence > settings.HighConfidenceThreshold {
		score *= 1.08
	}
	return score
}

// compareTimelineItems mirrors compareTimelineItems and returns the sign of the
// NestJS comparator.
func compareTimelineItems(left, right timelineSourceItem, settings timelineRuntimeSettings) int {
	importanceDelta := computeItemImportance(right, settings) - computeItemImportance(left, settings)
	if math.Abs(importanceDelta) > 1e-9 {
		return compareFloat(importanceDelta)
	}
	timeDelta := right.Timestamp.UnixMilli() - left.Timestamp.UnixMilli()
	if timeDelta != 0 {
		return compareInt64(timeDelta)
	}
	qualityLeft := -1.0
	if left.QualityScore != nil {
		qualityLeft = *left.QualityScore
	}
	qualityRight := -1.0
	if right.QualityScore != nil {
		qualityRight = *right.QualityScore
	}
	if qualityDelta := qualityRight - qualityLeft; qualityDelta != 0 {
		return compareFloat(qualityDelta)
	}
	return localeCompare(left.ProcessedArticleID, right.ProcessedArticleID)
}

func compareFloat(delta float64) int {
	if delta < 0 {
		return -1
	}
	return 1
}

func compareInt64(delta int64) int {
	if delta < 0 {
		return -1
	}
	return 1
}

// buildWeightedCategoryDistribution mirrors buildWeightedCategoryDistribution.
func buildWeightedCategoryDistribution(items []timelineSourceItem, settings timelineRuntimeSettings) *orderedDistribution {
	aggregate := newOrderedDistribution()
	for _, item := range items {
		aggregate.add(resolveCategoryPath(item), computeItemImportance(item, settings))
	}
	return aggregate
}

// collapseDistributionToPrefix mirrors collapseDistributionToPrefix.
func collapseDistributionToPrefix(distribution *orderedDistribution) *orderedDistribution {
	prefixes := newOrderedDistribution()
	for _, entry := range distribution.entries() {
		prefixes.add(normalizeCategoryPrefix(&entry.Key), entry.Value)
	}
	return prefixes
}

// computeBucketCategoryConfidence mirrors computeBucketCategoryConfidence.
func computeBucketCategoryConfidence(items []timelineSourceItem, dominantCategoryPath *string, settings timelineRuntimeSettings) *float64 {
	weighted := 0.0
	totalWeight := 0.0
	for _, item := range items {
		confidence := normalizeConfidence(item.CategoryConfidence)
		if confidence == nil {
			continue
		}
		itemPath := resolveCategoryPath(item)
		if dominantCategoryPath != nil && itemPath != *dominantCategoryPath {
			continue
		}
		weight := computeItemImportance(item, settings)
		weighted += *confidence * weight
		totalWeight += weight
	}
	if totalWeight <= 0 {
		return nil
	}
	clamped := math.Max(0, math.Min(1, weighted/totalWeight))
	return &clamped
}

// normalizeDistribution mirrors normalizeDistribution and returns an ordered
// record so computeKlDivergence can walk it in Object.keys order.
func normalizeDistribution(distribution *orderedDistribution) *orderedDistribution {
	total := 0.0
	for _, entry := range distribution.entries() {
		if !math.IsNaN(entry.Value) && !math.IsInf(entry.Value, 0) {
			total += entry.Value
		}
	}
	normalized := newOrderedDistribution()
	if total <= 0 {
		return normalized
	}
	for _, entry := range distribution.entries() {
		if math.IsNaN(entry.Value) || math.IsInf(entry.Value, 0) || entry.Value <= 0 {
			continue
		}
		normalized.set(entry.Key, entry.Value/total)
	}
	return normalized
}

// pickDominantCategoryPath mirrors pickDominantCategoryPath: strictly greater
// wins, so the first inserted key keeps a tie, and "uncategorized" returns null.
func pickDominantCategoryPath(distribution *orderedDistribution) *string {
	bestPath := ""
	bestWeight := 0.0
	for _, entry := range distribution.entries() {
		if entry.Value > bestWeight {
			bestPath = entry.Key
			bestWeight = entry.Value
		}
	}
	if bestPath == "" || bestPath == "uncategorized" {
		return nil
	}
	return &bestPath
}

// computeKlDivergence mirrors computeKlDivergence. The walk order is
// Object.keys(previous) followed by the new keys of next, which decides the
// float summation order.
func computeKlDivergence(previous, next *orderedDistribution) float64 {
	seen := make(map[string]struct{}, previous.len()+next.len())
	keys := make([]string, 0, previous.len()+next.len())
	for _, key := range append(previous.objectKeys(), next.objectKeys()...) {
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return 0
	}
	divergence := 0.0
	for _, key := range keys {
		p := klEpsilon
		if value, exists := previous.get(key); exists && value > klEpsilon {
			p = value
		}
		q := klEpsilon
		if value, exists := next.get(key); exists && value > klEpsilon {
			q = value
		}
		divergence += p * math.Log(p/q)
	}
	if divergence < 0 {
		return 0
	}
	return divergence
}

// computeCountCategoryDistribution mirrors computeCountCategoryDistribution.
func computeCountCategoryDistribution(items []timelineSourceItem, maxItems int) []categoryDistributionEntry {
	aggregate := newOrderedDistribution()
	for _, item := range items {
		aggregate.add(resolveCategoryPath(item), 1)
	}
	total := 0.0
	for _, entry := range aggregate.entries() {
		total += entry.Value
	}
	if total <= 0 {
		return []categoryDistributionEntry{}
	}
	entries := make([]categoryDistributionEntry, 0, aggregate.len())
	for _, entry := range aggregate.entries() {
		entries = append(entries, categoryDistributionEntry{
			CategoryPath: entry.Key,
			Count:        int(entry.Value),
			Share:        roundTo4(entry.Value / total),
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Count != entries[j].Count {
			return entries[i].Count > entries[j].Count
		}
		return localeCompare(entries[i].CategoryPath, entries[j].CategoryPath) < 0
	})
	limit := maxItems
	if limit < 1 {
		limit = 1
	}
	if len(entries) > limit {
		return entries[:limit]
	}
	return entries
}

// describePrefix mirrors describePrefix.
func describePrefix(prefix string) string {
	switch {
	case strings.HasPrefix(prefix, "tech/ai"):
		return "Technology release"
	case strings.HasPrefix(prefix, "gov/regulation"):
		return "Regulatory response"
	case strings.HasPrefix(prefix, "finance/"):
		return "Market impact"
	case strings.HasPrefix(prefix, "politics/"):
		return "Political reaction"
	case strings.HasPrefix(prefix, "intel/"):
		return "Intelligence assessment"
	case strings.HasPrefix(prefix, "ai/"):
		return "AI development"
	}
	head := prefix
	tail := ""
	if index := strings.Index(prefix, "/"); index >= 0 {
		head = prefix[:index]
		rest := prefix[index+1:]
		if next := strings.Index(rest, "/"); next >= 0 {
			tail = rest[:next]
		} else {
			tail = rest
		}
	}
	if tail != "" {
		return capitalizeWord(head) + " " + capitalizeWord(tail)
	}
	return capitalizeWord(head)
}

// buildPhaseSummaries mirrors buildPhaseSummaries. entries must already be
// sorted by bucketStart ascending.
func buildPhaseSummaries(entries []builtTimelineEntry, settings timelineRuntimeSettings) []timelinePhaseSummary {
	if len(entries) == 0 {
		return []timelinePhaseSummary{}
	}
	type phase struct {
		startAt        time.Time
		endAt          time.Time
		categoryPrefix string
		itemCount      int
		bucketCount    int
	}
	phases := make([]phase, 0, len(entries))
	current := phase{
		startAt:        entries[0].BucketStart,
		endAt:          entries[0].BucketStart,
		categoryPrefix: entries[0].DominantCategoryPrefix,
		itemCount:      entries[0].Classification.ItemCount,
		bucketCount:    1,
	}
	for index := 1; index < len(entries); index++ {
		previous := entries[index-1]
		next := entries[index]
		comparable := previous.Classification.ItemCount >= settings.MinBucketItemsForDrift &&
			next.Classification.ItemCount >= settings.MinBucketItemsForDrift
		driftScore := 0.0
		if comparable {
			driftScore = computeKlDivergence(previous.Distribution, next.Distribution)
		}
		shouldSplit := comparable &&
			(driftScore >= settings.DriftKLThreshold ||
				previous.DominantCategoryPrefix != next.DominantCategoryPrefix)
		if shouldSplit {
			phases = append(phases, current)
			current = phase{
				startAt:        next.BucketStart,
				endAt:          next.BucketStart,
				categoryPrefix: next.DominantCategoryPrefix,
				itemCount:      next.Classification.ItemCount,
				bucketCount:    1,
			}
			continue
		}
		current.endAt = next.BucketStart
		current.itemCount += next.Classification.ItemCount
		current.bucketCount++
	}
	phases = append(phases, current)
	if len(phases) > settings.MaxPhaseSummaries {
		phases = phases[:settings.MaxPhaseSummaries]
	}
	out := make([]timelinePhaseSummary, 0, len(phases))
	for index, item := range phases {
		label := describePrefix(item.categoryPrefix) + " stage"
		out = append(out, timelinePhaseSummary{
			Phase:          index + 1,
			Label:          label,
			CategoryPrefix: item.categoryPrefix,
			StartAt:        formatISOMillis(item.startAt),
			EndAt:          formatISOMillis(item.endAt),
			ItemCount:      item.itemCount,
			BucketCount:    item.bucketCount,
			Summary:        label + " (" + item.categoryPrefix + ")",
		})
	}
	return out
}

// analyzeTimeline mirrors analyzeTimeline.
func analyzeTimeline(items []timelineSourceItem, entries []builtTimelineEntry, settings timelineRuntimeSettings) timelineAnalysis {
	countDistribution := computeCountCategoryDistribution(items, settings.MaxCategoryDistributionItems)
	sortedEntries := make([]builtTimelineEntry, len(entries))
	copy(sortedEntries, entries)
	sort.SliceStable(sortedEntries, func(i, j int) bool {
		return sortedEntries[i].BucketStart.Before(sortedEntries[j].BucketStart)
	})

	driftWarnings := make([]topicDriftWarning, 0)
	maxKL := 0.0
	evaluatedTransitions := 0
	for index := 1; index < len(sortedEntries); index++ {
		previous := sortedEntries[index-1]
		current := sortedEntries[index]
		comparable := previous.Classification.ItemCount >= settings.MinBucketItemsForDrift &&
			current.Classification.ItemCount >= settings.MinBucketItemsForDrift
		if !comparable {
			continue
		}
		evaluatedTransitions++
		divergence := computeKlDivergence(previous.Distribution, current.Distribution)
		if divergence > maxKL {
			maxKL = divergence
		}
		if divergence >= settings.DriftKLThreshold {
			driftWarnings = append(driftWarnings, topicDriftWarning{
				FromBucketStart:    formatISOMillis(previous.BucketStart),
				ToBucketStart:      formatISOMillis(current.BucketStart),
				KLDivergence:       roundTo4(divergence),
				FromCategoryPrefix: previous.DominantCategoryPrefix,
				ToCategoryPrefix:   current.DominantCategoryPrefix,
			})
		}
	}

	topShare := 0.0
	if len(countDistribution) > 0 {
		topShare = countDistribution[0].Share
	}
	crossCategoryShare := math.Max(0, 1-topShare)
	crossCategoryWarning := crossCategoryShare > settings.CrossCategoryWarningShare
	phaseSummaries := buildPhaseSummaries(sortedEntries, settings)
	topicDriftWarning := crossCategoryWarning ||
		len(driftWarnings) > 0 ||
		len(phaseSummaries) > 1

	summaryParts := make([]string, 0, 3)
	if crossCategoryWarning {
		summaryParts = append(summaryParts,
			"cross-category share "+jsToFixed(crossCategoryShare*100, 1)+"%")
	}
	if len(driftWarnings) > 0 || evaluatedTransitions > 0 {
		summaryParts = append(summaryParts,
			"max KL "+jsToFixed(maxKL, 3)+" across "+
				formatInt(evaluatedTransitions)+" evaluated transitions")
	}
	if len(phaseSummaries) > 1 {
		summaryParts = append(summaryParts,
			formatInt(len(phaseSummaries))+" timeline phases detected")
	}
	var topicDriftSummary *string
	if len(summaryParts) > 0 {
		joined := strings.Join(summaryParts, "; ")
		topicDriftSummary = &joined
	}

	return timelineAnalysis{
		CategoryDistribution: countDistribution,
		TopicDriftWarning:    topicDriftWarning,
		TopicDriftSummary:    topicDriftSummary,
		DriftWarnings:        driftWarnings,
		PhaseSummaries:       phaseSummaries,
	}
}

// buildTimelineSubEvents mirrors buildTimelineSubEvents.
func buildTimelineSubEvents(eventID string, phaseSummaries []timelinePhaseSummary) []timelineSubEvent {
	out := make([]timelineSubEvent, 0, len(phaseSummaries))
	for _, phase := range phaseSummaries {
		out = append(out, timelineSubEvent{
			ID:            eventID + ":" + formatInt(phase.Phase),
			ParentEventID: eventID,
			Phase:         phase.Phase,
			Title:         phase.Label,
			CategoryPath:  phase.CategoryPrefix,
			StartAt:       phase.StartAt,
			EndAt:         phase.EndAt,
			ItemCount:     phase.ItemCount,
			BucketCount:   phase.BucketCount,
			Summary:       phase.Summary,
		})
	}
	return out
}

// buildTimelineEntry mirrors buildTimelineEntry.
func buildTimelineEntry(eventID string, bucketStart time.Time, items []timelineSourceItem, settings timelineRuntimeSettings) builtTimelineEntry {
	sorted := make([]timelineSourceItem, len(items))
	copy(sorted, items)
	sort.SliceStable(sorted, func(i, j int) bool {
		return compareTimelineItems(sorted[i], sorted[j], settings) < 0
	})
	primary := sorted[0]

	referenced := referencedArticleIDs(items)

	weighted := buildWeightedCategoryDistribution(items, settings)
	weightedPrefix := collapseDistributionToPrefix(weighted)
	normalized := normalizeDistribution(weightedPrefix)
	dominantCategoryPath := pickDominantCategoryPath(weighted)
	dominantCategoryPrefix := ""
	if prefix := pickDominantCategoryPath(weightedPrefix); prefix != nil {
		dominantCategoryPrefix = *prefix
	} else {
		dominantCategoryPrefix = normalizeCategoryPrefix(dominantCategoryPath)
	}
	categoryConfidence := computeBucketCategoryConfidence(items, dominantCategoryPath, settings)
	tentative := categoryConfidence != nil && *categoryConfidence < settings.LowConfidenceThreshold
	anchor := categoryConfidence != nil && *categoryConfidence > settings.HighConfidenceThreshold
	primaryImportance := computeItemImportance(primary, settings)

	return builtTimelineEntry{
		EventID:              eventID,
		BucketStart:          bucketStart,
		Title:                primary.Title,
		Summary:              primary.Summary,
		KeyPoints:            primary.KeyPoints,
		ReferencedArticleIDs: referenced,
		Classification: timelineEntryClassification{
			CategoryPath:       dominantCategoryPath,
			CategoryConfidence: categoryConfidence,
			Tentative:          tentative,
			Anchor:             anchor,
			ImportanceScore:    roundTo4(primaryImportance),
			ItemCount:          len(items),
		},
		Distribution:           normalized,
		DominantCategoryPrefix: dominantCategoryPrefix,
	}
}

// referencedArticleIDs mirrors the referencedArticleIds expression: dedupe in
// item order, drop empty ids, sort by UTF-16 code unit and keep the first 20.
func referencedArticleIDs(items []timelineSourceItem) []string {
	seen := make(map[string]struct{}, len(items))
	unique := make([]string, 0, len(items))
	for _, item := range items {
		if _, exists := seen[item.ArticleID]; exists {
			continue
		}
		seen[item.ArticleID] = struct{}{}
		if item.ArticleID == "" {
			continue
		}
		unique = append(unique, item.ArticleID)
	}
	sort.SliceStable(unique, func(i, j int) bool { return utf16Less(unique[i], unique[j]) })
	if len(unique) > maxReferencedArticlesPerBucket {
		return unique[:maxReferencedArticlesPerBucket]
	}
	return unique
}

// dayBucket is one UTC-day bucket.
type dayBucket struct {
	BucketStart time.Time
	Items       []timelineSourceItem
}

// dayBuckets is the Map groupByDayBucket builds: first-occurrence order plus a
// lookup by bucket key.
type dayBuckets struct {
	order []string
	items map[string]*dayBucket
}

// groupByDayBucket mirrors groupByDayBucket.
func groupByDayBucket(items []timelineSourceItem) *dayBuckets {
	buckets := &dayBuckets{items: make(map[string]*dayBucket)}
	for _, item := range items {
		bucketStart := toUTCDayStart(item.Timestamp)
		key := formatISOMillis(bucketStart)
		if existing, ok := buckets.items[key]; ok {
			existing.Items = append(existing.Items, item)
			continue
		}
		buckets.order = append(buckets.order, key)
		buckets.items[key] = &dayBucket{BucketStart: bucketStart, Items: []timelineSourceItem{item}}
	}
	return buckets
}

func (b *dayBuckets) get(key string) (*dayBucket, bool) {
	bucket, ok := b.items[key]
	return bucket, ok
}

// sortedKeys mirrors Array.from(buckets.keys()).sort(), which orders by UTF-16
// code unit. The keys are Date.toISOString values, so byte order is the same.
func (b *dayBuckets) sortedKeys() []string {
	keys := make([]string, len(b.order))
	copy(keys, b.order)
	sort.Strings(keys)
	return keys
}

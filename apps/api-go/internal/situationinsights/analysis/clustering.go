package analysis

import (
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

const (
	clusterTitleSimilarityThreshold = 0.74
	clusterMaxTimeDiffMS            = 36 * 60 * 60 * 1000
)

var titleStopWords = map[string]bool{
	"a": true, "an": true, "and": true, "at": true, "by": true, "for": true,
	"from": true, "in": true, "of": true, "on": true, "or": true, "the": true,
	"to": true, "with": true,
}

var trailingSourceSuffixes = []string{
	"reuters", "associated press", "ap", "afp", "bbc", "cnn", "fox news",
	"the guardian", "bloomberg", "financial times", "new york times",
	"washington post",
}

var trackingQueryParams = []string{
	"cmpid", "fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "spm",
	"utm_campaign", "utm_content", "utm_id", "utm_medium", "utm_source", "utm_term",
}

var (
	nonTitleCharPattern = regexp.MustCompile(`[^a-z0-9]+`)
	multiSpacePattern   = regexp.MustCompile(`\s+`)
)

// ClusterBuildOptions mirrors SituationMonitorClusterBuildOptions.
type ClusterBuildOptions struct {
	MaxClustersPerCategory int
	MaxItemsPerCluster     int
}

// CategoryClusterMetrics mirrors SituationMonitorCategoryClusterMetrics.
type CategoryClusterMetrics struct {
	ClusterCount            int
	MixedSourceClusterCount int
	DistinctSourceCount     int
}

// ClusterQualitySummary mirrors SituationMonitorClusterQualitySummary.
type ClusterQualitySummary struct {
	ArticleCount            int
	ClusterCount            int
	MixedSourceClusterCount int
	DedupeRatio             *float64
	AvgSourcesPerCluster    *float64
}

type clusterAccumulator struct {
	category         Category
	items            []Headline
	canonicalURLs    map[string]bool
	normalizedTitles map[string]bool
	duplicateKeys    map[string]bool
	sourceKeys       map[string]bool
	latestTimestamp  int64
	hasInternal      bool
	hasExternal      bool
	isAlert          bool
}

// BuildSituationMonitorEventClusters mirrors buildSituationMonitorEventClusters.
func BuildSituationMonitorEventClusters(headlines HeadlinesByCategory, options ClusterBuildOptions) ClustersByCategory {
	maxClusters := clampOption(options.MaxClustersPerCategory, 1, 200, 6)
	maxItems := clampOption(options.MaxItemsPerCluster, 1, 100, 6)

	out := ClustersByCategory{
		Politics: []EventCluster{}, Tech: []EventCluster{}, Finance: []EventCluster{},
		Gov: []EventCluster{}, AI: []EventCluster{}, Intel: []EventCluster{},
	}
	for _, category := range Categories {
		bucket := headlines.Bucket(category)
		if bucket == nil {
			continue
		}
		clusters := buildCategoryClusters(*bucket)
		if len(clusters) > maxClusters {
			clusters = clusters[:maxClusters]
		}
		trimmed := make([]EventCluster, 0, len(clusters))
		for _, cluster := range clusters {
			trimmed = append(trimmed, trimClusterItems(cluster, maxItems))
		}
		target := out.Bucket(category)
		if target != nil {
			*target = trimmed
		}
	}
	return out
}

// SummarizeCategoryClusters mirrors summarizeSituationMonitorCategoryClusters.
func SummarizeCategoryClusters(headlines []Headline, clusters []EventCluster) CategoryClusterMetrics {
	distinct := map[string]bool{}
	for _, headline := range headlines {
		if key := normalizeSourceKey(headline.Source); key != "" {
			distinct[key] = true
		}
	}
	mixed := 0
	for _, cluster := range clusters {
		if cluster.MixedSource {
			mixed++
		}
	}
	return CategoryClusterMetrics{
		ClusterCount:            len(clusters),
		MixedSourceClusterCount: mixed,
		DistinctSourceCount:     len(distinct),
	}
}

// SummarizeClusterQuality mirrors summarizeSituationMonitorClusterQuality.
func SummarizeClusterQuality(headlines HeadlinesByCategory, clusters ClustersByCategory) ClusterQualitySummary {
	articleCount := 0
	for _, bucket := range headlines.All() {
		articleCount += len(bucket)
	}
	allClusters := make([]EventCluster, 0)
	for _, category := range Categories {
		bucket := clusters.Bucket(category)
		if bucket != nil {
			allClusters = append(allClusters, (*bucket)...)
		}
	}
	clusterCount := len(allClusters)
	mixed := 0
	sourceSum := 0
	for _, cluster := range allClusters {
		if cluster.MixedSource {
			mixed++
		}
		sourceSum += cluster.DistinctSourceCount
	}
	var avg *float64
	if clusterCount > 0 {
		value := roundToSingleDecimal(float64(sourceSum) / float64(clusterCount))
		avg = &value
	}
	var dedupe *float64
	if articleCount > 0 {
		value := roundToSingleDecimal(float64(articleCount-clusterCount) / float64(articleCount))
		dedupe = &value
	}
	return ClusterQualitySummary{
		ArticleCount:            articleCount,
		ClusterCount:            clusterCount,
		MixedSourceClusterCount: mixed,
		DedupeRatio:             dedupe,
		AvgSourcesPerCluster:    avg,
	}
}

func buildCategoryClusters(headlines []Headline) []EventCluster {
	accumulators := make([]*clusterAccumulator, 0)
	ordered := append([]Headline(nil), headlines...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Timestamp > ordered[j].Timestamp })

	for _, headline := range ordered {
		var matched *clusterAccumulator
		for _, cluster := range accumulators {
			if matchesCluster(cluster, headline) {
				matched = cluster
				break
			}
		}
		if matched != nil {
			appendHeadline(matched, headline)
			continue
		}
		accumulators = append(accumulators, createClusterAccumulator(headline))
	}

	out := make([]EventCluster, 0, len(accumulators))
	for _, cluster := range accumulators {
		out = append(out, materializeCluster(cluster))
	}
	sort.SliceStable(out, func(i, j int) bool { return compareClusters(out[i], out[j]) < 0 })
	return out
}

func trimClusterItems(cluster EventCluster, maxItems int) EventCluster {
	items := cluster.Items
	if len(items) > maxItems {
		items = items[:maxItems]
	}
	lead := items[0]
	for _, item := range items {
		if item.ID == cluster.Lead.ID {
			lead = item
			break
		}
	}
	cluster.Items = items
	cluster.Lead = lead
	return cluster
}

func createClusterAccumulator(headline Headline) *clusterAccumulator {
	cluster := &clusterAccumulator{
		category:         headline.Category,
		items:            []Headline{headline},
		canonicalURLs:    map[string]bool{},
		normalizedTitles: map[string]bool{},
		duplicateKeys:    map[string]bool{},
		sourceKeys:       map[string]bool{},
		latestTimestamp:  headline.Timestamp,
		hasInternal:      headline.Origin == "items",
		hasExternal:      headline.Origin == "gdelt",
		isAlert:          headline.IsAlert,
	}
	if canonical := canonicalizeURL(headline.Link); canonical != "" {
		cluster.canonicalURLs[canonical] = true
	}
	if title := normalizeTitle(headline.Title); title != "" {
		cluster.normalizedTitles[title] = true
	}
	for _, key := range headlineDuplicateKeys(headline) {
		cluster.duplicateKeys[key] = true
	}
	if key := normalizeSourceKey(headline.Source); key != "" {
		cluster.sourceKeys[key] = true
	}
	return cluster
}

func appendHeadline(cluster *clusterAccumulator, headline Headline) {
	cluster.items = append(cluster.items, headline)
	if canonical := canonicalizeURL(headline.Link); canonical != "" {
		cluster.canonicalURLs[canonical] = true
	}
	if title := normalizeTitle(headline.Title); title != "" {
		cluster.normalizedTitles[title] = true
	}
	for _, key := range headlineDuplicateKeys(headline) {
		cluster.duplicateKeys[key] = true
	}
	if key := normalizeSourceKey(headline.Source); key != "" {
		cluster.sourceKeys[key] = true
	}
	if headline.Timestamp > cluster.latestTimestamp {
		cluster.latestTimestamp = headline.Timestamp
	}
	cluster.hasInternal = cluster.hasInternal || headline.Origin == "items"
	cluster.hasExternal = cluster.hasExternal || headline.Origin == "gdelt"
	cluster.isAlert = cluster.isAlert || headline.IsAlert
}

func matchesCluster(cluster *clusterAccumulator, headline Headline) bool {
	if cluster.category != headline.Category {
		return false
	}
	if canonical := canonicalizeURL(headline.Link); canonical != "" && cluster.canonicalURLs[canonical] {
		return true
	}
	for _, key := range headlineDuplicateKeys(headline) {
		if cluster.duplicateKeys[key] {
			return true
		}
	}
	normalizedTitle := normalizeTitle(headline.Title)
	if normalizedTitle == "" {
		return false
	}
	if cluster.normalizedTitles[normalizedTitle] {
		return true
	}
	titleTokens := tokenizeTitle(normalizedTitle)
	if len(titleTokens) < 4 {
		return false
	}
	for _, candidate := range cluster.items {
		latest := cluster.latestTimestamp
		if candidate.Timestamp > latest {
			latest = candidate.Timestamp
		}
		diff := latest - headline.Timestamp
		if diff < 0 {
			diff = -diff
		}
		if diff > clusterMaxTimeDiffMS {
			continue
		}
		candidateTitle := normalizeTitle(candidate.Title)
		if candidateTitle == "" {
			continue
		}
		candidateTokens := tokenizeTitle(candidateTitle)
		if len(candidateTokens) < 4 {
			continue
		}
		if jaccardSimilarity(titleTokens, candidateTokens) >= clusterTitleSimilarityThreshold {
			return true
		}
	}
	return false
}

func materializeCluster(cluster *clusterAccumulator) EventCluster {
	items := append([]Headline(nil), cluster.items...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Timestamp > items[j].Timestamp })
	lead := selectClusterLead(items, cluster.hasInternal && cluster.hasExternal)
	internalCount := 0
	externalCount := 0
	for _, item := range items {
		if item.Origin == "items" {
			internalCount++
		}
		if item.Origin == "gdelt" {
			externalCount++
		}
	}
	return EventCluster{
		ID:                  buildClusterID(cluster.category, lead),
		Category:            cluster.category,
		Lead:                lead,
		Items:               items,
		InternalCount:       internalCount,
		ExternalCount:       externalCount,
		DistinctSourceCount: len(cluster.sourceKeys),
		LatestTimestamp:     cluster.latestTimestamp,
		IsAlert:             cluster.isAlert,
		MixedSource:         cluster.hasInternal && cluster.hasExternal,
	}
}

func selectClusterLead(items []Headline, mixedSource bool) Headline {
	ordered := append([]Headline(nil), items...)
	sort.SliceStable(ordered, func(i, j int) bool {
		left, right := ordered[i], ordered[j]
		if left.IsAlert != right.IsAlert {
			return left.IsAlert
		}
		leftHasSummary := strings.TrimSpace(left.Summary) != ""
		rightHasSummary := strings.TrimSpace(right.Summary) != ""
		if leftHasSummary != rightHasSummary {
			return leftHasSummary
		}
		if mixedSource && left.Origin != right.Origin {
			return left.Origin == "items"
		}
		if left.Timestamp != right.Timestamp {
			return left.Timestamp > right.Timestamp
		}
		return left.ID < right.ID
	})
	return ordered[0]
}

// compareClusters returns a negative value when left sorts before right. The
// order mirrors the NestJS comparator exactly; ID comparison uses byte order
// instead of localeCompare, which only differs for non-ASCII IDs.
func compareClusters(left, right EventCluster) int {
	if left.IsAlert != right.IsAlert {
		if left.IsAlert {
			return -1
		}
		return 1
	}
	if left.MixedSource != right.MixedSource {
		if left.MixedSource {
			return -1
		}
		return 1
	}
	if left.DistinctSourceCount != right.DistinctSourceCount {
		return right.DistinctSourceCount - left.DistinctSourceCount
	}
	if left.LatestTimestamp != right.LatestTimestamp {
		if left.LatestTimestamp > right.LatestTimestamp {
			return -1
		}
		return 1
	}
	if left.InternalCount != right.InternalCount {
		return right.InternalCount - left.InternalCount
	}
	return strings.Compare(left.ID, right.ID)
}

func buildClusterID(category Category, lead Headline) string {
	if canonical := canonicalizeURL(lead.Link); canonical != "" {
		return string(category) + ":" + canonical
	}
	if normalized := normalizeTitle(lead.Title); normalized != "" {
		return string(category) + ":" + multiSpacePattern.ReplaceAllString(normalized, "-")
	}
	return string(category) + ":" + lead.ID
}

func headlineDuplicateKeys(headline Headline) []string {
	values := []string{headline.DuplicateOf, headline.ID, headline.ItemMetaID}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// canonicalizeURL mirrors canonicalizeUrl. The returned value is
// hostname+pathname+search with the NestJS quirks preserved: the port is
// dropped because only URL.hostname is read, tracking parameters are removed
// and the remaining parameters are sorted by key.
func canonicalizeURL(input string) string {
	normalized := strings.TrimSpace(input)
	if normalized == "" {
		return ""
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return strings.ToLower(normalized)
	}
	parsed.Fragment = ""
	host := strings.ToLower(parsed.Hostname())
	values := parsed.Query()
	for _, param := range trackingQueryParams {
		values.Del(param)
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var query strings.Builder
	for _, key := range keys {
		for _, value := range values[key] {
			if query.Len() > 0 {
				query.WriteByte('&')
			}
			query.WriteString(url.QueryEscape(key))
			query.WriteByte('=')
			query.WriteString(url.QueryEscape(value))
		}
	}
	path := strings.TrimRight(parsed.Path, "/")
	if path == "" {
		path = "/"
	}
	if query.Len() > 0 {
		return host + path + "?" + query.String()
	}
	return host + path
}

// normalizeTitle mirrors normalizeTitle, including the ASCII-only
// [^a-z0-9] replacement after lower-casing.
func normalizeTitle(input string) string {
	normalized := strings.ToLower(strings.TrimSpace(input))
	if normalized == "" {
		return ""
	}
	for _, suffix := range trailingSourceSuffixes {
		escaped := regexp.QuoteMeta(suffix)
		normalized = regexp.MustCompile(`(?i)\s+[\-|:]\s+`+escaped+`$`).ReplaceAllString(normalized, "")
		normalized = regexp.MustCompile(`(?i)\s+\|\s+`+escaped+`$`).ReplaceAllString(normalized, "")
	}
	normalized = nonTitleCharPattern.ReplaceAllString(normalized, " ")
	return multiSpacePattern.ReplaceAllString(strings.TrimSpace(normalized), " ")
}

func tokenizeTitle(normalizedTitle string) map[string]bool {
	out := map[string]bool{}
	for _, token := range strings.Split(normalizedTitle, " ") {
		token = strings.TrimSpace(token)
		if len(token) > 1 && !titleStopWords[token] {
			out[token] = true
		}
	}
	return out
}

func jaccardSimilarity(left, right map[string]bool) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	for token := range left {
		if right[token] {
			intersection++
		}
	}
	union := len(left) + len(right) - intersection
	if union <= 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func normalizeSourceKey(source string) string {
	return strings.ToLower(strings.TrimSpace(source))
}

func roundToSingleDecimal(value float64) float64 {
	return math.Round(value*10) / 10
}

func clampOption(value, min, max, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

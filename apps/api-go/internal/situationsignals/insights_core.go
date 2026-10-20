package situationsignals

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

const (
	insightsHistoryRetentionMinutes = 30
	insightsCorrelationTTLSeconds   = (insightsHistoryRetentionMinutes + insightsMomentumWindowMinutes + 5) * 60
)

// insightsCorePayload is both the wrap() cache value and the core response
// fragment. Its JSON tags are therefore part of the NestJS cache contract, not
// an internal detail: Nest writes the same camelCase members and reads them back.
type insightsCorePayload struct {
	Diagnostics          insightsDiagnostics           `json:"diagnostics"`
	CoverageSummary      insightsCoverageSummary       `json:"coverageSummary"`
	Headlines            analysis.HeadlinesByCategory  `json:"headlines"`
	Clusters             analysis.ClustersByCategory   `json:"clusters"`
	AnalyzedItems        int                           `json:"analyzedItems"`
	ExternalSnapshot     *externalSnapshotInfo         `json:"externalSnapshot,omitempty"`
	Warnings             []insightsWarning             `json:"warnings,omitempty"`
	Alerts               []analysis.AlertHeadline      `json:"alerts"`
	Leaders              []analysis.WorldLeader        `json:"leaders"`
	Situations           []analysis.SituationPanel     `json:"situations"`
	Correlation          *analysis.CorrelationResults  `json:"correlation"`
	CorrelationSummary   analysis.CorrelationSummary   `json:"correlationSummary"`
	Pizzint              *pizzintSnapshot              `json:"pizzint,omitempty"`
	Tensions             []tensionPair                 `json:"tensions"`
	Narrative            *analysis.NarrativeResults    `json:"narrative"`
	NarrativeSummary     analysis.NarrativeSummary     `json:"narrativeSummary"`
	MainCharacter        analysis.MainCharacterResults `json:"mainCharacter"`
	MainCharacterSummary analysis.MainCharacterSummary `json:"mainCharacterSummary"`
}

func applyCorePayload(response *insightsResponse, core insightsCorePayload) {
	response.Diagnostics = &core.Diagnostics
	response.CoverageSummary = &core.CoverageSummary
	response.Headlines = &core.Headlines
	response.Clusters = &core.Clusters
	response.AnalyzedItems = core.AnalyzedItems
	if core.ExternalSnapshot != nil {
		response.ExternalSnapshot = core.ExternalSnapshot
	}
	if len(core.Warnings) > 0 {
		response.Warnings = core.Warnings
	}
	alerts := core.Alerts
	response.Alerts = &alerts
	leaders := core.Leaders
	response.Leaders = &leaders
	situations := core.Situations
	response.Situations = &situations
	response.Correlation = &presentValue[*analysis.CorrelationResults]{Value: core.Correlation}
	response.CorrelationSummary = &core.CorrelationSummary
	response.Pizzint = core.Pizzint
	tensions := core.Tensions
	response.Tensions = &tensions
	response.Narrative = &presentValue[*analysis.NarrativeResults]{Value: core.Narrative}
	response.NarrativeSummary = &core.NarrativeSummary
	response.MainCharacter = &core.MainCharacter
	response.MainCharacterSummary = &core.MainCharacterSummary
}

func (s *insightsService) loadCore(ctx context.Context, orgID string, since time.Time, windowHours, maxItems, analysisPerCategory int, allowGdelt bool, scope string, debug bool) (insightsCorePayload, error) {
	payload := insightsCorePayload{}
	warnings := make([]insightsWarning, 0)

	var snapshot snapshotReadResult
	if allowGdelt {
		read, err := s.readExternalSnapshot(ctx)
		if err != nil {
			return payload, err
		}
		snapshot = read
	}

	headlines, err := s.buildHeadlinesByCategory(ctx, orgID, since, maxItems, analysisPerCategory, scope, debug)
	if err != nil {
		return payload, err
	}
	if snapshot.Payload != nil {
		mergeSnapshotHeadlinesByCategory(&headlines, snapshot.Payload, since, analysisPerCategory)
		for _, warning := range snapshot.Payload.Warnings {
			warnings = append(warnings, insightsWarning{
				Code: warning.Code, Source: "gdelt", Severity: insightSeverity(warning.Severity),
				Message: warning.Message, Detail: warning.Detail,
			})
		}
	}

	displayHeadlines := displayHeadlinesByCategory(headlines, insightsMaxHeadlinesPerCategory)
	allClusters := analysis.BuildSituationMonitorEventClusters(headlines, analysis.ClusterBuildOptions{
		MaxClustersPerCategory: analysisPerCategory,
		MaxItemsPerCluster:     6,
	})
	displayClusters := displayClustersByCategory(allClusters, 6)
	analysisNews := flattenHeadlinesForAnalysis(headlines)
	analyzedItems := len(analysisNews)

	hasOlderInternal, err := s.hasInternalCoverageOutsideWindow(ctx, orgID, since, scope)
	if err != nil {
		return payload, err
	}
	payload.Diagnostics = buildInsightsDiagnostics(headlines, allClusters, scope)
	payload.CoverageSummary = buildCoverageSummary(analysisNews, headlines, allClusters, snapshot.Payload, since, windowHours, hasOlderInternal)
	payload.Headlines = displayHeadlines
	payload.Clusters = displayClusters
	payload.AnalyzedItems = analyzedItems
	if allowGdelt || snapshot.Payload != nil {
		info := createExternalSnapshotInfo(snapshot.Payload, snapshot.Stale)
		payload.ExternalSnapshot = &info
	}
	if len(warnings) > 0 {
		payload.Warnings = warnings
	}

	nowMinute := s.now().Unix() / 60
	previousMinute := nowMinute - insightsMomentumWindowMinutes
	previousKey := insightsCorrelationCountsPrefix + ":" + orgID + ":" + itoaInt64(previousMinute)
	currentKey := insightsCorrelationCountsPrefix + ":" + orgID + ":" + itoaInt64(nowMinute)
	var previousCounts map[string]int
	if raw, found, err := insightsCacheGetJSON[map[string]int](ctx, s.cache, previousKey); err != nil {
		return payload, err
	} else if found {
		previousCounts = raw
	}

	correlationTopicIDs := analysis.CorrelationTopicIDs()
	narrativeTopicIDs := analysis.NarrativePatternIDs()
	correlationLearning, err := s.getLearningState(ctx, orgID, "correlation", correlationTopicIDs)
	if err != nil {
		return payload, err
	}
	narrativeLearning, err := s.getLearningState(ctx, orgID, "narrative", narrativeTopicIDs)
	if err != nil {
		return payload, err
	}

	correlationOverrides := map[string]analysis.CorrelationLearningOverride{}
	for signalID, state := range correlationLearning {
		correlationOverrides[signalID] = analysis.CorrelationLearningOverride{
			BoostedTokens: state.BoostedTokens, BlockedTokens: state.BlockedTokens,
			SuppressedItemMetaIDs: state.SuppressedItemMetaIDs,
			FalsePositiveCount:    state.FalsePositiveCount, FalseNegativeCount: state.FalseNegativeCount,
		}
	}
	narrativeOverrides := map[string]analysis.NarrativeLearningOverride{}
	for signalID, state := range narrativeLearning {
		narrativeOverrides[signalID] = analysis.NarrativeLearningOverride{
			BoostedTokens: state.BoostedTokens, BlockedTokens: state.BlockedTokens,
			SuppressedItemMetaIDs: state.SuppressedItemMetaIDs,
			FalsePositiveCount:    state.FalsePositiveCount, FalseNegativeCount: state.FalseNegativeCount,
		}
	}

	outcome := analysis.AnalyzeCorrelations(analysisNews, analysis.CorrelationOptions{
		PreviousCounts: previousCounts,
		Learning:       correlationOverrides,
	})
	if err := insightsCacheSetJSON(ctx, s.cache, currentKey, outcome.TopicCounts, time.Duration(insightsCorrelationTTLSeconds)*time.Second); err != nil {
		return payload, err
	}

	realtime, err := s.getRealtimeInsightSnapshot(ctx, orgID)
	if err != nil {
		return payload, err
	}
	realtimeSignals := buildRealtimePredictiveSignals(realtime)
	merged := mergeRealtimeCorrelation(outcome.Results, realtimeSignals)

	narrative := analysis.AnalyzeNarratives(analysisNews, analysis.NarrativeOptions{Learning: narrativeOverrides})
	mainCharacter := analysis.CalculateMainCharacter(analysisNews)

	payload.Alerts = buildAlerts(displayHeadlines)
	payload.Leaders = analysis.BuildWorldLeaders(analysisNews)
	payload.Situations = analysis.BuildSituations(analysisNews, s.now().UnixMilli())
	payload.Correlation = merged
	payload.CorrelationSummary = analysis.GetCorrelationSummary(merged)
	payload.Pizzint = realtime.Pizzint
	tensions := append([]tensionPair(nil), realtime.Tensions...)
	if tensions == nil {
		tensions = []tensionPair{}
	}
	payload.Tensions = tensions
	payload.Narrative = narrative
	payload.NarrativeSummary = analysis.GetNarrativeSummary(narrative)
	payload.MainCharacter = mainCharacter
	payload.MainCharacterSummary = analysis.GetMainCharacterSummary(mainCharacter)
	return payload, nil
}

func displayHeadlinesByCategory(headlines analysis.HeadlinesByCategory, maxPerCategory int) analysis.HeadlinesByCategory {
	out := analysis.HeadlinesByCategory{
		Politics: []analysis.Headline{}, Tech: []analysis.Headline{}, Finance: []analysis.Headline{},
		Gov: []analysis.Headline{}, AI: []analysis.Headline{}, Intel: []analysis.Headline{},
	}
	for _, category := range analysis.Categories {
		source := headlines.Bucket(category)
		target := out.Bucket(category)
		if source == nil || target == nil {
			continue
		}
		items := *source
		if len(items) > maxPerCategory {
			items = items[:maxPerCategory]
		}
		if items == nil {
			items = []analysis.Headline{}
		}
		*target = items
	}
	return out
}

func displayClustersByCategory(clusters analysis.ClustersByCategory, maxPerCategory int) analysis.ClustersByCategory {
	out := analysis.ClustersByCategory{
		Politics: []analysis.EventCluster{}, Tech: []analysis.EventCluster{}, Finance: []analysis.EventCluster{},
		Gov: []analysis.EventCluster{}, AI: []analysis.EventCluster{}, Intel: []analysis.EventCluster{},
	}
	for _, category := range analysis.Categories {
		source := clusters.Bucket(category)
		target := out.Bucket(category)
		if source == nil || target == nil {
			continue
		}
		items := *source
		if len(items) > maxPerCategory {
			items = items[:maxPerCategory]
		}
		if items == nil {
			items = []analysis.EventCluster{}
		}
		*target = items
	}
	return out
}

func flattenHeadlinesForAnalysis(headlines analysis.HeadlinesByCategory) []analysis.NewsItem {
	out := make([]analysis.NewsItem, 0)
	for _, category := range analysis.Categories {
		bucket := headlines.Bucket(category)
		if bucket == nil {
			continue
		}
		for _, headline := range *bucket {
			out = append(out, analysis.NewsItem{
				Title: headline.Title, TitleZh: headline.TitleZh, Link: headline.Link,
				Source: headline.Source, Timestamp: headline.Timestamp, Origin: headline.Origin,
				ItemMeta: headline.ItemMetaID, Summary: headline.Summary,
				KeyPoints: headline.KeyPoints, Topics: headline.Topics,
			})
		}
	}
	return out
}

func buildAlerts(headlines analysis.HeadlinesByCategory) []analysis.AlertHeadline {
	flattened := make([]analysis.Headline, 0)
	for _, category := range analysis.Categories {
		bucket := headlines.Bucket(category)
		if bucket != nil {
			flattened = append(flattened, (*bucket)...)
		}
	}
	filtered := make([]analysis.Headline, 0)
	for _, headline := range flattened {
		if headline.IsAlert {
			filtered = append(filtered, headline)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].Timestamp > filtered[j].Timestamp })
	if len(filtered) > 20 {
		filtered = filtered[:20]
	}
	alerts := make([]analysis.AlertHeadline, 0, len(filtered))
	for _, headline := range filtered {
		severity := "elevated"
		if insightsCriticalKeywords[strings.ToLower(headline.AlertKeyword)] {
			severity = "critical"
		}
		alerts = append(alerts, analysis.AlertHeadline{Headline: headline, Severity: severity})
	}
	return alerts
}

func buildInsightsDiagnostics(headlines analysis.HeadlinesByCategory, clusters analysis.ClustersByCategory, scope string) insightsDiagnostics {
	diagnostics := insightsDiagnostics{RequestedScope: scope, EffectiveScope: scope}
	for _, category := range analysis.Categories {
		bucket := headlines.Bucket(category)
		clusterBucket := clusters.Bucket(category)
		items := []analysis.Headline{}
		if bucket != nil {
			items = *bucket
		}
		categoryClusters := []analysis.EventCluster{}
		if clusterBucket != nil {
			categoryClusters = *clusterBucket
		}
		internalCount := 0
		gdeltCount := 0
		for _, item := range items {
			if item.Origin == "items" {
				internalCount++
			}
			if item.Origin == "gdelt" {
				gdeltCount++
			}
		}
		metrics := analysis.SummarizeCategoryClusters(items, categoryClusters)
		entry := insightsCategoryDiagnostics{
			InternalCount: internalCount, GdeltFallbackCount: gdeltCount,
			TotalCount: len(items), ClusterCount: metrics.ClusterCount,
			MixedSourceClusterCount: metrics.MixedSourceClusterCount,
			DistinctSourceCount:     metrics.DistinctSourceCount,
		}
		switch category {
		case analysis.CategoryPolitics:
			diagnostics.Categories.Politics = entry
		case analysis.CategoryTech:
			diagnostics.Categories.Tech = entry
		case analysis.CategoryFinance:
			diagnostics.Categories.Finance = entry
		case analysis.CategoryGov:
			diagnostics.Categories.Gov = entry
		case analysis.CategoryAI:
			diagnostics.Categories.AI = entry
		case analysis.CategoryIntel:
			diagnostics.Categories.Intel = entry
		}
	}
	return diagnostics
}

func buildCoverageSummary(analysisNews []analysis.NewsItem, headlines analysis.HeadlinesByCategory, clusters analysis.ClustersByCategory, snapshot *snapshotPayload, since time.Time, windowHours int, hasOlderInternal bool) insightsCoverageSummary {
	internalAnalyzed := 0
	externalAnalyzed := 0
	for _, item := range analysisNews {
		if item.Origin == "items" {
			internalAnalyzed++
		}
		if item.Origin == "gdelt" {
			externalAnalyzed++
		}
	}
	quality := analysis.SummarizeClusterQuality(headlines, clusters)
	visible := 0
	missing := make([]analysis.Category, 0)
	for _, category := range analysis.Categories {
		bucket := clusters.Bucket(category)
		if bucket != nil && len(*bucket) > 0 {
			visible++
		} else {
			missing = append(missing, category)
		}
	}
	sinceMS := since.UnixMilli()
	hasOlderSnapshot := false
	if snapshot != nil {
		for _, category := range analysis.Categories {
			bucket := snapshot.HeadlinesByCategory.Bucket(category)
			if bucket == nil {
				continue
			}
			for _, headline := range *bucket {
				if headline.Timestamp < sinceMS {
					hasOlderSnapshot = true
					break
				}
			}
			if hasOlderSnapshot {
				break
			}
		}
	}
	hasOlder := windowHours < 168 && (hasOlderInternal || hasOlderSnapshot)
	var recommended *int
	if hasOlder && windowHours < 168 && len(analysisNews) < 12 {
		value := 168
		recommended = &value
	}
	mode := "empty"
	if internalAnalyzed > 0 && externalAnalyzed > 0 {
		mode = "internal+external"
	} else if internalAnalyzed > 0 {
		mode = "internal-only"
	} else if externalAnalyzed > 0 {
		mode = "external-only"
	}
	return insightsCoverageSummary{
		Mode: mode, ArticleCount: quality.ArticleCount, ClusterCount: quality.ClusterCount,
		InternalAnalyzedItems: internalAnalyzed, ExternalAnalyzedItems: externalAnalyzed,
		MixedSourceClusterCount: quality.MixedSourceClusterCount,
		DedupeRatio:             quality.DedupeRatio, AvgSourcesPerCluster: quality.AvgSourcesPerCluster,
		VisibleCategoryCount: visible, MissingCategories: missing,
		HasOlderItemsOutsideWindow: hasOlder, RecommendedWindowHours: recommended,
	}
}

type insightsLearningState struct {
	FalsePositiveCount    int
	FalseNegativeCount    int
	SuppressedItemMetaIDs []string
	BoostedTokens         []string
	BlockedTokens         []string
}

func (s *insightsService) getLearningState(ctx context.Context, orgID, signalType string, signalIDs []string) (map[string]insightsLearningState, error) {
	ids := make([]string, 0, len(signalIDs))
	seen := map[string]bool{}
	for _, id := range signalIDs {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		ids = append(ids, trimmed)
	}
	if len(ids) == 0 {
		return map[string]insightsLearningState{}, nil
	}
	if s.mongo == nil {
		return nil, errNoDatabase
	}
	cursor, err := s.mongo.Collection(learningStateCollection).Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "signalType", Value: signalType},
		{Key: "signalId", Value: bson.D{{Key: "$in", Value: ids}}},
	}, options.Find().SetProjection(bson.D{
		{Key: "signalType", Value: 1}, {Key: "signalId", Value: 1},
		{Key: "falsePositiveCount", Value: 1}, {Key: "falseNegativeCount", Value: 1},
		{Key: "suppressedItemMetaIds", Value: 1}, {Key: "boostedTokenCounts", Value: 1},
		{Key: "blockedTokenCounts", Value: 1},
	}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []insightsLearningDoc
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	out := map[string]insightsLearningState{}
	for _, doc := range docs {
		signalID := insightsLooseString(doc.SignalID)
		boosted := insightsPickActiveTokens(doc.BoostedTokenCounts, 1)
		blocked := insightsPickActiveTokens(doc.BlockedTokenCounts, 2)
		suppressed := insightsRawStringArrayOrEmpty(doc.SuppressedItemMetaIDs)
		out[signalID] = insightsLearningState{
			FalsePositiveCount:    safeInsightsInt(doc.FalsePositiveCount),
			FalseNegativeCount:    safeInsightsInt(doc.FalseNegativeCount),
			SuppressedItemMetaIDs: suppressed, BoostedTokens: boosted, BlockedTokens: blocked,
		}
	}
	return out, nil
}

type insightsLearningDoc struct {
	SignalID              bson.RawValue `bson:"signalId"`
	FalsePositiveCount    bson.RawValue `bson:"falsePositiveCount"`
	FalseNegativeCount    bson.RawValue `bson:"falseNegativeCount"`
	SuppressedItemMetaIDs bson.RawValue `bson:"suppressedItemMetaIds"`
	BoostedTokenCounts    bson.RawValue `bson:"boostedTokenCounts"`
	BlockedTokenCounts    bson.RawValue `bson:"blockedTokenCounts"`
}

func insightsPickActiveTokens(value bson.RawValue, threshold int) []string {
	if value.Type != bson.TypeEmbeddedDocument {
		return []string{}
	}
	document := value.Document()
	elements, err := document.Elements()
	if err != nil {
		return []string{}
	}
	type tokenCount struct {
		token string
		count float64
	}
	entries := make([]tokenCount, 0)
	for _, element := range elements {
		key := element.Key()
		count, ok := insightsRawNumber(element.Value())
		if !ok {
			count = 0
		}
		if key == "" {
			continue
		}
		entries = append(entries, tokenCount{token: key, count: count})
	}
	filtered := make([]tokenCount, 0)
	for _, entry := range entries {
		if entry.count >= float64(threshold) {
			filtered = append(filtered, entry)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].count > filtered[j].count })
	out := make([]string, 0, 25)
	for _, entry := range filtered {
		out = append(out, entry.token)
		if len(out) >= 25 {
			break
		}
	}
	return out
}

func safeInsightsInt(value bson.RawValue) int {
	number, ok := insightsRawNumber(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0
	}
	if number < 0 {
		return 0
	}
	return int(number)
}

func itoaInt64(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	buffer := make([]byte, 0, 20)
	for value > 0 {
		buffer = append(buffer, byte('0'+value%10))
		value /= 10
	}
	if negative {
		buffer = append(buffer, '-')
	}
	for left, right := 0, len(buffer)-1; left < right; left, right = left+1, right-1 {
		buffer[left], buffer[right] = buffer[right], buffer[left]
	}
	return string(buffer)
}

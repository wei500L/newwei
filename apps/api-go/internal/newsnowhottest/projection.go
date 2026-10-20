package newsnowhottest

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
)

// candidateClusterAggregate is one cluster scored for one organization.
type candidateClusterAggregate struct {
	cluster        SignalCluster
	insight        *ClusterInsight
	items          []Signal
	authority      float64
	heatScore      float64
	freshnessScore float64
	candidateScore float64
}

// insightContentKind returns the insight content kind or unknown.
func (a candidateClusterAggregate) insightContentKind() ContentKind {
	if a.insight == nil {
		return ContentUnknown
	}
	return a.insight.ContentKind
}

// insightBridgeSuggestion returns the model bridge suggestion or false.
func (a candidateClusterAggregate) insightBridgeSuggestion() bool {
	if a.insight == nil {
		return false
	}
	return a.insight.BridgeEligibleSuggestion
}

// buildAnalysisFromGlobalSnapshot ports buildAnalysisFromGlobalSnapshot. The
// organization only reads the shared snapshot; every match it produces is
// scoped to the caller's organization (H1).
func (s *Service) buildAnalysisFromGlobalSnapshot(
	ctx context.Context,
	orgID, userID string,
	allowAutoBridge bool,
	snapshot GlobalSnapshot,
) (AnalysisResponse, error) {
	generatedAt := s.now()
	metadata := s.getHottestMetadataContext()
	normalizedSignals := s.buildSignalsFromSeeds(ctx, orgID, snapshot.SignalSeeds, generatedAt)
	insightByClusterID := make(map[string]ClusterInsight, len(snapshot.ClusterInsights))
	for _, insight := range snapshot.ClusterInsights {
		insightByClusterID[insight.ClusterID] = insight
	}
	aggregates, clusterBySignalKey := buildClusterAggregates(normalizedSignals, snapshot.Clusters, insightByClusterID, snapshot.GlobalMaxHeatValue)

	type prioritizedSignal struct {
		aggregate candidateClusterAggregate
		item      Signal
	}
	prioritized := make([]prioritizedSignal, 0, len(normalizedSignals))
	for _, aggregate := range aggregates {
		for _, item := range aggregate.items {
			if item.Rank <= priorityRankThreshold || len(aggregate.cluster.SourceIDs) > 1 {
				prioritized = append(prioritized, prioritizedSignal{aggregate: aggregate, item: item})
			}
		}
	}
	sort.SliceStable(prioritized, func(left, right int) bool {
		if prioritized[left].aggregate.candidateScore != prioritized[right].aggregate.candidateScore {
			return prioritized[left].aggregate.candidateScore > prioritized[right].aggregate.candidateScore
		}
		return prioritized[left].item.Rank < prioritized[right].item.Rank
	})

	guaranteedBridgeKeys := make(map[string]struct{}, len(prioritized))
	for _, entry := range prioritized {
		if entry.item.Rank > bridgeRankThreshold {
			continue
		}
		if !s.isBridgeEligible(entry.item, resolveContentKind(string(entry.aggregate.insightContentKind())),
			entry.aggregate.candidateScore, entry.aggregate.insightBridgeSuggestion()) {
			continue
		}
		guaranteedBridgeKeys[entry.item.SignalKey] = struct{}{}
	}

	// signalsToResolve keeps the priority order of the first MAX_RESOLVE_ITEMS
	// entries plus every guaranteed bridge signal beyond that cut.
	uniqueSignals := make([]Signal, 0, len(prioritized))
	seenSignalKeys := make(map[string]struct{}, len(prioritized))
	for index, entry := range prioritized {
		if index >= maxResolveItems {
			if _, guaranteed := guaranteedBridgeKeys[entry.item.SignalKey]; !guaranteed {
				continue
			}
		}
		if _, exists := seenSignalKeys[entry.item.SignalKey]; exists {
			continue
		}
		seenSignalKeys[entry.item.SignalKey] = struct{}{}
		uniqueSignals = append(uniqueSignals, entry.item)
	}
	matches := s.resolveMatches(ctx, orgID, uniqueSignals)

	analysisBySignalKey := make(map[string]AnalyzedItem, len(normalizedSignals))
	for _, signal := range normalizedSignals {
		aggregate, hasAggregate := clusterBySignalKey[signal.SignalKey]
		theme := signal.Title
		sourceCount := 1
		if hasAggregate {
			theme = aggregate.cluster.RepresentativeTitle
			sourceCount = len(aggregate.cluster.SourceIDs)
			if aggregate.insight != nil {
				theme = aggregate.insight.Theme
			}
		}
		candidateLabel := theme
		candidateSummary := nullableString{}
		reason := nullableString{}
		topics := []string{}
		entities := []string{}
		contentKind := ContentUnknown
		bridgeSuggestion := false
		if hasAggregate && aggregate.insight != nil {
			candidateLabel = aggregate.insight.Label
			candidateSummary = aggregate.insight.Summary
			reason = aggregate.insight.Reason
			topics = aggregate.insight.Topics
			entities = normalizeEntityNames(aggregate.insight.Entities)
			contentKind = resolveContentKind(string(aggregate.insight.ContentKind))
			bridgeSuggestion = aggregate.insight.BridgeEligibleSuggestion
		}
		if topics == nil {
			topics = []string{}
		}
		if entities == nil {
			entities = []string{}
		}
		matched, matchedOK := matches[signal.SignalKey]
		candidateScore := computeCandidateScore(0.5, signal.FreshnessScore, 1, signal.Authority, nil)
		if hasAggregate {
			candidateScore = aggregate.candidateScore
		}
		heatScore := computeHeatScore(
			signal.Rank,
			maxItemsPerSource,
			signal.HeatValue.Ptr(),
			snapshot.GlobalMaxHeatValue,
			sourceCount,
			signal.Authority,
		)
		bridgeEligible := s.isBridgeEligible(signal, contentKind, candidateScore, bridgeSuggestion)
		bridgeStatus := BridgeStatusNotSupported
		if matchedOK && matched.ItemID != "" {
			bridgeStatus = BridgeStatusExisting
		} else if bridgeEligible {
			bridgeStatus = BridgeStatusEligible
		}
		clusterID := signal.SignalKey
		if hasAggregate {
			clusterID = aggregate.cluster.ClusterID
		}
		item := AnalyzedItem{
			SourceID:         signal.SourceID,
			ItemID:           signal.ItemID,
			ClusterID:        clusterID,
			Theme:            theme,
			CandidateLabel:   candidateLabel,
			CandidateSummary: candidateSummary,
			Reason:           reason,
			Topics:           topics,
			Entities:         entities,
			ContentKind:      contentKind,
			SourceCount:      sourceCount,
			HeatScore:        heatScore,
			FreshnessScore:   signal.FreshnessScore,
			CandidateScore:   candidateScore,
			IsNew:            signal.IsNew,
			IsRising:         signal.IsRising,
			BridgeEligible:   bridgeEligible,
			BridgeStatus:     bridgeStatus,
		}
		if matchedOK && matched.ItemID != "" {
			itemID := matched.ItemID
			item.MatchedItemID = &itemID
		}
		if matchedOK && matched.EventID != "" {
			eventID := matched.EventID
			item.MatchedEventID = &eventID
		}
		analysisBySignalKey[signal.SignalKey] = item
	}

	if allowAutoBridge && userID != "" {
		s.bridgeEligibleItems(ctx, orgID, userID, normalizedSignals, analysisBySignalKey)
	}

	s.persistSignalStates(ctx, orgID, normalizedSignals)
	s.persistDomesticOpinionSnapshotsBestEffort(ctx, orgID, generatedAt, snapshot.TotalDomesticSourceCount, aggregates, analysisBySignalKey, metadata.sourcesByID)

	var bySource BySource
	for _, signal := range normalizedSignals {
		item, exists := analysisBySignalKey[signal.SignalKey]
		if !exists {
			continue
		}
		bySource.Add(signal.SourceID, signal.ItemID, item)
	}

	filteredAggregates := make([]candidateClusterAggregate, 0, len(aggregates))
	for _, aggregate := range aggregates {
		if aggregate.candidateScore >= candidateThreshold {
			filteredAggregates = append(filteredAggregates, aggregate)
		}
	}
	sort.SliceStable(filteredAggregates, func(left, right int) bool {
		if filteredAggregates[left].candidateScore != filteredAggregates[right].candidateScore {
			return filteredAggregates[left].candidateScore > filteredAggregates[right].candidateScore
		}
		if len(filteredAggregates[left].cluster.SourceIDs) != len(filteredAggregates[right].cluster.SourceIDs) {
			return len(filteredAggregates[left].cluster.SourceIDs) > len(filteredAggregates[right].cluster.SourceIDs)
		}
		return filteredAggregates[left].cluster.AvgRank < filteredAggregates[right].cluster.AvgRank
	})
	filteredAggregates = firstN(filteredAggregates, maxReturnedCandidates)
	responseCandidates := make([]EventCandidate, 0, len(filteredAggregates))
	for _, aggregate := range filteredAggregates {
		responseCandidates = append(responseCandidates, toCandidate(aggregate, analysisBySignalKey))
	}
	emptyReason := resolveEmptyReason(responseCandidates, snapshot.Diagnostics, len(normalizedSignals))
	response := AnalysisResponse{
		GeneratedAt:     isoTime(generatedAt),
		Cached:          false,
		DataState:       DataStateEmpty,
		Diagnostics:     snapshot.Diagnostics,
		SourcesAnalyzed: snapshot.Diagnostics.SourcesSucceeded,
		ItemsAnalyzed:   len(normalizedSignals),
		BySource:        bySource,
		Candidates:      responseCandidates,
		Errors:          append([]SourceError{}, snapshot.Errors...),
	}
	if len(responseCandidates) > 0 {
		response.DataState = DataStateReady
	}
	if emptyReason != nil {
		response.EmptyReason = stringOrNull(string(*emptyReason))
	}
	return response, nil
}

// buildClusterAggregates ports buildClusterAggregates.
func buildClusterAggregates(
	signals []Signal,
	clusters []SignalCluster,
	insightByClusterID map[string]ClusterInsight,
	globalMaxHeatValue float64,
) ([]candidateClusterAggregate, map[string]candidateClusterAggregate) {
	signalByKey := make(map[string]Signal, len(signals))
	for _, signal := range signals {
		signalByKey[signal.SignalKey] = signal
	}
	clusterBySignalKey := make(map[string]candidateClusterAggregate, len(signals))
	aggregates := make([]candidateClusterAggregate, 0, len(clusters))
	for _, cluster := range clusters {
		items := make([]Signal, 0, len(cluster.ItemKeys))
		for _, itemKey := range cluster.ItemKeys {
			if signal, exists := signalByKey[itemKey]; exists {
				items = append(items, signal)
			}
		}
		authority := 0.0
		if len(items) > 0 {
			for _, item := range items {
				authority += item.Authority
			}
			authority /= float64(len(items))
		}
		maxHeatValue := cluster.MaxHeatValue
		heatScore := computeHeatScore(
			int(math.Max(1, math.Floor(cluster.AvgRank+0.5))),
			maxItemsPerSource,
			&maxHeatValue,
			globalMaxHeatValue,
			len(cluster.SourceIDs),
			authority,
		)
		freshnessScore := 0.0
		if len(items) > 0 {
			for _, item := range items {
				freshnessScore += item.FreshnessScore
			}
			freshnessScore = roundN(freshnessScore/float64(len(items)), 4)
		}
		var insight *ClusterInsight
		if value, exists := insightByClusterID[cluster.ClusterID]; exists {
			copied := value
			insight = &copied
		}
		confidence := 0.5
		if insight != nil {
			confidence = insight.Confidence
		}
		candidateScore := computeCandidateScore(heatScore, freshnessScore, len(cluster.SourceIDs), authority, &confidence)
		aggregate := candidateClusterAggregate{
			cluster:        cluster,
			insight:        insight,
			items:          items,
			authority:      authority,
			heatScore:      heatScore,
			freshnessScore: freshnessScore,
			candidateScore: candidateScore,
		}
		for _, item := range items {
			clusterBySignalKey[item.SignalKey] = aggregate
		}
		aggregates = append(aggregates, aggregate)
	}
	return aggregates, clusterBySignalKey
}

// resolveMatches resolves the comparable URLs of the given signals inside the
// caller's organization. A failure resolves every URL as a miss, which is the
// NestJS per-signal catch behaviour.
func (s *Service) resolveMatches(ctx context.Context, orgID string, signals []Signal) map[string]OrgMatch {
	if len(signals) == 0 {
		return map[string]OrgMatch{}
	}
	resolveKey := func(url string) string {
		if variants, ok := comparableURLVariants(url); ok {
			return variants.Full
		}
		return jsTrim(url)
	}
	uniqueURLs := make([]string, 0, len(signals))
	uniqueByKey := make(map[string]string, len(signals))
	for _, signal := range signals {
		key := resolveKey(signal.URL)
		if _, exists := uniqueByKey[key]; exists {
			continue
		}
		uniqueByKey[key] = signal.URL
		uniqueURLs = append(uniqueURLs, signal.URL)
	}
	resolved := map[string]OrgMatch{}
	if s.matcher != nil {
		matches, err := s.matcher.ResolveOrgMatches(ctx, orgID, uniqueURLs)
		if err != nil {
			s.logf("newsnowhottest: organization URL match failed orgId=%s err=%v", orgID, err)
		} else if matches != nil {
			resolved = matches
		}
	}
	out := make(map[string]OrgMatch, len(signals))
	for _, signal := range signals {
		out[signal.SignalKey] = resolved[signal.URL]
	}
	return out
}

// isBridgeEligible ports isBridgeEligible.
func (s *Service) isBridgeEligible(signal Signal, contentKind ContentKind, candidateScore float64, suggested bool) bool {
	if !autoBridgeSourceWhitelist[signal.SourceID] {
		return false
	}
	if contentKind == ContentDiscussion || contentKind == ContentVideo {
		return false
	}
	if !strings.HasPrefix(signal.URL, "http://") && !strings.HasPrefix(signal.URL, "https://") {
		return false
	}
	return suggested || candidateScore >= bridgeCandidateThreshold
}

// bridgeNewsnowMetadata is payload.metadata.newsnow.
type bridgeNewsnowMetadata struct {
	SourceID          string         `json:"sourceId"`
	ItemID            string         `json:"itemId"`
	Rank              int            `json:"rank"`
	HeatText          nullableString `json:"heatText"`
	CapturedAt        string         `json:"capturedAt"`
	SourceUpdatedTime nullableString `json:"sourceUpdatedTime"`
}

// bridgeHottestMetadata is payload.metadata.hottestAnalysis.
type bridgeHottestMetadata struct {
	Theme          string  `json:"theme"`
	CandidateLabel string  `json:"candidateLabel"`
	CandidateScore float64 `json:"candidateScore"`
	FreshnessScore float64 `json:"freshnessScore"`
}

type bridgeMetadata struct {
	Newsnow         bridgeNewsnowMetadata `json:"newsnow"`
	HottestAnalysis bridgeHottestMetadata `json:"hottestAnalysis"`
}

type bridgePayload struct {
	URL          string         `json:"url"`
	SourceName   string         `json:"sourceName"`
	Tags         []string       `json:"tags"`
	SummaryHints []string       `json:"summaryHints"`
	Metadata     bridgeMetadata `json:"metadata"`
	ForceRefresh bool           `json:"forceRefresh"`
}

// bridgeEligibleItems ports bridgeEligibleItems: at most ten targets, three
// concurrent creates, failures logged only.
func (s *Service) bridgeEligibleItems(
	ctx context.Context,
	orgID, userID string,
	signals []Signal,
	analysisBySignalKey map[string]AnalyzedItem,
) {
	if s.bridge == nil {
		s.logf("newsnowhottest: item bridge is not configured; skipping auto-bridge orgId=%s", orgID)
		return
	}
	type bridgeTarget struct {
		signal   Signal
		analysis AnalyzedItem
	}
	targets := make([]bridgeTarget, 0, len(signals))
	for _, signal := range signals {
		analysis, exists := analysisBySignalKey[signal.SignalKey]
		if !exists {
			continue
		}
		if !analysis.BridgeEligible || analysis.MatchedItemID != nil {
			continue
		}
		if analysis.CandidateScore < bridgeCandidateThreshold || signal.Rank > bridgeRankThreshold {
			continue
		}
		targets = append(targets, bridgeTarget{signal: signal, analysis: analysis})
	}
	sort.SliceStable(targets, func(left, right int) bool {
		if targets[left].analysis.CandidateScore != targets[right].analysis.CandidateScore {
			return targets[left].analysis.CandidateScore > targets[right].analysis.CandidateScore
		}
		return targets[left].signal.Rank < targets[right].signal.Rank
	})
	targets = firstN(targets, autoBridgeMaxItems)

	mapWithConcurrency(targets, autoBridgeConcurrency, func(_ int, target bridgeTarget) {
		hints := make([]string, 0, 4)
		for _, value := range []string{target.analysis.Theme, target.analysis.CandidateLabel} {
			if trimmed := jsTrim(value); trimmed != "" {
				hints = append(hints, trimmed)
			}
		}
		payload := bridgePayload{
			URL:          target.signal.URL,
			SourceName:   target.signal.SourceName,
			Tags:         []string{"newsnow", "hottest", target.signal.SourceID},
			SummaryHints: firstN(hints, 4),
			Metadata: bridgeMetadata{
				Newsnow: bridgeNewsnowMetadata{
					SourceID:          target.signal.SourceID,
					ItemID:            target.signal.ItemID,
					Rank:              target.signal.Rank,
					HeatText:          target.signal.HeatText,
					CapturedAt:        target.signal.CapturedAt,
					SourceUpdatedTime: target.signal.SourceUpdatedTime,
				},
				HottestAnalysis: bridgeHottestMetadata{
					Theme:          target.analysis.Theme,
					CandidateLabel: target.analysis.CandidateLabel,
					CandidateScore: target.analysis.CandidateScore,
					FreshnessScore: target.analysis.FreshnessScore,
				},
			},
			ForceRefresh: false,
		}
		encoded, err := marshalJSON(payload)
		if err != nil {
			s.logf("newsnowhottest: bridge payload encode failed sourceId=%s err=%v", target.signal.SourceID, err)
			return
		}
		created, err := s.bridge.CreateItem(ctx, orgID, userID, itemsingest.CreateItemInput{
			ExternalID: buildBridgeExternalId(target.signal.SourceID, target.signal.URL),
			Name:       truncateJS(target.signal.SourceName+": "+target.signal.Title, 255),
			Payload:    encoded,
		})
		if err != nil {
			s.logf("newsnowhottest: failed to auto-bridge hottest signal sourceId=%s url=%s err=%v",
				target.signal.SourceID, target.signal.URL, err)
			return
		}
		if created.Meta.ID == "" {
			return
		}
		analysis := analysisBySignalKey[target.signal.SignalKey]
		itemID := created.Meta.ID
		analysis.MatchedItemID = &itemID
		analysis.BridgeStatus = BridgeStatusQueued
		analysisBySignalKey[target.signal.SignalKey] = analysis
	})
}

// truncateJS is String.prototype.slice(0, limit) over UTF-16 code units. A
// boundary that would split a surrogate pair drops the pair instead of emitting
// an unpaired surrogate Go cannot encode; the result is never longer than the
// limit in code units and is always valid UTF-8.
func truncateJS(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	truncated := units[:limit]
	if len(truncated) > 0 && truncated[len(truncated)-1] >= 0xD800 && truncated[len(truncated)-1] <= 0xDBFF {
		truncated = truncated[:len(truncated)-1]
	}
	return string(utf16.Decode(truncated))
}

// normalizeAnalysis ports normalizeAnalysisResponse for the fields older cache
// documents may omit.
func (s *Service) normalizeAnalysis(response AnalysisResponse) AnalysisResponse {
	if response.Candidates == nil {
		response.Candidates = []EventCandidate{}
	}
	if response.Errors == nil {
		response.Errors = []SourceError{}
	}
	if response.DataState != DataStateReady && response.DataState != DataStateEmpty {
		if len(response.Candidates) > 0 {
			response.DataState = DataStateReady
		} else {
			response.DataState = DataStateEmpty
		}
	}
	if response.DataState == DataStateEmpty && !response.EmptyReason.Valid {
		if reason := resolveEmptyReason(response.Candidates, response.Diagnostics, response.ItemsAnalyzed); reason != nil {
			response.EmptyReason = stringOrNull(string(*reason))
		}
	}
	return response
}

// toCandidate ports toCandidate.
func toCandidate(aggregate candidateClusterAggregate, analysisBySignalKey map[string]AnalyzedItem) EventCandidate {
	type rankedRef struct {
		signal   Signal
		analysis AnalyzedItem
	}
	refs := make([]rankedRef, 0, len(aggregate.items))
	for _, signal := range aggregate.items {
		analysis, exists := analysisBySignalKey[signal.SignalKey]
		if !exists {
			continue
		}
		refs = append(refs, rankedRef{signal: signal, analysis: analysis})
	}
	sort.SliceStable(refs, func(left, right int) bool { return refs[left].signal.Rank < refs[right].signal.Rank })
	label := aggregate.cluster.RepresentativeTitle
	summary := nullableString{}
	reason := nullableString{}
	themes := []string{}
	entities := []string{}
	if aggregate.insight != nil {
		label = aggregate.insight.Label
		summary = aggregate.insight.Summary
		reason = aggregate.insight.Reason
		themes = append(themes, aggregate.insight.Theme)
		themes = append(themes, aggregate.insight.Topics...)
		entities = normalizeEntityNames(aggregate.insight.Entities)
	}
	themes = firstN(uniqueStrings(themes), maxCandidateThemes)
	entities = firstN(entities, maxCandidateEntities)
	itemRefs := make([]ItemRef, 0, len(refs))
	for _, ref := range firstN(refs, maxCandidateItemRefs) {
		itemRef := ItemRef{
			SourceID: ref.signal.SourceID,
			ItemID:   ref.signal.ItemID,
			Title:    ref.signal.Title,
		}
		if ref.analysis.MatchedItemID != nil {
			value := *ref.analysis.MatchedItemID
			itemRef.MatchedItemID = &value
		}
		if ref.analysis.MatchedEventID != nil {
			value := *ref.analysis.MatchedEventID
			itemRef.MatchedEventID = &value
		}
		itemRefs = append(itemRefs, itemRef)
	}
	return EventCandidate{
		CandidateID:    aggregate.cluster.ClusterID,
		Label:          label,
		Summary:        summary,
		Reason:         reason,
		Themes:         themes,
		Entities:       entities,
		SourceIDs:      aggregate.cluster.SourceIDs,
		SourceCount:    len(aggregate.cluster.SourceIDs),
		ItemCount:      len(aggregate.items),
		HeatScore:      aggregate.heatScore,
		FreshnessScore: aggregate.freshnessScore,
		CandidateScore: aggregate.candidateScore,
		ItemRefs:       itemRefs,
	}
}

// toCandidatePersistenceInput ports toCandidatePersistenceInput.
func toCandidatePersistenceInput(
	aggregate candidateClusterAggregate,
	analysisBySignalKey map[string]AnalyzedItem,
	sourcesByID map[string]SourceDescriptor,
) CandidatePersistenceInput {
	summary := nullableString{}
	themes := []string{}
	topics := []string{}
	entities := []string{}
	label := aggregate.cluster.RepresentativeTitle
	if aggregate.insight != nil {
		label = aggregate.insight.Label
		summary = aggregate.insight.Summary
		themes = append(themes, aggregate.insight.Theme)
		themes = append(themes, aggregate.insight.Topics...)
		topics = aggregate.insight.Topics
		entities = normalizeEntityNames(aggregate.insight.Entities)
	}
	domesticSourceIDs := make([]string, 0, len(aggregate.items))
	domesticItemCount := 0
	for _, item := range aggregate.items {
		source, exists := sourcesByID[item.SourceID]
		if !exists || source.Column != "china" {
			continue
		}
		domesticItemCount++
		domesticSourceIDs = append(domesticSourceIDs, item.SourceID)
	}
	matchedItemIDs := make([]string, 0, len(aggregate.items))
	for _, item := range aggregate.items {
		if analysis, exists := analysisBySignalKey[item.SignalKey]; exists && analysis.MatchedItemID != nil {
			value := jsTrim(*analysis.MatchedItemID)
			if value != "" {
				matchedItemIDs = append(matchedItemIDs, value)
			}
		}
	}
	uniqueDomestic := uniqueStrings(domesticSourceIDs)
	return CandidatePersistenceInput{
		CandidateHash:       aggregate.cluster.ClusterID,
		Label:               label,
		Summary:             summary.Ptr(),
		RepresentativeTitle: aggregate.cluster.RepresentativeTitle,
		Themes:              firstN(uniqueStrings(themes), maxPersistenceThemes),
		Topics:              topics,
		Entities:            firstN(entities, maxPersistenceEntities),
		SourceIDs:           aggregate.cluster.SourceIDs,
		DomesticSourceIDs:   uniqueDomestic,
		SourceCount:         len(aggregate.cluster.SourceIDs),
		ItemCount:           len(aggregate.items),
		HeatScore:           aggregate.heatScore,
		FreshnessScore:      aggregate.freshnessScore,
		CandidateScore:      aggregate.candidateScore,
		AuthorityScore:      aggregate.authority,
		DomesticSourceCount: len(uniqueDomestic),
		DomesticItemCount:   domesticItemCount,
		MatchedItemIDs:      uniqueStrings(matchedItemIDs),
	}
}

// persistDomesticOpinionSnapshotsBestEffort ports
// persistDomesticOpinionSnapshotsBestEffort.
func (s *Service) persistDomesticOpinionSnapshotsBestEffort(
	ctx context.Context,
	orgID string,
	generatedAt time.Time,
	totalDomesticSourceCount int,
	aggregates []candidateClusterAggregate,
	analysisBySignalKey map[string]AnalyzedItem,
	sourcesByID map[string]SourceDescriptor,
) {
	if s.opinion == nil {
		return
	}
	candidates := make([]CandidatePersistenceInput, 0, len(aggregates))
	for _, aggregate := range aggregates {
		candidates = append(candidates, toCandidatePersistenceInput(aggregate, analysisBySignalKey, sourcesByID))
	}
	if err := s.opinion.PersistSnapshots(ctx, OpinionSnapshotInput{
		OrgID:                    orgID,
		GeneratedAt:              generatedAt,
		TotalDomesticSourceCount: totalDomesticSourceCount,
		Candidates:               candidates,
	}); err != nil {
		s.logf("newsnowhottest: failed to persist NewsNow domestic opinion snapshots orgId=%s err=%v", orgID, err)
	}
}

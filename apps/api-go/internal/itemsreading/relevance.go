package itemsreading

import (
	"context"
	"sort"
	"strings"
	"time"
)

// This file ports the RELEVANCE ordering of ItemsSearchService: the two-stage
// ranking (pre-rank then rerank), the final weighted blend and the page/cursor
// projection. The candidate recall order is not a relevance score, so the fused
// recall ids are always re-ranked here.

// relevanceCandidate is one scored candidate document.
type relevanceCandidate struct {
	ID               string
	Document         string
	LexicalScore     float64
	RecencyScore     float64
	SourceTrustScore float64
	QualityScore     float64
	SortAt           time.Time
}

// rankedItem is one final ranking entry. RankOffset is the global rank index
// used by the cursor relocation.
type rankedItem struct {
	ID         string
	Score      float64
	RankOffset int
}

// relevancePage ports listByRelevanceWithPage.
func (s *Service) relevancePage(ctx context.Context, orgID string, args listArgs, offset int) (pageRows, error) {
	ranked, err := s.rankScopedIDsByRelevance(ctx, orgID, args.search, args.scoped)
	if err != nil {
		return pageRows{}, err
	}
	if len(ranked) == 0 {
		return pageRows{rows: []ItemMetaRow{}, extra: map[string]rankedEdge{}, total: 0}, nil
	}
	if offset >= len(ranked) {
		return pageRows{rows: []ItemMetaRow{}, extra: map[string]rankedEdge{}, total: len(ranked)}, nil
	}
	end := offset + args.take
	if end > len(ranked) {
		end = len(ranked)
	}
	window := ranked[offset:end]
	pageIDs := make([]string, 0, len(window))
	for _, entry := range window {
		pageIDs = append(pageIDs, entry.ID)
	}
	rowsByID, err := s.fetchItemMetaRowsByIDs(ctx, orgID, pageIDs)
	if err != nil {
		return pageRows{}, err
	}
	scoreByID := make(map[string]float64, len(window))
	for _, entry := range window {
		scoreByID[entry.ID] = entry.Score
	}
	highlights := s.loadSearchHighlights(ctx, orgID, args.search, pageIDs)

	rows := make([]ItemMetaRow, 0, len(window))
	extra := make(map[string]rankedEdge, len(window))
	for _, id := range pageIDs {
		row, ok := rowsByID[id]
		if !ok {
			continue
		}
		rows = append(rows, row)
		edge := rankedEdge{}
		if score, ok := scoreByID[id]; ok {
			value := score
			edge.RelevanceScore = &value
		}
		if snippets, ok := highlights[id]; ok {
			edge.SearchHighlights = snippets
		}
		extra[id] = edge
	}
	return pageRows{rows: rows, extra: extra, total: len(ranked)}, nil
}

// relevanceCursor ports listByRelevanceWithCursor.
//
// The cursor relocation prefers the id: when the cursor id is still part of the
// ranking the window resumes right after it, which survives insertions ahead of
// the page. Only when the id is gone does the stored offset + 1 apply, and a
// negative offset restarts at the beginning. This is deliberately different
// from the personalized relocation order.
func (s *Service) relevanceCursor(ctx context.Context, orgID string, args listArgs, cursor *ItemsCursorPayload) (ItemConnectionResult, error) {
	ranked, err := s.rankScopedIDsByRelevance(ctx, orgID, args.search, args.scoped)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	if len(ranked) == 0 {
		return emptyConnection(0), nil
	}

	var cursorOffset *int
	if cursor != nil && cursor.Offset != nil && isFinite(float64(*cursor.Offset)) {
		value := *cursor.Offset
		cursorOffset = &value
	}
	cursorID := ""
	if cursor != nil {
		cursorID = strings.TrimSpace(cursor.ID)
	}
	cursorIDOffset := -1
	if cursorID != "" {
		for index, entry := range ranked {
			if entry.ID == cursorID {
				cursorIDOffset = index
				break
			}
		}
	}
	startOffset := 0
	switch {
	case cursorIDOffset >= 0:
		startOffset = cursorIDOffset + 1
	case cursorOffset != nil:
		startOffset = *cursorOffset + 1
		if startOffset < 0 {
			startOffset = 0
		}
	}
	if startOffset > len(ranked) {
		startOffset = len(ranked)
	}
	window := ranked[startOffset:]
	if len(window) > args.take+1 {
		window = window[:args.take+1]
	}
	hasNextPage := len(window) > args.take
	if hasNextPage {
		window = window[:args.take]
	}
	pageIDs := make([]string, 0, len(window))
	for _, entry := range window {
		pageIDs = append(pageIDs, entry.ID)
	}
	rowsByID, err := s.fetchItemMetaRowsByIDs(ctx, orgID, pageIDs)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	highlights := s.loadSearchHighlights(ctx, orgID, args.search, pageIDs)

	edges := make([]ItemListEdge, 0, len(window))
	for index, entry := range window {
		row, ok := rowsByID[entry.ID]
		if !ok {
			continue
		}
		score := entry.Score
		rankOffset := startOffset + index
		edge := ItemListEdge{
			Row:            row,
			RelevanceScore: &score,
			RankOffset:     &rankOffset,
			Cursor:         encodeRowCursor(ItemsRankingRelevance, args.orderBy, row, &rankOffset),
		}
		if snippets, ok := highlights[entry.ID]; ok {
			edge.SearchHighlights = snippets
		}
		edges = append(edges, edge)
	}
	return ItemConnectionResult{Edges: edges, HasNextPage: hasNextPage, TotalCount: len(ranked)}, nil
}

// rankScopedIDsByRelevance ports rankScopedIdsByRelevance for both read-model
// modes. The recall set is capped at RecallMaxCandidates, the top
// RerankMaxCandidates are sent to the reranker, and every candidate keeps the
// lexical score when the reranker is disabled or did not score it.
func (s *Service) rankScopedIDsByRelevance(ctx context.Context, orgID string, search string, scopedIDs []string) ([]rankedItem, error) {
	recallMax := s.ranking.RecallMaxCandidates
	if recallMax < 1 {
		recallMax = 1
	}
	rerankMax := s.ranking.RerankMaxCandidates
	if rerankMax < 1 {
		rerankMax = 1
	}
	if rerankMax > recallMax {
		rerankMax = recallMax
	}
	limitedIDs := scopedIDs
	if len(limitedIDs) > recallMax {
		limitedIDs = limitedIDs[:recallMax]
	}
	if len(limitedIDs) == 0 {
		return nil, nil
	}
	rowsByID, err := s.fetchItemMetaRowsByIDs(ctx, orgID, limitedIDs)
	if err != nil {
		return nil, err
	}
	if len(rowsByID) == 0 {
		return nil, nil
	}
	existingIDs := make([]string, 0, len(limitedIDs))
	for _, id := range limitedIDs {
		if _, ok := rowsByID[id]; ok {
			existingIDs = append(existingIDs, id)
		}
	}

	candidates, err := s.buildRelevanceCandidates(ctx, orgID, search, existingIDs, rowsByID)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}

	preRanked := make([]relevanceCandidate, len(candidates))
	copy(preRanked, candidates)
	sort.SliceStable(preRanked, func(i, j int) bool {
		scoreA := preRanked[i].LexicalScore*0.7 + preRanked[i].RecencyScore*0.3
		scoreB := preRanked[j].LexicalScore*0.7 + preRanked[j].RecencyScore*0.3
		if scoreA != scoreB {
			return scoreB < scoreA
		}
		return preRanked[j].SortAt.After(preRanked[i].SortAt)
	})
	rerankCandidates := preRanked
	if len(rerankCandidates) > rerankMax {
		rerankCandidates = rerankCandidates[:rerankMax]
	}
	rerankScores, err := s.tryRerankCandidates(ctx, orgID, search, rerankCandidates, s.ranking.RerankTimeoutMs)
	if err != nil {
		return nil, err
	}

	ranked := make([]rankedItem, 0, len(candidates))
	type scoredRow struct {
		id     string
		score  float64
		sortAt time.Time
	}
	scored := make([]scoredRow, 0, len(candidates))
	for _, candidate := range candidates {
		baseRelevance := candidate.LexicalScore
		if rerankScores != nil {
			if score, ok := rerankScores[candidate.ID]; ok {
				baseRelevance = score
			}
		}
		finalScore := finalRelevanceScore(baseRelevance, candidate.RecencyScore, candidate.SourceTrustScore, candidate.QualityScore)
		scored = append(scored, scoredRow{id: candidate.ID, score: finalScore, sortAt: candidate.SortAt})
	}
	// final order: score DESC, sortAt DESC, id ascending. The score comparison
	// is exact here (unlike the personalized 1e-4 epsilon) to mirror the NestJS
	// relevance comparator.
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[j].score < scored[i].score
		}
		if !scored[i].sortAt.Equal(scored[j].sortAt) {
			return scored[j].sortAt.Before(scored[i].sortAt)
		}
		return localeCompare(scored[i].id, scored[j].id) < 0
	})
	for _, entry := range scored {
		ranked = append(ranked, rankedItem{ID: entry.id, Score: entry.score})
	}
	return ranked, nil
}

// finalRelevanceScore is the relevance contract blend: 0.55 * base relevance +
// 0.25 * recency + 0.15 * source trust + 0.05 * quality, clamped to [0,1]. The
// base relevance is the rerank score when the reranker scored the candidate and
// the lexical score otherwise; candidates that never entered the rerank stage
// keep their lexical base instead of being dropped.
func finalRelevanceScore(baseRelevance, recencyScore, sourceTrustScore, qualityScore float64) float64 {
	return clamp01(
		defaultWeightRerank*clamp01(baseRelevance) +
			defaultWeightRecency*recencyScore +
			defaultWeightSourceTrust*sourceTrustScore +
			defaultWeightQuality*qualityScore,
	)
}

// buildRelevanceCandidates builds the named document and the lexical/recency/
// source-trust/quality features for every candidate.
func (s *Service) buildRelevanceCandidates(
	ctx context.Context,
	orgID string,
	search string,
	existingIDs []string,
	rowsByID map[string]ItemMetaRow,
) ([]relevanceCandidate, error) {
	candidates := make([]relevanceCandidate, 0, len(existingIDs))
	if s.readModelEnabled {
		docsByID, err := s.readModel.loadItemReadModelsByIDs(ctx, orgID, existingIDs)
		if err != nil {
			return nil, err
		}
		for _, id := range existingIDs {
			row, ok := rowsByID[id]
			if !ok {
				continue
			}
			doc, ok := docsByID[id]
			if !ok {
				continue
			}
			candidates = append(candidates, buildReadModelRelevanceCandidate(search, row, doc, s.ranking.RecencyHalfLifeHours))
		}
		return candidates, nil
	}

	results, err := s.mongo.FindProcessedResultsByItemMetaIDs(ctx, orgID, existingIDs)
	if err != nil {
		return nil, err
	}
	for _, id := range existingIDs {
		row, ok := rowsByID[id]
		if !ok {
			continue
		}
		candidates = append(candidates, buildMongoRelevanceCandidate(search, row, results[id], s.ranking.RecencyHalfLifeHours))
	}
	return candidates, nil
}

// buildReadModelRelevanceCandidate ports the read-model document projection:
// title falls back to the ItemMeta name, quality defaults to 0.5 and the source
// is the source name then the source id.
func buildReadModelRelevanceCandidate(search string, row ItemMetaRow, doc ReadModelDocument, halfLifeHours float64) relevanceCandidate {
	title := doc.Title
	if strings.TrimSpace(title) == "" {
		title = row.Name
	}
	summary := ""
	if doc.Summary != nil {
		summary = *doc.Summary
	}
	topics := doc.Topics
	if len(topics) > 5 {
		topics = topics[:5]
	}
	entities := doc.Entities
	if len(entities) > 5 {
		entities = entities[:5]
	}
	source := firstNonEmptyPtrString(doc.SourceName, doc.SourceID)
	quality := 0.5
	if doc.QualityScore != nil && isFinite(*doc.QualityScore) {
		quality = clamp01(*doc.QualityScore)
	}
	return relevanceCandidate{
		ID:               row.ID,
		Document:         buildRelevanceDocument(title, summary, topics, entities),
		LexicalScore:     computeLexicalScore(search, buildRelevanceDocument(title, summary, topics, entities)),
		RecencyScore:     computeRecencyScore(row.SortAt.Time, halfLifeHours),
		SourceTrustScore: computeSourceTrustScore(source),
		QualityScore:     quality,
		SortAt:           row.SortAt.Time,
	}
}

// buildMongoRelevanceCandidate ports the non-read-model projection: the fields
// come from the processed result document with the same aliases as
// items-search.helpers.ts.
func buildMongoRelevanceCandidate(search string, row ItemMetaRow, result OpenJSON, halfLifeHours float64) relevanceCandidate {
	projection, _ := decodeResultRecord(result)
	title := pickResultString(projection, []string{"title", "headline", "title_zh", "titleZh"})
	if strings.TrimSpace(title) == "" {
		title = row.Name
	}
	summary := pickResultString(projection, []string{"summary", "abstract", "subtitle"})
	topics := pickResultStringArrayFromProjection(projection, []string{"topics"}, 5)
	entities := pickResultStringArrayFromProjection(projection, []string{"entities"}, 5)
	sourceValue := pickResultString(projection, []string{"source", "sourceName", "source_name"})
	var source *string
	if strings.TrimSpace(sourceValue) != "" {
		source = &sourceValue
	}
	quality := 0.5
	if raw, ok := pickResultNumber(projection, []string{"quality_score", "qualityScore"}); ok {
		quality = clamp01(raw)
	}
	document := buildRelevanceDocument(title, summary, topics, entities)
	return relevanceCandidate{
		ID:               row.ID,
		Document:         document,
		LexicalScore:     computeLexicalScore(search, document),
		RecencyScore:     computeRecencyScore(row.SortAt.Time, halfLifeHours),
		SourceTrustScore: computeSourceTrustScore(source),
		QualityScore:     quality,
		SortAt:           row.SortAt.Time,
	}
}

// buildRelevanceDocument ports the document join: title, summary, then the
// capped topic/entity lists.
func buildRelevanceDocument(title string, summary string, topics []string, entities []string) string {
	parts := make([]string, 0, 4)
	if strings.TrimSpace(title) != "" {
		parts = append(parts, title)
	}
	if strings.TrimSpace(summary) != "" {
		parts = append(parts, summary)
	}
	if len(topics) > 0 {
		parts = append(parts, "Topics: "+strings.Join(topics, ", "))
	}
	if len(entities) > 0 {
		parts = append(parts, "Entities: "+strings.Join(entities, ", "))
	}
	return strings.Join(parts, "\n")
}

// loadSearchHighlights ports loadSearchHighlights: a disabled client, an empty
// id list or a blank query yields no highlights, and any Elasticsearch failure
// degrades to no highlights instead of failing the query. Rerank failures are
// deliberately not swallowed the same way.
func (s *Service) loadSearchHighlights(ctx context.Context, orgID string, search string, ids []string) map[string]map[string][]string {
	if s.search.elastic == nil || len(ids) == 0 || strings.TrimSpace(search) == "" {
		return nil
	}
	hits, err := s.search.elastic.Search(ctx, orgID, search, maxInt(len(ids), 1))
	if err != nil {
		return nil
	}
	idSet := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		idSet[id] = struct{}{}
	}
	out := make(map[string]map[string][]string)
	for _, hit := range hits {
		if _, ok := idSet[hit.ID]; !ok {
			continue
		}
		if len(hit.Highlights) == 0 {
			continue
		}
		out[hit.ID] = hit.Highlights
	}
	return out
}

// firstNonEmptyPtrString returns the first non-blank string behind the optional
// pointers.
func firstNonEmptyPtrString(values ...*string) *string {
	for _, value := range values {
		if value != nil && strings.TrimSpace(*value) != "" {
			return value
		}
	}
	return nil
}

// pickResultStringArrayFromProjection returns a deduped, capped string list.
func pickResultStringArrayFromProjection(projection resultProjection, keys []string, limit int) []string {
	values := pickResultStringArray(projection, keys)
	if limit > 0 && len(values) > limit {
		values = values[:limit]
	}
	return values
}

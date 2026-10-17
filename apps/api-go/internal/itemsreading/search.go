package itemsreading

import (
	"context"
	"math"
	"sort"
	"strings"
)

// candidateWeights are the recall-source fusion weights. They mirror
// rankSearchCandidateIds in apps/api/src/modules/items/items-search.helpers.ts.
var candidateWeights = map[SearchCandidateSource]float64{
	SearchCandidateMeta:             1.3,
	SearchCandidateProcessed:        1.15,
	SearchCandidateProcessedArticle: 1.05,
	SearchCandidateVector:           1.45,
	SearchCandidateElasticsearch:    1.6,
}

// searchService owns the recall and filter pipelines shared by the REST list,
// itemFacets and searchSuggestions. It never degrades to a single-table LIKE
// scan: the MySQL FULLTEXT/prefix recall, the Mongo ProcessedItem full-text
// recall, the ProcessedArticle full-text recall, the read-model text/prefix
// recall, Elasticsearch and the vector recall all feed the fusion step, and any
// unavailable source degrades exactly like NestJS.
type searchService struct {
	mysql            *mySQLStore
	mongo            *mongoStore
	elastic          *elasticSearcher
	vector           *vectorRecall
	readModelEnabled bool
}

// candidateScore is one fused candidate.
type candidateScore struct {
	ID        string
	Score     float64
	BestRank  int
	SourceNum int
}

// rankSearchCandidateIDs ports rankSearchCandidateIds: per source the ids are
// deduped, each occurrence contributes weight/(1+index/20), a candidate found
// by several sources earns 0.2 per extra source, and the final order is score
// DESC (1e-9 tolerance), bestRank ASC, id localeCompare.
func rankSearchCandidateIDs(sources map[SearchCandidateSource][]string) []string {
	scores := make(map[string]*candidateScore)
	order := make([]string, 0, 64)
	for source, ids := range sources {
		weight := candidateWeights[source]
		for index, id := range DedupeItemMetaIDs(ids) {
			rankScore := weight / (1 + float64(index)/20)
			current, ok := scores[id]
			if !ok {
				scores[id] = &candidateScore{ID: id, Score: rankScore, BestRank: index, SourceNum: 1}
				order = append(order, id)
				continue
			}
			current.Score += rankScore
			current.SourceNum++
			if index < current.BestRank {
				current.BestRank = index
			}
		}
	}
	ranked := make([]candidateScore, 0, len(order))
	for _, id := range order {
		entry := *scores[id]
		extra := entry.SourceNum - 1
		if extra > 0 {
			entry.Score += float64(extra) * 0.2
		}
		ranked = append(ranked, entry)
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if math.Abs(ranked[j].Score-ranked[i].Score) > 1e-9 {
			return ranked[j].Score < ranked[i].Score
		}
		if ranked[i].BestRank != ranked[j].BestRank {
			return ranked[i].BestRank < ranked[j].BestRank
		}
		return localeCompare(ranked[i].ID, ranked[j].ID) < 0
	})
	out := make([]string, 0, len(ranked))
	for _, entry := range ranked {
		out = append(out, entry.ID)
	}
	return out
}

// resolveStrategy decides between the FULLTEXT and prefix recall strategies.
type recallStrategy struct {
	fullText bool
	query    string
	term     string
}

func resolveRecallStrategy(search string) (recallStrategy, bool) {
	normalized := strings.TrimSpace(search)
	if normalized == "" {
		return recallStrategy{}, false
	}
	if booleanQuery, ok := BuildFullTextQuery(normalized); ok {
		return recallStrategy{fullText: true, query: booleanQuery}, true
	}
	return recallStrategy{term: normalized}, true
}

// resolveSearchIDs ports resolveSearchIds for both read-model modes.
func (s *searchService) resolveSearchIDs(ctx context.Context, orgID string, search string) ([]string, error) {
	strategy, ok := resolveRecallStrategy(search)
	if !ok {
		return nil, nil
	}
	normalized := strings.TrimSpace(search)

	var elasticIDs []string
	if s.elastic != nil {
		hits, err := s.elastic.Search(ctx, orgID, normalized, MaxSearchMatches)
		if err == nil {
			elasticIDs = make([]string, 0, len(hits))
			for _, hit := range hits {
				elasticIDs = append(elasticIDs, hit.ID)
			}
		}
	}

	if s.readModelEnabled {
		lexicalIDs, err := s.resolveReadModelSearchIDs(ctx, orgID, strategy)
		if err != nil {
			return nil, err
		}
		vectorIDs, err := s.resolveVectorIDs(ctx, orgID, normalized)
		if err != nil {
			return nil, err
		}
		return rankSearchCandidateIDs(map[SearchCandidateSource][]string{
			SearchCandidateElasticsearch: elasticIDs,
			SearchCandidateMeta:          lexicalIDs,
			SearchCandidateVector:        vectorIDs,
		}), nil
	}

	metaIDs, err := s.resolveMetaSearchIDs(ctx, orgID, strategy)
	if err != nil {
		return nil, err
	}
	processedIDs, err := s.resolveProcessedSearchIDs(ctx, orgID, strategy)
	if err != nil {
		return nil, err
	}
	articleIDs, err := s.resolveProcessedArticleSearchIDs(ctx, orgID, strategy)
	if err != nil {
		return nil, err
	}
	vectorIDs, err := s.resolveVectorIDs(ctx, orgID, normalized)
	if err != nil {
		return nil, err
	}
	return rankSearchCandidateIDs(map[SearchCandidateSource][]string{
		SearchCandidateElasticsearch:    elasticIDs,
		SearchCandidateMeta:             metaIDs,
		SearchCandidateProcessed:        processedIDs,
		SearchCandidateProcessedArticle: articleIDs,
		SearchCandidateVector:           vectorIDs,
	}), nil
}

// resolveReadModelSearchIDs ports resolveReadModelSearchIds.
func (s *searchService) resolveReadModelSearchIDs(
	ctx context.Context,
	orgID string,
	strategy recallStrategy,
) ([]string, error) {
	if strategy.fullText {
		textQuery, ok := BuildMongoTextSearchQuery(strategy.query)
		if !ok {
			textQuery = strategy.query
		}
		return s.mongo.ReadModelTextIDs(ctx, orgID, textQuery)
	}
	return s.mongo.ReadModelPrefixIDs(ctx, orgID, strategy.term)
}

// resolveMetaSearchIDs ports resolveMetaSearchIds.
func (s *searchService) resolveMetaSearchIDs(
	ctx context.Context,
	orgID string,
	strategy recallStrategy,
) ([]string, error) {
	if strategy.fullText {
		return s.mysql.MetaFullTextSearch(ctx, orgID, strategy.query)
	}
	return s.mysql.MetaPrefixSearch(ctx, orgID, strategy.term)
}

// resolveProcessedSearchIDs ports resolveProcessedSearchIds. ProcessedArticle
// only has a title/summary FULLTEXT index, so the prefix strategy deliberately
// does not degrade into a contains scan there.
func (s *searchService) resolveProcessedSearchIDs(
	ctx context.Context,
	orgID string,
	strategy recallStrategy,
) ([]string, error) {
	if !strategy.fullText {
		return nil, nil
	}
	textQuery, ok := BuildMongoTextSearchQuery(strategy.query)
	if !ok {
		return nil, nil
	}
	return s.mongo.ProcessedTextIDs(ctx, orgID, textQuery)
}

// resolveProcessedArticleSearchIDs ports resolveProcessedArticleSearchIds.
func (s *searchService) resolveProcessedArticleSearchIDs(
	ctx context.Context,
	orgID string,
	strategy recallStrategy,
) ([]string, error) {
	if !strategy.fullText {
		return nil, nil
	}
	refs, err := s.mysql.ProcessedArticleSearch(ctx, orgID, strategy.query)
	if err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, nil
	}
	return s.mongo.ProcessedIDsByObjectIDs(ctx, orgID, refs)
}

// resolveVectorIDs runs the vector recall and converts a hard failure into the
// typed error the handler maps to SERVICE_UNAVAILABLE; every other degradation
// returns an empty candidate list.
func (s *searchService) resolveVectorIDs(ctx context.Context, orgID string, search string) ([]string, error) {
	if s.vector == nil {
		return nil, nil
	}
	return s.vector.RecallIDs(ctx, orgID, search)
}

// resolveFilterIDs ports resolveFilterIds for both read-model modes, including
// the IR3 fix.
func (s *searchService) resolveFilterIDs(ctx context.Context, orgID string, filters *ItemFilters) ([]string, error) {
	if filters == nil {
		return nil, nil
	}
	if s.readModelEnabled {
		return s.mongo.FilterReadModelIDs(ctx, orgID, filters)
	}
	primary, err := s.mongo.FilterItemMetaIDsPrimary(ctx, orgID, filters)
	if err != nil {
		return nil, err
	}
	if len(filters.SourceIDs) == 0 {
		return DedupeItemMetaIDs(primary), nil
	}
	refs, err := s.mysql.ProcessedArticleSourceFallback(ctx, orgID, filters.SourceIDs, filters.DateRange)
	if err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return DedupeItemMetaIDs(primary), nil
	}
	fallbackIDs, err := s.mongo.ProcessedIDsByObjectIDs(ctx, orgID, refs)
	if err != nil {
		return nil, err
	}
	accepted, err := s.mongo.ApplyContentFilters(ctx, orgID, fallbackIDs, filters)
	if err != nil {
		return nil, err
	}
	if len(accepted) == 0 {
		return DedupeItemMetaIDs(primary), nil
	}
	combined := append([]string{}, primary...)
	combined = append(combined, accepted...)
	return DedupeItemMetaIDs(combined), nil
}

// ResolveScopedIDs ports resolveScopedIds. The boolean result distinguishes "no
// restriction at all" (false) from "restricted to this — possibly empty — id
// set" (true). Callers must not conflate a null candidate set with an empty one.
func (s *searchService) ResolveScopedIDs(
	ctx context.Context,
	orgID string,
	search string,
	filters *ItemFilters,
) ([]string, bool, error) {
	normalizedSearch := strings.TrimSpace(search)
	normalizedFilters := NormalizeFilters(filters)
	hasFilters := normalizedFilters.Active()
	if normalizedSearch == "" && !hasFilters {
		return nil, false, nil
	}
	var searchIDs []string
	if normalizedSearch != "" {
		ids, err := s.resolveSearchIDs(ctx, orgID, normalizedSearch)
		if err != nil {
			return nil, false, err
		}
		searchIDs = ids
	}
	var filterIDs []string
	if hasFilters && normalizedFilters != nil {
		ids, err := s.resolveFilterIDs(ctx, orgID, normalizedFilters)
		if err != nil {
			return nil, false, err
		}
		filterIDs = ids
	}
	combined := combineSearchAndFilterIDs(searchIDs, filterIDs, normalizedSearch != "", hasFilters)
	return combined, true, nil
}

// combineSearchAndFilterIDs ports combineSearchAndFilterIds: the two candidate
// sets intersect, a single present set is returned deduped, and no set means no
// restriction.
func combineSearchAndFilterIDs(searchIDs, filterIDs []string, hasSearch, hasFilter bool) []string {
	switch {
	case hasSearch && hasFilter:
		filterSet := make(map[string]struct{}, len(filterIDs))
		for _, id := range filterIDs {
			filterSet[id] = struct{}{}
		}
		intersection := make([]string, 0, len(searchIDs))
		for _, id := range searchIDs {
			if _, ok := filterSet[id]; ok {
				intersection = append(intersection, id)
			}
		}
		return DedupeItemMetaIDs(intersection)
	case hasSearch:
		return DedupeItemMetaIDs(searchIDs)
	case hasFilter:
		return DedupeItemMetaIDs(filterIDs)
	default:
		return nil
	}
}

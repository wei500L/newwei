package contentcatalog

import (
	"context"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

func buildRecommendationQuery(profile personalnews.PersonalizationProfile) string {
	parts := make([]string, 0, 4)
	if bits := topEntries(profile.Positive.Topics, 8); len(bits) > 0 {
		parts = append(parts, "topics: "+strings.Join(bits, ", "))
	}
	if bits := topEntries(profile.Positive.Entities, 8); len(bits) > 0 {
		parts = append(parts, "entities: "+strings.Join(bits, ", "))
	}
	if bits := topEntries(profile.Positive.Sources, 4); len(bits) > 0 {
		parts = append(parts, "sources: "+strings.Join(bits, ", "))
	}
	if bits := topEntries(profile.Positive.Domains, 4); len(bits) > 0 {
		parts = append(parts, "domains: "+strings.Join(bits, ", "))
	}
	return strings.Join(parts, "\n")
}

func topEntries(record personalnews.ScoreMap, limit int) []string {
	if limit < 0 {
		limit = 0
	}
	type pair struct {
		key   string
		score float64
	}
	entries := make([]pair, 0, len(record))
	for key, score := range record {
		entries = append(entries, pair{key: key, score: score})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].score > entries[j].score })
	if len(entries) > limit {
		entries = entries[:limit]
	}
	out := make([]string, len(entries))
	for i, entry := range entries {
		out[i] = entry.key + " (" + strconv.FormatFloat(entry.score, 'f', -1, 64) + ")"
	}
	return out
}

func (s *Service) rankByEmbedding(ctx context.Context, orgID, query string, rows []catalogRow) ([]scoredRow, error) {
	if s.models == nil {
		return nil, errEmbeddingSkipped
	}
	vectors, _, err := s.models.Embed(llmembed.ContextWithMeta(ctx, "content-subscriptions", "recommendation-query"), orgID, []string{query})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		log.Printf("contentcatalog: recommendation embedding failed org=%s", orgID)
		return nil, errEmbeddingSkipped
	}
	if len(vectors) == 0 {
		return nil, errEmbeddingSkipped
	}
	normalized := normalizeVector(vectors[0])
	if len(normalized) == 0 {
		return nil, errEmbeddingSkipped
	}
	return rankByVector(normalized, rows, recommendationPool), nil
}

func rankByVector(vector []float64, rows []catalogRow, limit int) []scoredRow {
	if len(vector) == 0 {
		return nil
	}
	ranked := make([]scoredRow, 0, len(rows))
	for _, row := range rows {
		candidate := parseVector(row.EmbeddingVector)
		if len(candidate) == 0 || len(candidate) != len(vector) {
			continue
		}
		ranked = append(ranked, scoredRow{Row: row, Score: dot(vector, candidate), HasScore: true})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].Score != ranked[j].Score {
			return ranked[i].Score > ranked[j].Score
		}
		if ranked[i].Row.Count != ranked[j].Row.Count {
			return ranked[i].Row.Count > ranked[j].Row.Count
		}
		return ranked[i].Row.LastSeenAt.After(ranked[j].Row.LastSeenAt)
	})
	if limit >= 0 && len(ranked) > limit {
		ranked = ranked[:limit]
	}
	return ranked
}

func mergeRanked(ranked []scoredRow, fallback []catalogRow, limit int) []scoredRow {
	ordered := make([]scoredRow, 0, limit)
	selected := map[string]struct{}{}
	for _, entry := range ranked {
		if len(ordered) >= limit {
			break
		}
		key := subscriptionKey(entry.Row.Kind, entry.Row.NormalizedValue)
		if _, ok := selected[key]; ok {
			continue
		}
		selected[key] = struct{}{}
		ordered = append(ordered, entry)
	}
	for _, row := range fallback {
		if len(ordered) >= limit {
			break
		}
		key := subscriptionKey(row.Kind, row.NormalizedValue)
		if _, ok := selected[key]; ok {
			continue
		}
		selected[key] = struct{}{}
		ordered = append(ordered, scoredRow{Row: row})
	}
	return ordered
}

func (s *Service) tryRerank(ctx context.Context, orgID, query string, rows []scoredRow) []scoredRow {
	if len(rows) == 0 || s.models == nil {
		return nil
	}
	documents := make([]string, len(rows))
	for i, entry := range rows {
		documents[i] = catalogRerankDocument(entry.Row)
	}
	hits, err := s.models.Rerank(llmembed.ContextWithMeta(ctx, "content-subscriptions", "rerank"), orgID, query, documents)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("contentcatalog: rerank failed org=%s", orgID)
		}
		return nil
	}
	scored := make([]scoredRow, 0, len(hits))
	for _, hit := range hits {
		if hit.Index < 0 || hit.Index >= len(rows) || math.IsNaN(hit.Score) || math.IsInf(hit.Score, 0) {
			continue
		}
		scored = append(scored, scoredRow{Row: rows[hit.Index].Row, Score: hit.Score, HasScore: true})
	}
	if len(scored) == 0 {
		return nil
	}
	minScore, maxScore := scored[0].Score, scored[0].Score
	for _, entry := range scored[1:] {
		if entry.Score < minScore {
			minScore = entry.Score
		}
		if entry.Score > maxScore {
			maxScore = entry.Score
		}
	}
	for i := range scored {
		if maxScore == minScore {
			scored[i].Score = 1
		} else {
			scored[i].Score = (scored[i].Score - minScore) / (maxScore - minScore)
		}
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Score != scored[j].Score {
			return scored[i].Score > scored[j].Score
		}
		return scored[i].Row.Count > scored[j].Row.Count
	})
	return scored
}

func catalogRerankDocument(row catalogRow) string {
	metadata, _ := parseMetadata(row.Metadata)
	parts := []string{
		"kind=" + row.Kind,
		"name=" + row.DisplayValue,
	}
	if row.HasTaxonomyPath && row.TaxonomyPath != "" {
		parts = append(parts, "taxonomy="+row.TaxonomyPath)
	}
	if value := metaString(metadata, "entityType"); value != "" {
		parts = append(parts, "entityType="+value)
	}
	if value := metaString(metadata, "sourceId"); value != "" {
		parts = append(parts, "sourceId="+value)
	}
	if value := metaString(metadata, "countryCodeAlpha2"); value != "" {
		parts = append(parts, "country="+value)
	}
	parts = append(parts, "count="+strconv.Itoa(row.Count))
	return strings.Join(parts, "\n")
}

func scorePointer(entry scoredRow) *float64 {
	if !entry.HasScore || math.IsNaN(entry.Score) || math.IsInf(entry.Score, 0) {
		return nil
	}
	score := entry.Score
	return &score
}

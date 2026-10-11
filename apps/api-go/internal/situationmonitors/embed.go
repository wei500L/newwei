package situationmonitors

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

type embeddingPayload struct {
	model  sql.NullString
	vector []byte
}

func (s *Service) buildQueryEmbedding(ctx context.Context, orgID, queryText, stage string) embeddingPayload {
	queryText = strings.TrimSpace(queryText)
	if queryText == "" || s == nil || s.embed == nil {
		return embeddingPayload{}
	}
	ctx = llmembed.ContextWithMeta(ctx, "situation-monitor-monitors", stage)
	vectors, model, err := s.embed.Embed(ctx, orgID, []string{queryText})
	if err != nil || len(vectors) == 0 || len(vectors[0]) == 0 {
		return embeddingPayload{}
	}
	normalized := normalizeVector(vectors[0])
	encoded, err := json.Marshal(normalized)
	if err != nil || len(normalized) == 0 {
		return embeddingPayload{}
	}
	payload := embeddingPayload{vector: encoded}
	if text := strings.TrimSpace(model); text != "" {
		payload.model = sql.NullString{String: text, Valid: true}
	}
	return payload
}

func buildQueryText(name string, rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexical []string, loc *locationDTO) string {
	parts := []string{"name=" + name}
	if len(rawKeywords) > 0 {
		parts = append(parts, "keywords="+strings.Join(rawKeywords, ", "))
	}
	if len(approvedTopics) > 0 {
		parts = append(parts, "topics="+strings.Join(approvedTopics, ", "))
	}
	if len(approvedEntities) > 0 {
		parts = append(parts, "entities="+strings.Join(approvedEntities, ", "))
	}
	if len(approvedSources) > 0 {
		parts = append(parts, "sources="+strings.Join(approvedSources, ", "))
	}
	if len(approvedGeos) > 0 {
		parts = append(parts, "geos="+strings.Join(approvedGeos, ", "))
	}
	if len(approvedLexical) > 0 {
		parts = append(parts, "lexical="+strings.Join(approvedLexical, ", "))
	}
	if loc != nil && loc.Name != "" {
		parts = append(parts, "location="+loc.Name)
	}
	if loc != nil && loc.CountryCodeAlpha2 != "" {
		country := contentsubscriptions.CountryEnglishName(loc.CountryCodeAlpha2)
		if country == "" {
			country = loc.CountryCodeAlpha2
		}
		parts = append(parts, "country="+country)
	}
	return strings.Join(parts, "\n")
}

func normalizeVector(vector []float64) []float64 {
	var magnitude float64
	for _, value := range vector {
		magnitude += value * value
	}
	magnitude = math.Sqrt(magnitude)
	if !finite(magnitude) || magnitude == 0 {
		return vector
	}
	out := make([]float64, len(vector))
	for i, value := range vector {
		out[i] = value / magnitude
	}
	return out
}

func dot(left, right []float64) float64 {
	limit := len(left)
	if len(right) < limit {
		limit = len(right)
	}
	var total float64
	for i := 0; i < limit; i++ {
		total += left[i] * right[i]
	}
	return total
}

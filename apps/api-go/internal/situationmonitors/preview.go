package situationmonitors

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/contentcatalog"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

type previewSuggestion struct {
	Value               string   `json:"value"`
	NormalizedValue     string   `json:"normalizedValue"`
	DisplayValue        string   `json:"displayValue"`
	Reason              string   `json:"reason"`
	Score               float64  `json:"score"`
	MatchedTerms        []string `json:"matchedTerms"`
	TaxonomyPath        *string  `json:"taxonomyPath,omitempty"`
	TaxonomyDisplayName *string  `json:"taxonomyDisplayName,omitempty"`
	includeTaxonomy     bool     `json:"-"`
}

type catalogSuggestion struct {
	Value               string   `json:"value"`
	NormalizedValue     string   `json:"normalizedValue"`
	DisplayValue        string   `json:"displayValue"`
	Reason              string   `json:"reason"`
	Score               float64  `json:"score"`
	MatchedTerms        []string `json:"matchedTerms"`
	TaxonomyPath        *string  `json:"taxonomyPath"`
	TaxonomyDisplayName *string  `json:"taxonomyDisplayName"`
}

type previewResponse struct {
	Name                  string       `json:"name"`
	RawKeywords           []string     `json:"rawKeywords"`
	LocationResolution    *locationDTO `json:"locationResolution"`
	SuggestedTopics       []any        `json:"suggestedTopics"`
	SuggestedEntities     []any        `json:"suggestedEntities"`
	SuggestedLexicalTerms []any        `json:"suggestedLexicalTerms"`
	ModelInfo             modelInfo    `json:"modelInfo"`
}

type modelInfo struct {
	EmbeddingModel string `json:"embeddingModel,omitempty"`
	RerankModel    string `json:"rerankModel,omitempty"`
}

type catalogRow struct {
	kind       string
	normalized string
	display    string
	count      int
	taxonomy   sql.NullString
	embedding  []byte
}

type scoredCatalog struct {
	row    catalogRow
	score  float64
	reason string
}

func (s *Service) Preview(ctx context.Context, orgID string, input monitorWrite) (previewResponse, error) {
	name := normalizeName(input.Name)
	rawKeywords := normalizeKeywordList(input.RawKeywords)
	rejected := rejectedState{
		Topics:       lowerList(input.RejectedTopics, maxApprovedSuggestions),
		Entities:     lowerList(input.RejectedEntities, maxApprovedSuggestions),
		LexicalTerms: lowerList(input.RejectedLexical, maxApprovedTerms),
	}
	names := s.taxonomyNames(ctx, orgID)
	loc := s.resolveLocation(ctx, input.Location)
	queryText := buildQueryText(name, rawKeywords, nil, nil, nil, nil, nil, loc)
	rows, err := s.catalogCandidates(ctx, orgID)
	if err != nil {
		return previewResponse{}, err
	}
	merged := map[string]scoredCatalog{}
	for _, row := range rows {
		if score := lexicalCatalogScore(row.display, row.normalized, name, rawKeywords); score > 0 {
			merged[subscriptionKey(row.kind, row.normalized)] = scoredCatalog{row: row, score: score, reason: "lexical"}
		}
	}
	ranked, embeddingModel := s.rankByEmbedding(ctx, orgID, queryText, rows)
	for _, entry := range ranked {
		key := subscriptionKey(entry.row.kind, entry.row.normalized)
		current, ok := merged[key]
		if !ok || entry.score > current.score {
			merged[key] = scoredCatalog{row: entry.row, score: entry.score, reason: "semantic"}
		}
	}
	ordered := orderCandidates(merged)
	shortlist := ordered
	if len(shortlist) > 16 {
		shortlist = shortlist[:16]
	}
	rerankByKey := map[string]float64{}
	for _, entry := range s.tryRerank(ctx, orgID, queryText, shortlist) {
		rerankByKey[subscriptionKey(entry.row.kind, entry.row.normalized)] = entry.score
	}
	final := make([]scoredCatalog, 0, len(merged))
	for _, entry := range merged {
		key := subscriptionKey(entry.row.kind, entry.row.normalized)
		if score, ok := rerankByKey[key]; ok {
			entry.score = 0.65*score + 0.35*entry.score
			entry.reason = "rerank"
		}
		final = append(final, entry)
	}
	sortCandidates(final)
	topics := filterSuggestions(final, "topic", rejected.Topics, rawKeywords, name, names)
	entities := filterSuggestions(final, "entity", rejected.Entities, rawKeywords, name, names)
	response := previewResponse{
		Name:                  name,
		RawKeywords:           nonNilStrings(rawKeywords),
		LocationResolution:    loc,
		SuggestedTopics:       topics,
		SuggestedEntities:     entities,
		SuggestedLexicalTerms: lexicalSuggestions(rawKeywords, append(append([]any{}, topics...), entities...), rejected.LexicalTerms),
		ModelInfo:             previewModelInfo(ctx, s.embed, embeddingModel),
	}
	return response, nil
}

// previewModelInfo mirrors NestJS previewMonitor's modelInfo block: the model
// that actually served the query embedding, plus the rerank model the gateway
// is configured with. NestJS reports the rerank model even when the rerank call
// was skipped or failed, so the field reflects configuration, not usage.
func previewModelInfo(ctx context.Context, gateway modelGateway, embeddingModel string) modelInfo {
	info := modelInfo{EmbeddingModel: embeddingModel}
	if gateway == nil {
		return info
	}
	if rerankModel, ok := gateway.RuntimeRerankModel(ctx); ok {
		info.RerankModel = strings.TrimSpace(rerankModel)
	}
	return info
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func orderCandidates(merged map[string]scoredCatalog) []scoredCatalog {
	out := make([]scoredCatalog, 0, len(merged))
	for _, entry := range merged {
		out = append(out, entry)
	}
	sortCandidates(out)
	return out
}

// sortCandidates orders by score, then by catalog occurrence count. Both sides
// of a tie are broken deterministically: candidates are collected from a map, so
// without the kind/normalized tiebreak the response order of equal-scoring
// suggestions would change between identical requests.
func sortCandidates(entries []scoredCatalog) {
	sort.SliceStable(entries, func(i, j int) bool {
		left, right := entries[i], entries[j]
		if left.score != right.score {
			return left.score > right.score
		}
		if left.row.count != right.row.count {
			return left.row.count > right.row.count
		}
		if left.row.kind != right.row.kind {
			return left.row.kind < right.row.kind
		}
		return left.row.normalized < right.row.normalized
	})
}

func (s *Service) catalogCandidates(ctx context.Context, orgID string) ([]catalogRow, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT kind, normalizedValue, displayValue, count, taxonomyPath, embeddingVector
FROM ContentSubscriptionCatalog
WHERE orgId = ? AND count >= 2
ORDER BY count DESC, lastSeenAt DESC
LIMIT ?`, orgID, previewCandidateLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]catalogRow, 0)
	for rows.Next() {
		var row catalogRow
		if err := rows.Scan(&row.kind, &row.normalized, &row.display, &row.count, &row.taxonomy, &row.embedding); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// taxonomyNames mirrors NestJS loadTaxonomyDisplayNames: the org's stored
// classification taxonomy merged over the built-in default taxonomy. Reading the
// SystemSetting row directly would drop the defaults, so a suggestion whose path
// the org never customized would lose its label. A settings read failure yields
// no labels, exactly like the NestJS catch block.
func (s *Service) taxonomyNames(ctx context.Context, orgID string) map[string]string {
	if s == nil || s.db == nil {
		return map[string]string{}
	}
	view, err := contentcatalog.NewService(s.db, nil, nil, nil).LoadTaxonomy(ctx, orgID)
	if err != nil {
		return map[string]string{}
	}
	return taxonomyLabels(view)
}

// taxonomyLabels projects the taxonomy view to path → display name, skipping
// nodes without a path so a malformed node cannot shadow the raw-path fallback.
func taxonomyLabels(view personalnews.TaxonomyView) map[string]string {
	names := make(map[string]string, len(view.ByPath))
	for path, node := range view.ByPath {
		if strings.TrimSpace(path) == "" {
			continue
		}
		names[path] = node.DisplayName
	}
	return names
}

func (s *Service) rankByEmbedding(ctx context.Context, orgID, queryText string, rows []catalogRow) ([]scoredCatalog, string) {
	if s == nil || s.embed == nil || strings.TrimSpace(queryText) == "" {
		return nil, ""
	}
	ctx = llmembed.ContextWithMeta(ctx, "situation-monitor-monitors", "preview-query")
	vectors, model, err := s.embed.Embed(ctx, orgID, []string{queryText})
	if err != nil || len(vectors) == 0 {
		return nil, ""
	}
	normalized := normalizeVector(vectors[0])
	if len(normalized) == 0 {
		return nil, ""
	}
	ranked := make([]scoredCatalog, 0)
	for _, row := range rows {
		candidate := parseNumberArray(row.embedding)
		if len(candidate) == 0 || len(candidate) != len(normalized) {
			continue
		}
		ranked = append(ranked, scoredCatalog{row: row, score: dot(normalized, candidate), reason: "semantic"})
	}
	sortCandidates(ranked)
	if len(ranked) > 16 {
		ranked = ranked[:16]
	}
	return ranked, strings.TrimSpace(model)
}

func (s *Service) tryRerank(ctx context.Context, orgID, queryText string, rows []scoredCatalog) []scoredCatalog {
	if s == nil || s.embed == nil || len(rows) == 0 {
		return nil
	}
	docs := make([]string, 0, len(rows))
	for _, entry := range rows {
		parts := []string{"kind=" + entry.row.kind, "name=" + entry.row.display}
		if entry.row.taxonomy.Valid && entry.row.taxonomy.String != "" {
			parts = append(parts, "taxonomy="+entry.row.taxonomy.String)
		}
		parts = append(parts, "count="+strconv.Itoa(entry.row.count))
		docs = append(docs, strings.Join(parts, "\n"))
	}
	ctx = llmembed.ContextWithMeta(ctx, "situation-monitor-monitors", "preview-rerank")
	hits, err := s.embed.Rerank(ctx, orgID, queryText, docs)
	if err != nil || len(hits) == 0 {
		return nil
	}
	type rawHit struct {
		row   catalogRow
		score float64
	}
	collected := make([]rawHit, 0, len(hits))
	min, max := math.Inf(1), math.Inf(-1)
	for _, hit := range hits {
		if hit.Index < 0 || hit.Index >= len(rows) || !finite(hit.Score) {
			continue
		}
		if hit.Score < min {
			min = hit.Score
		}
		if hit.Score > max {
			max = hit.Score
		}
		collected = append(collected, rawHit{row: rows[hit.Index].row, score: hit.Score})
	}
	if len(collected) == 0 {
		return nil
	}
	out := make([]scoredCatalog, 0, len(collected))
	for _, entry := range collected {
		score := 1.0
		if max != min {
			score = (entry.score - min) / (max - min)
		}
		out = append(out, scoredCatalog{row: entry.row, score: score, reason: "rerank"})
	}
	sortCandidates(out)
	return out
}

func lexicalCatalogScore(displayValue, normalizedValue, name string, rawKeywords []string) float64 {
	var score float64
	seen := false
	for _, entry := range append([]string{name}, rawKeywords...) {
		token := normalizeTerm(entry)
		if token == "" {
			continue
		}
		seen = true
		haystack := normalizeTerm(displayValue) + " " + normalizedValue
		if strings.Contains(haystack, token) {
			if utf16Len(token) > 4 {
				score += 0.35
			} else {
				score += 0.2
			}
		}
	}
	if !seen || score <= 0 {
		return 0
	}
	if score > 1 {
		return 1
	}
	return score
}

func filterSuggestions(entries []scoredCatalog, kind string, rejected, rawKeywords []string, name string, names map[string]string) []any {
	rejectedSet := map[string]struct{}{}
	for _, entry := range rejected {
		rejectedSet[entry] = struct{}{}
	}
	keywordSet := map[string]struct{}{}
	for _, keyword := range rawKeywords {
		keywordSet[normalizeTerm(keyword)] = struct{}{}
	}
	out := make([]any, 0)
	for _, entry := range entries {
		if entry.row.kind != kind {
			continue
		}
		if _, skip := rejectedSet[entry.row.normalized]; skip {
			continue
		}
		if _, skip := keywordSet[entry.row.normalized]; skip {
			continue
		}
		var path *string
		var display *string
		if entry.row.taxonomy.Valid && strings.TrimSpace(entry.row.taxonomy.String) != "" {
			value := entry.row.taxonomy.String
			path = &value
			label := value
			if mapped, ok := names[value]; ok && mapped != "" {
				label = mapped
			}
			display = &label
		}
		out = append(out, catalogSuggestion{
			Value:               entry.row.display,
			NormalizedValue:     entry.row.normalized,
			DisplayValue:        entry.row.display,
			Reason:              entry.reason,
			Score:               roundScore(entry.score),
			MatchedTerms:        matchedTerms(entry.row.display, entry.row.normalized, name, rawKeywords),
			TaxonomyPath:        path,
			TaxonomyDisplayName: display,
		})
		if len(out) >= previewSuggestionLimit {
			break
		}
	}
	return out
}

func lexicalSuggestions(rawKeywords []string, suggestions []any, rejected []string) []any {
	type keyed struct {
		key   string
		value any
	}
	seen := map[string]struct{}{}
	out := make([]keyed, 0)
	for _, keyword := range rawKeywords {
		normalized := normalizeTerm(keyword)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		display := normalizeDisplayValue(keyword)
		seen[normalized] = struct{}{}
		out = append(out, keyed{key: normalized, value: previewSuggestion{
			Value: keyword, NormalizedValue: normalized, DisplayValue: display,
			Reason: "lexical", Score: 1, MatchedTerms: []string{display},
		}})
	}
	rejectedSet := map[string]struct{}{}
	for _, entry := range rejected {
		rejectedSet[entry] = struct{}{}
	}
	for _, suggestion := range suggestions {
		normalized := suggestionNormalized(suggestion)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		if _, skip := rejectedSet[normalized]; skip {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, keyed{key: normalized, value: suggestion})
		if len(seen) >= previewSuggestionLimit+len(rawKeywords) {
			break
		}
	}
	limit := previewSuggestionLimit + len(rawKeywords)
	values := make([]any, 0, len(out))
	for _, entry := range out {
		values = append(values, entry.value)
		if len(values) >= limit {
			break
		}
	}
	return values
}

func suggestionNormalized(value any) string {
	switch item := value.(type) {
	case catalogSuggestion:
		return item.NormalizedValue
	case previewSuggestion:
		return item.NormalizedValue
	default:
		return ""
	}
}

func matchedTerms(displayValue, normalizedValue, name string, rawKeywords []string) []string {
	haystack := normalizeTerm(displayValue) + " " + normalizedValue
	order := make([]string, 0)
	matched := map[string]string{}
	add := func(key, term string) {
		if _, ok := matched[key]; ok {
			return
		}
		matched[key] = term
		order = append(order, key)
	}
	for _, entry := range append([]string{name}, rawKeywords...) {
		term := normalizeDisplayValue(entry)
		if term == "" {
			continue
		}
		normalizedTerm := normalizeTerm(term)
		if normalizedTerm != "" && (strings.Contains(haystack, normalizedTerm) || strings.Contains(normalizedTerm, normalizedValue)) {
			add(normalizedTerm, term)
			continue
		}
		for _, token := range strings.FieldsFunc(normalizedTerm, func(r rune) bool { return !isTermRune(r) }) {
			if utf16Len(token) < 3 || !strings.Contains(haystack, token) {
				continue
			}
			add(token, term)
			break
		}
		if len(matched) >= 4 {
			break
		}
	}
	out := make([]string, 0, len(order))
	for _, key := range order {
		out = append(out, matched[key])
		if len(out) >= 4 {
			break
		}
	}
	return out
}

func isTermRune(r rune) bool {
	if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
		return true
	}
	if r >= 0x00c0 && r <= 0x024f {
		return true
	}
	return r >= 0x4e00 && r <= 0x9fff
}

func roundScore(value float64) float64 {
	return math.Round(value*1000) / 1000
}

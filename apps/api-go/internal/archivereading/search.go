package archivereading

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

const (
	maxRerankDocuments    = 180
	minVectorScore        = 0.55
	fullTextMinToken      = 2
	rerankWeight          = 0.75
	baseRelevanceWeight   = 0.25
	embeddingCacheTTL     = 5 * time.Minute
	vectorRecallCacheTTL  = 60 * time.Second
	rerankCacheTTL        = 90 * time.Second
	searchCacheMaxEntries = 200
	archiveCachePrefix    = "archive:search"
	archiveMetricPrefix   = "archive:metrics"
	metricRetention       = 30 * 24 * time.Hour
)

// embeddingPayload is the shared embedding cache value. Model is the actual
// model reported by the upstream and must survive both cache layers.
type embeddingPayload struct {
	Vector []float64 `json:"vector"`
	Model  string    `json:"model"`
}

// vectorRecallPayload is one shared vector recall entry.
type vectorRecallPayload struct {
	ProcessedItemID string  `json:"processedItemId"`
	Score           float64 `json:"score"`
}

type embeddingCacheEntry struct {
	value     embeddingPayload
	expiresAt time.Time
}

type vectorCacheEntry struct {
	value     []vectorRecallPayload
	expiresAt time.Time
}

type rerankCacheEntry struct {
	value     map[string]float64
	expiresAt time.Time
}

// searchCache is the process-local two-layer cache half. It is deliberately
// small, timed and org-keyed; the shared Redis layer is the RedisCache port.
type searchCache struct {
	mu         sync.Mutex
	embeddings map[string]embeddingCacheEntry
	vectors    map[string]vectorCacheEntry
	reranks    map[string]rerankCacheEntry
	now        func() time.Time
}

func newSearchCache() *searchCache {
	return &searchCache{
		embeddings: map[string]embeddingCacheEntry{},
		vectors:    map[string]vectorCacheEntry{},
		reranks:    map[string]rerankCacheEntry{},
		now:        time.Now,
	}
}

func (c *searchCache) getEmbedding(key string) (embeddingPayload, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.embeddings[key]
	if !ok || !entry.expiresAt.After(c.now()) {
		delete(c.embeddings, key)
		return embeddingPayload{}, false
	}
	return entry.value, true
}

func (c *searchCache) putEmbedding(key string, value embeddingPayload) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.embeddings[key] = embeddingCacheEntry{value: value, expiresAt: c.now().Add(embeddingCacheTTL)}
	c.trimLocked(len(c.embeddings))
}

func (c *searchCache) getVector(key string) ([]vectorRecallPayload, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.vectors[key]
	if !ok || !entry.expiresAt.After(c.now()) {
		delete(c.vectors, key)
		return nil, false
	}
	return entry.value, true
}

func (c *searchCache) putVector(key string, value []vectorRecallPayload) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.vectors[key] = vectorCacheEntry{value: value, expiresAt: c.now().Add(vectorRecallCacheTTL)}
	c.trimLocked(len(c.vectors))
}

func (c *searchCache) getRerank(key string) (map[string]float64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.reranks[key]
	if !ok || !entry.expiresAt.After(c.now()) {
		delete(c.reranks, key)
		return nil, false
	}
	return entry.value, true
}

func (c *searchCache) putRerank(key string, value map[string]float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reranks[key] = rerankCacheEntry{value: value, expiresAt: c.now().Add(rerankCacheTTL)}
	c.trimLocked(len(c.reranks))
}

func (c *searchCache) trimLocked(size int) {
	if size <= searchCacheMaxEntries {
		return
	}
	now := c.now()
	for key, entry := range c.embeddings {
		if !entry.expiresAt.After(now) {
			delete(c.embeddings, key)
		}
	}
	for key, entry := range c.vectors {
		if !entry.expiresAt.After(now) {
			delete(c.vectors, key)
		}
	}
	for key, entry := range c.reranks {
		if !entry.expiresAt.After(now) {
			delete(c.reranks, key)
		}
	}
}

// searchCandidateResult carries the projected candidates and their ranking
// metadata without exposing the maps through GraphQL.
type searchCandidateResult struct {
	Rows            []*ArchiveRow
	RerankScores    map[string]float64
	RelevanceScores map[string]float64
	Origins         map[string]MatchOrigin
}

type searchMetrics struct {
	queryLength        int
	semanticRows       int
	lexicalRows        int
	mergedRows         int
	semanticOnly       int
	lexicalOnly        int
	hybrid             int
	rerankCandidates   int
	rerankScored       int
	embeddingMemoryHit bool
	embeddingRedisHit  bool
	vectorMemoryHit    bool
	vectorRedisHit     bool
	rerankMemoryHit    bool
	rerankRedisHit     bool
}

// searchCandidates runs the full semantic search chain once: embedding, vector
// and lexical recall, merge, optional rerank, shared caching and metrics.
func (s *Service) searchCandidates(ctx context.Context, orgID string, anchor time.Time, query string) (searchCandidateResult, error) {
	started := time.Now()
	normalized := strings.TrimSpace(query)
	queryHash := hashText(strings.ToLower(normalized))
	metrics := searchMetrics{queryLength: jsStringLength(normalized)}

	if s.models == nil {
		return searchCandidateResult{}, serviceUnavailable(AppCodeEmbeddingUnavailable, "", "embedding model is not configured")
	}
	configuredModel, ok := s.models.RuntimeEmbeddingModel(ctx)
	if !ok || strings.TrimSpace(configuredModel) == "" {
		log.Printf("api-go: archive search embedding model is not configured org=%s", orgID)
		return searchCandidateResult{}, serviceUnavailable(AppCodeEmbeddingUnavailable, "", "embedding model is not configured")
	}

	embeddingKey := buildCacheKey("embedding:v1", orgID, configuredModel, queryHash)
	var vector []float64
	vectorModel := configuredModel
	if cached, ok := s.cache.getEmbedding(embeddingKey); ok {
		metrics.embeddingMemoryHit = true
		vector = append([]float64(nil), cached.Vector...)
		if cached.Model != "" {
			vectorModel = cached.Model
		}
	} else if cached, ok := s.getSharedEmbedding(ctx, embeddingKey); ok {
		metrics.embeddingRedisHit = true
		vector = append([]float64(nil), cached.Vector...)
		if cached.Model != "" {
			vectorModel = cached.Model
		}
		s.cache.putEmbedding(embeddingKey, cached)
	}

	if len(vector) == 0 {
		outcome, err := s.models.EmbedForArchive(ctx, orgID, configuredModel, normalized, "archive-search")
		s.recordAttempts(ctx, orgID, outcome.Attempts, "archive-search")
		if err != nil {
			return searchCandidateResult{}, archiveModelFailure(err, AppCodeEmbeddingUnavailable, AppCodeEmbeddingFailed, AppCodeEmbeddingInvalidResponse)
		}
		if len(outcome.Vectors) == 0 || len(outcome.Vectors[0]) == 0 {
			return searchCandidateResult{}, serviceUnavailable(AppCodeEmbeddingInvalidResponse, "", "embedding response has no usable vector")
		}
		vector = outcome.Vectors[0]
		if outcome.Model != "" {
			vectorModel = outcome.Model
		}
		payload := embeddingPayload{Vector: append([]float64(nil), vector...), Model: vectorModel}
		s.cache.putEmbedding(embeddingKey, payload)
		s.setSharedEmbedding(ctx, embeddingKey, payload)
	}

	vectorKey := buildCacheKey("vector:v1", orgID, vectorModel, queryHash)
	var matches []vectorRecallPayload
	if cached, ok := s.cache.getVector(vectorKey); ok {
		metrics.vectorMemoryHit = true
		matches = append([]vectorRecallPayload(nil), cached...)
	} else if cached, ok := s.getSharedVector(ctx, vectorKey); ok {
		metrics.vectorRedisHit = true
		matches = cached
		s.cache.putVector(vectorKey, cached)
	}
	if matches == nil {
		if s.vector == nil {
			return searchCandidateResult{}, serviceUnavailable(AppCodeVectorUnavailable, "", "vector client is not configured")
		}
		found, available := s.vector.Search(ctx, itemsreading.ArchiveVectorRequest{
			OrgID:          orgID,
			EmbeddingModel: vectorModel,
			Vector:         vector,
			Limit:          maxSearchScan,
			MinScore:       minVectorScore,
		})
		if !available {
			log.Printf("api-go: archive vector recall unavailable org=%s model=%s", orgID, vectorModel)
			return searchCandidateResult{}, serviceUnavailable(AppCodeVectorUnavailable, "", "vector service unavailable")
		}
		matches = make([]vectorRecallPayload, 0, len(found))
		for _, match := range found {
			matches = append(matches, vectorRecallPayload{ProcessedItemID: match.ProcessedItemID, Score: match.Score})
		}
		s.cache.putVector(vectorKey, matches)
		s.setSharedVector(ctx, vectorKey, matches)
	}

	vectorScoreByRef := make(map[string]float64, len(matches))
	for _, match := range matches {
		vectorScoreByRef[match.ProcessedItemID] = match.Score
	}
	refs := make([]string, 0, len(vectorScoreByRef))
	for ref := range vectorScoreByRef {
		if strings.TrimSpace(ref) != "" {
			refs = append(refs, ref)
		}
	}
	semanticRows, err := s.store.byCleanedRefs(ctx, orgID, refs, maxSearchScan)
	if err != nil {
		return searchCandidateResult{}, err
	}
	lexicalRows, err := s.loadLexicalRows(ctx, orgID, anchor, normalized)
	if err != nil {
		return searchCandidateResult{}, err
	}
	metrics.semanticRows = len(semanticRows)
	metrics.lexicalRows = len(lexicalRows)

	semanticIDs := make(map[string]struct{}, len(semanticRows))
	for _, row := range semanticRows {
		semanticIDs[row.ID] = struct{}{}
	}
	lexicalIDs := make(map[string]struct{}, len(lexicalRows))
	for _, row := range lexicalRows {
		lexicalIDs[row.ID] = struct{}{}
	}
	unique := dedupeRows(append(append([]*ArchiveRow{}, semanticRows...), lexicalRows...))

	type scoredRow struct {
		row    *ArchiveRow
		base   float64
		sortAt time.Time
		order  int
	}
	scored := make([]scoredRow, 0, len(unique))
	baseScores := make(map[string]float64, len(unique))
	origins := make(map[string]MatchOrigin, len(unique))
	for index, row := range unique {
		sortAt := row.SortAt()
		if sortAt.After(anchor) {
			continue
		}
		semanticScore := vectorScoreByRef[row.CleanedMarkdownRef]
		lexicalScore := computeLexicalScore(normalized, buildLexicalDocument(row))
		base := computeBaseRelevanceScore(semanticScore, lexicalScore)
		_, hasSemantic := semanticIDs[row.ID]
		_, hasLexical := lexicalIDs[row.ID]
		if origin := resolveMatchOrigin(hasSemantic, hasLexical); origin != "" {
			origins[row.ID] = origin
			switch origin {
			case MatchOriginSemantic:
				metrics.semanticOnly++
			case MatchOriginLexical:
				metrics.lexicalOnly++
			case MatchOriginHybrid:
				metrics.hybrid++
			}
		}
		baseScores[row.ID] = base
		scored = append(scored, scoredRow{row: row, base: base, sortAt: sortAt, order: index})
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].base != scored[j].base {
			return scored[i].base > scored[j].base
		}
		if !scored[i].sortAt.Equal(scored[j].sortAt) {
			return scored[i].sortAt.After(scored[j].sortAt)
		}
		return scored[i].order < scored[j].order
	})
	preRanked := make([]*ArchiveRow, 0, len(scored))
	for _, entry := range scored {
		preRanked = append(preRanked, entry.row)
	}
	metrics.mergedRows = len(preRanked)

	rerankCandidates := preRanked
	if len(rerankCandidates) > maxRerankDocuments {
		rerankCandidates = rerankCandidates[:maxRerankDocuments]
	}
	metrics.rerankCandidates = len(rerankCandidates)
	if len(rerankCandidates) == 0 {
		s.recordMetrics(ctx, orgID, metrics)
		log.Printf("api-go: archive search no rerank candidates org=%s qlen=%d semantic=%d lexical=%d elapsed=%s",
			orgID, jsStringLength(normalized), len(semanticRows), len(lexicalRows), time.Since(started))
		return searchCandidateResult{Rows: preRanked, RerankScores: map[string]float64{}, RelevanceScores: baseScores, Origins: origins}, nil
	}

	ids := make([]string, 0, len(rerankCandidates))
	for _, row := range rerankCandidates {
		ids = append(ids, row.ID)
	}
	rerankKey := buildCacheKey("rerank:v1", orgID, queryHash, hashText(strings.Join(ids, ",")))
	rerankScores := map[string]float64{}
	if cached, ok := s.cache.getRerank(rerankKey); ok {
		metrics.rerankMemoryHit = true
		for id, score := range cached {
			rerankScores[id] = score
		}
	} else if cached, ok := s.getSharedRerank(ctx, rerankKey); ok {
		metrics.rerankRedisHit = true
		rerankScores = cached
		s.cache.putRerank(rerankKey, cached)
	}
	if len(rerankScores) == 0 {
		documents := make([]string, 0, len(rerankCandidates))
		for _, row := range rerankCandidates {
			documents = append(documents, buildRerankDocument(row))
		}
		_, timeout, ok := s.models.RuntimeRerankProfile(ctx)
		if !ok {
			return searchCandidateResult{}, serviceUnavailable(AppCodeRerankFailed, "", "rerank model is not configured")
		}
		outcome, err := s.models.RerankForArchive(ctx, orgID, normalized, documents, 1, timeout, "archive-search-rerank")
		s.recordAttempts(ctx, orgID, outcome.Attempts, "archive-search-rerank")
		if err != nil {
			return searchCandidateResult{}, archiveModelFailure(err, AppCodeRerankFailed, AppCodeRerankFailed, AppCodeRerankInvalidResponse)
		}
		numeric := make([]float64, 0, len(outcome.Hits))
		for _, hit := range outcome.Hits {
			if isFinite(hit.Score) {
				numeric = append(numeric, hit.Score)
			}
		}
		minScore, maxScore := 0.0, 0.0
		if len(numeric) > 0 {
			minScore, maxScore = numeric[0], numeric[0]
			for _, score := range numeric[1:] {
				if score < minScore {
					minScore = score
				}
				if score > maxScore {
					maxScore = score
				}
			}
		}
		span := maxScore - minScore
		for _, hit := range outcome.Hits {
			if hit.Index < 0 || hit.Index >= len(rerankCandidates) {
				continue
			}
			normalizedScore := 0.0
			if span > scoreTieEpsilon {
				normalizedScore = (hit.Score - minScore) / span
			} else if maxScore > 0 {
				normalizedScore = 1
			}
			rerankScores[rerankCandidates[hit.Index].ID] = clamp01(normalizedScore)
		}
	}
	if len(rerankCandidates) > 0 && len(rerankScores) == 0 {
		return searchCandidateResult{}, serviceUnavailable(AppCodeRerankInvalidResponse, "", "rerank response has no usable score")
	}
	if len(rerankScores) > 0 {
		s.cache.putRerank(rerankKey, rerankScores)
		s.setSharedRerank(ctx, rerankKey, rerankScores)
	}
	metrics.rerankScored = len(rerankScores)

	relevance := make(map[string]float64, len(baseScores))
	for id, base := range baseScores {
		relevance[id] = base
	}
	for _, row := range preRanked {
		if score, ok := rerankScores[row.ID]; ok {
			relevance[row.ID] = clamp01(score*rerankWeight + baseScores[row.ID]*baseRelevanceWeight)
		}
	}
	s.recordMetrics(ctx, orgID, metrics)
	log.Printf("api-go: archive search completed org=%s qlen=%d semantic=%d lexical=%d merged=%d rerank=%d elapsed=%s",
		orgID, len(normalized), len(semanticRows), len(lexicalRows), len(preRanked), len(rerankScores), time.Since(started))

	return searchCandidateResult{
		Rows:            preRanked,
		RerankScores:    rerankScores,
		RelevanceScores: relevance,
		Origins:         origins,
	}, nil
}

// archiveModelFailure maps a llmembed.ModelFailure kind onto the public code.
func archiveModelFailure(err error, unavailable, failed, invalid string) *Error {
	var failure *llmembed.ModelFailure
	if errors.As(err, &failure) {
		switch failure.Kind {
		case llmembed.ModelFailureUnavailable:
			return serviceUnavailable(unavailable, "", failure.Error())
		case llmembed.ModelFailureInvalidResponse:
			return serviceUnavailable(invalid, "", failure.Error())
		default:
			return serviceUnavailable(failed, "", failure.Error())
		}
	}
	return serviceUnavailable(failed, "", err.Error())
}

func (s *Service) recordAttempts(ctx context.Context, orgID string, attempts []llmembed.Attempt, source string) {
	if s.attempts == nil || len(attempts) == 0 {
		return
	}
	for _, attempt := range attempts {
		status := "success"
		if !attempt.Success {
			status = "error"
		}
		entry := ModelAttempt{
			OrgID:                     orgID,
			RequestType:               requestTypeForSurface(attempt.APISurface),
			Model:                     attempt.Model,
			Status:                    status,
			Error:                     attempt.Error,
			Latency:                   attempt.Latency,
			Usage:                     ModelUsage{PromptTokens: attempt.Usage.PromptTokens, CompletionTokens: attempt.Usage.CompletionTokens, TotalTokens: attempt.Usage.TotalTokens, CostUSD: attempt.Usage.CostUSD},
			GatewayProfileID:          attempt.ProfileID,
			GovernanceApplied:         attempt.GovernanceApplied,
			AuthMode:                  attempt.AuthMode,
			GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
			APISurface:                attempt.APISurface,
			MetadataSource:            source,
			OccurredAt:                attempt.OccurredAt,
		}
		if err := s.attempts.WriteArchiveAttempt(ctx, entry); err != nil {
			log.Printf("api-go: archive search model log write failed org=%s model=%s: %v", orgID, attempt.Model, err)
		}
	}
}

func requestTypeForSurface(surface string) string {
	if surface == "rerank" {
		return "rerank"
	}
	return "embedding"
}

// loadLexicalRows reproduces loadLexicalSearchRows: full-text ids first, then a
// contains fallback that always runs, merged and de-duplicated.
func (s *Service) loadLexicalRows(ctx context.Context, orgID string, anchor time.Time, query string) ([]*ArchiveRow, error) {
	fullTextQuery := buildFullTextQuery(query)
	fullTextIDs, err := s.store.lexicalFullTextIDs(ctx, orgID, anchor, fullTextQuery)
	if err != nil {
		log.Printf("api-go: archive lexical fulltext failed org=%s, falling back to contains: %v", orgID, err)
		fullTextIDs = nil
	}
	normalized := strings.TrimSpace(query)
	if normalized == "" {
		return nil, nil
	}
	terms := uniqueStrings(append([]string{normalized}, tokenizeSearch(normalized, fullTextMinToken)...))
	if len(terms) > 8 {
		terms = terms[:8]
	}
	fallback, err := s.store.lexicalContainsRows(ctx, orgID, anchor, terms)
	if err != nil {
		return nil, err
	}
	if len(fullTextIDs) == 0 {
		return fallback, nil
	}
	fallbackIDs := make(map[string]struct{}, len(fallback))
	for _, row := range fallback {
		fallbackIDs[row.ID] = struct{}{}
	}
	missing := make([]string, 0, len(fullTextIDs))
	for _, id := range fullTextIDs {
		if _, ok := fallbackIDs[id]; ok {
			continue
		}
		missing = append(missing, id)
		if len(missing) >= maxSearchScan {
			break
		}
	}
	fullTextRows, err := s.store.rowsByIDs(ctx, orgID, missing)
	if err != nil {
		return nil, err
	}
	return dedupeRows(append(fallback, fullTextRows...)), nil
}

func buildFullTextQuery(search string) string {
	tokens := tokenizeSearch(search, fullTextMinToken)
	if len(tokens) == 0 {
		return ""
	}
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		parts = append(parts, token+"*")
	}
	return strings.Join(parts, " ")
}

func tokenizeSearch(search string, minLength int) []string {
	out := make([]string, 0, 8)
	for _, token := range strings.Fields(search) {
		cleaned := strings.TrimSpace(stripFullTextOperators(token))
		if jsStringLength(cleaned) >= minLength {
			out = append(out, cleaned)
		}
	}
	return out
}

func stripFullTextOperators(value string) string {
	var builder strings.Builder
	for _, r := range value {
		switch r {
		case '+', '-', '>', '<', '(', ')', '~', '"', '*', '@':
			continue
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

// jsStringLength counts UTF-16 code units, matching JavaScript String.length.
func jsStringLength(value string) int {
	units := 0
	for _, r := range value {
		if r > 0xffff {
			units += 2
		} else {
			units++
		}
	}
	return units
}

func uniqueStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func dedupeRows(rows []*ArchiveRow) []*ArchiveRow {
	out := make([]*ArchiveRow, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if _, ok := seen[row.ID]; ok {
			continue
		}
		seen[row.ID] = struct{}{}
		out = append(out, row)
	}
	return out
}

func buildLexicalDocument(row *ArchiveRow) string {
	entities := entityNames(row.EntitiesJSON)
	if len(entities) > 8 {
		entities = entities[:8]
	}
	parts := []string{row.Title, row.Summary, row.SourceLabelDisplay(), row.Location, strings.Join(entities, ", ")}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	return strings.Join(kept, "\n")
}

func buildRerankDocument(row *ArchiveRow) string {
	title := strings.TrimSpace(row.Title)
	summary := strings.TrimSpace(row.Summary)
	source := strings.TrimSpace(row.SourceLabelDisplay())
	parts := make([]string, 0, 3)
	if title != "" {
		parts = append(parts, title)
	}
	if summary != "" {
		parts = append(parts, summary)
	}
	if source != "" {
		parts = append(parts, "Source: "+source)
	}
	return strings.Join(parts, "\n")
}

func computeLexicalScore(query, document string) float64 {
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	if normalizedQuery == "" {
		return 0
	}
	normalizedDocument := strings.ToLower(strings.TrimSpace(document))
	if normalizedDocument == "" {
		return 0
	}
	if strings.Contains(normalizedDocument, normalizedQuery) {
		return 1
	}
	tokens := tokenizeSearch(normalizedQuery, fullTextMinToken)
	if len(tokens) == 0 {
		return 0
	}
	matched := 0
	for _, token := range tokens {
		if strings.Contains(normalizedDocument, token) {
			matched++
		}
	}
	return clamp01(float64(matched) / float64(len(tokens)))
}

func computeBaseRelevanceScore(semanticScore, lexicalScore float64) float64 {
	semantic := clamp01(semanticScore)
	lexical := clamp01(lexicalScore)
	if semantic > 0 && lexical > 0 {
		return clamp01(semantic*0.6 + lexical*0.4 + 0.05)
	}
	return math.Max(semantic, lexical)
}

func resolveMatchOrigin(hasSemantic, hasLexical bool) MatchOrigin {
	switch {
	case hasSemantic && hasLexical:
		return MatchOriginHybrid
	case hasSemantic:
		return MatchOriginSemantic
	case hasLexical:
		return MatchOriginLexical
	default:
		return ""
	}
}

func buildCacheKey(parts ...string) string {
	return archiveCachePrefix + ":" + strings.Join(parts, ":")
}

func hashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (s *Service) getSharedEmbedding(ctx context.Context, key string) (embeddingPayload, bool) {
	raw, ok, err := s.redisGet(ctx, key)
	if err != nil || !ok {
		return embeddingPayload{}, false
	}
	var payload embeddingPayload
	if json.Unmarshal(raw, &payload) != nil || len(payload.Vector) == 0 {
		return embeddingPayload{}, false
	}
	return payload, true
}

func (s *Service) setSharedEmbedding(ctx context.Context, key string, payload embeddingPayload) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	s.redisSet(ctx, key, raw, embeddingCacheTTL)
}

func (s *Service) getSharedVector(ctx context.Context, key string) ([]vectorRecallPayload, bool) {
	raw, ok, err := s.redisGet(ctx, key)
	if err != nil || !ok {
		return nil, false
	}
	var payload []vectorRecallPayload
	if json.Unmarshal(raw, &payload) != nil || len(payload) == 0 {
		return nil, false
	}
	normalized := make([]vectorRecallPayload, 0, len(payload))
	for _, entry := range payload {
		if strings.TrimSpace(entry.ProcessedItemID) == "" || !isFinite(entry.Score) {
			continue
		}
		normalized = append(normalized, entry)
	}
	if len(normalized) == 0 {
		return nil, false
	}
	return normalized, true
}

func (s *Service) setSharedVector(ctx context.Context, key string, payload []vectorRecallPayload) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	s.redisSet(ctx, key, raw, vectorRecallCacheTTL)
}

func (s *Service) getSharedRerank(ctx context.Context, key string) (map[string]float64, bool) {
	raw, ok, err := s.redisGet(ctx, key)
	if err != nil || !ok {
		return nil, false
	}
	var payload map[string]float64
	if json.Unmarshal(raw, &payload) != nil {
		return nil, false
	}
	out := make(map[string]float64, len(payload))
	for id, score := range payload {
		if !isFinite(score) {
			continue
		}
		out[id] = clamp01(score)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func (s *Service) setSharedRerank(ctx context.Context, key string, payload map[string]float64) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	s.redisSet(ctx, key, raw, rerankCacheTTL)
}

func (s *Service) redisGet(ctx context.Context, key string) ([]byte, bool, error) {
	if s.redis == nil {
		return nil, false, nil
	}
	return s.redis.Get(ctx, key)
}

func (s *Service) redisSet(ctx context.Context, key string, raw []byte, ttl time.Duration) {
	if s.redis == nil {
		return
	}
	if err := s.redis.Set(ctx, key, raw, ttlSeconds(ttl)); err != nil {
		log.Printf("api-go: archive shared cache write failed key=%s: %v", key, err)
	}
}

func ttlSeconds(ttl time.Duration) time.Duration {
	seconds := int64(math.Ceil(math.Max(1000, float64(ttl/time.Millisecond)) / 1000))
	if seconds < 1 {
		seconds = 1
	}
	return time.Duration(seconds) * time.Second
}

func (s *Service) recordMetrics(ctx context.Context, orgID string, metrics searchMetrics) {
	if s.redis == nil {
		return
	}
	key := archiveMetricPrefix + ":" + orgID + ":" + dateKey(time.Now())
	fields := []struct {
		name  string
		value int64
	}{
		{"requests.total", 1},
		{"rows.semantic_total", int64(metrics.semanticRows)},
		{"rows.lexical_total", int64(metrics.lexicalRows)},
		{"rows.merged_total", int64(metrics.mergedRows)},
		{"origins.semantic_only_total", int64(metrics.semanticOnly)},
		{"origins.lexical_only_total", int64(metrics.lexicalOnly)},
		{"origins.hybrid_total", int64(metrics.hybrid)},
		{"rerank.candidate_total", int64(metrics.rerankCandidates)},
		{"rerank.scored_total", int64(metrics.rerankScored)},
		{"query_length." + queryLengthBucket(metrics.queryLength), 1},
		{"cache.embedding.memory.hit", boolInt(metrics.embeddingMemoryHit)},
		{"cache.embedding.memory.miss", boolInt(!metrics.embeddingMemoryHit)},
		{"cache.embedding.redis.hit", boolInt(metrics.embeddingRedisHit)},
		{"cache.embedding.redis.miss", boolInt(!metrics.embeddingRedisHit)},
		{"cache.vector.memory.hit", boolInt(metrics.vectorMemoryHit)},
		{"cache.vector.memory.miss", boolInt(!metrics.vectorMemoryHit)},
		{"cache.vector.redis.hit", boolInt(metrics.vectorRedisHit)},
		{"cache.vector.redis.miss", boolInt(!metrics.vectorRedisHit)},
		{"cache.rerank.memory.hit", boolInt(metrics.rerankMemoryHit)},
		{"cache.rerank.memory.miss", boolInt(!metrics.rerankMemoryHit)},
		{"cache.rerank.redis.hit", boolInt(metrics.rerankRedisHit)},
		{"cache.rerank.redis.miss", boolInt(!metrics.rerankRedisHit)},
	}
	for _, field := range fields {
		if err := s.redis.IncrBy(ctx, key, field.name, field.value); err != nil {
			log.Printf("api-go: archive metric write failed key=%s field=%s: %v", key, field.name, err)
			return
		}
	}
	if err := s.redis.Expire(ctx, key, metricRetention); err != nil {
		log.Printf("api-go: archive metric expire failed key=%s: %v", key, err)
	}
}

func boolInt(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func queryLengthBucket(length int) string {
	switch {
	case length <= 1:
		return "len_00_01"
	case length <= 3:
		return "len_02_03"
	case length <= 7:
		return "len_04_07"
	case length <= 15:
		return "len_08_15"
	case length <= 31:
		return "len_16_31"
	default:
		return "len_32_plus"
	}
}

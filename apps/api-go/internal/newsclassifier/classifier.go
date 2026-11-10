package newsclassifier

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// maxRerankDocuments caps how many documents go into a single rerank request.
// The full leaf set is ranked when no earlier layer produced candidates; this
// bound matches maxTaxonomyNodes so any taxonomy the settings layer accepts
// fits in one request, while future growth beyond the upstream document limit is
// truncated and logged instead of failing the whole layer.
const maxRerankDocuments = maxTaxonomyNodes

// ModelClient is the model surface one classification session uses.
type ModelClient interface {
	RuntimeEmbeddingModel(ctx context.Context) (litellmcompat.RuntimeModel, error)
	Completion(ctx context.Context, req litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error)
	Embedding(ctx context.Context, req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error)
	Rerank(ctx context.Context, req litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error)
}

// SettingsProvider is the classification settings surface.
type SettingsProvider interface {
	Get(ctx context.Context, orgID string) Settings
}

// PolicyProvider is the source-policy surface.
type PolicyProvider interface {
	Get(ctx context.Context, orgID string) (sourcePolicy, error)
}

// Deps wires one classification session.
type Deps struct {
	Client         ModelClient
	Settings       SettingsProvider
	SourcePolicies PolicyProvider
	Now            func() time.Time
	Warn           func(format string, args ...any)
}

// Session owns the per-task taxonomy embedding cache. It is not safe to share a
// Session between preparation jobs because O2 deliberately scopes the cache to
// one job.
type Session struct {
	client    ModelClient
	settings  SettingsProvider
	policies  PolicyProvider
	now       func() time.Time
	warn      func(format string, args ...any)
	embedding *taxonomyEmbeddingCache
}

// NewSession builds a per-task classifier session.
func NewSession(deps Deps) *Session {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	warn := deps.Warn
	if warn == nil {
		warn = func(format string, args ...any) { log.Printf(format, args...) }
	}
	return &Session{
		client:    deps.Client,
		settings:  deps.Settings,
		policies:  deps.SourcePolicies,
		now:       now,
		warn:      warn,
		embedding: newTaxonomyEmbeddingCache(),
	}
}

type taxonomyEmbeddingCache struct {
	mu      sync.Mutex
	vectors map[string][]float64
}

func newTaxonomyEmbeddingCache() *taxonomyEmbeddingCache {
	return &taxonomyEmbeddingCache{vectors: map[string][]float64{}}
}

func (c *taxonomyEmbeddingCache) get(model, document string) ([]float64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	vector, ok := c.vectors[embeddingCacheKey(model, document)]
	return vector, ok
}

func (c *taxonomyEmbeddingCache) put(model, document string, vector []float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.vectors[embeddingCacheKey(model, document)] = vector
}

func embeddingCacheKey(model, document string) string {
	return model + "\x00" + HashText(document)
}

// HashText is the SHA-256 hex text hash used by the cache key and tests.
func HashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// Classify reproduces NewsClassifierService.classify.
func (s *Session) Classify(ctx context.Context, orgID string, cleaned CleanedNews, options Options) (Result, error) {
	settings := s.settings.Get(ctx, orgID)
	if !settings.Enabled {
		// Classifier disabled: keep the legacy hard-coded rule paths, no taxonomy
		// membership check.
		return classifyByRule(cleaned, settings.TaxonomyVersion, nil), nil
	}
	taxonomy := settings.Taxonomy
	taxonomyByPath := make(map[string]TaxonomyNode, len(taxonomy))
	for _, node := range taxonomy {
		taxonomyByPath[node.Path] = node
	}
	if len(taxonomy) == 0 {
		if settings.StrictFail {
			return Result{}, errors.New("News classification taxonomy is empty")
		}
		// Empty taxonomy: keep the legacy hard-coded rule paths.
		return classifyByRule(cleaned, settings.TaxonomyVersion, nil), nil
	}

	metrics := Metrics{
		TaxonomyVersion: settings.TaxonomyVersion,
		LayerSuccess:    LayerSuccess{},
	}
	candidates := newCandidateSet()
	queryText := buildQueryText(cleaned)
	var llmRationale *string

	if settings.EnableLlm {
		startedAt := nowMillis(s.now)
		response, err := s.runLLMLayer(ctx, orgID, settings.LLMModel, queryText, taxonomy, options.JobID)
		latency := nowMillis(s.now) - startedAt
		metrics.LLMLatencyMs = &latency
		if err != nil {
			if settings.StrictFail {
				return Result{}, err
			}
			s.warn("LLM classification layer failed; falling back to remaining layers: %v", err)
		} else {
			metrics.LayerSuccess.LLM = true
			llmRationale = response.Rationale
			for _, candidate := range response.Candidates {
				node, ok := taxonomyByPath[candidate.Path]
				if !ok {
					continue
				}
				entry := candidates.get(node.Path, node.LegacyCategory)
				score := clamp01(candidate.Score)
				entry.llmScore = &score
				if entry.reason == nil && candidate.Reason != nil && *candidate.Reason != "" {
					entry.reason = candidate.Reason
				}
			}
		}
	}

	if settings.EnableEmbedding {
		startedAt := nowMillis(s.now)
		scores, err := s.runEmbeddingLayer(ctx, orgID, queryText, taxonomy, settings.EmbeddingTopK, options.JobID)
		latency := nowMillis(s.now) - startedAt
		metrics.EmbeddingLatencyMs = &latency
		if err != nil {
			if settings.StrictFail {
				return Result{}, err
			}
			s.warn("Embedding classification layer failed; falling back to remaining layers: %v", err)
		} else {
			metrics.LayerSuccess.Embedding = true
			for _, entry := range scores {
				node, ok := taxonomyByPath[entry.Path]
				if !ok {
					continue
				}
				candidate := candidates.get(node.Path, node.LegacyCategory)
				score := entry.Score
				candidate.embeddingScore = &score
			}
		}
	}

	if settings.EnableRerank {
		startedAt := nowMillis(s.now)
		rerankPaths := make([]string, 0, len(candidates.order))
		if len(candidates.order) > 0 {
			rerankPaths = append(rerankPaths, candidates.order...)
		} else {
			// No LLM/embedding candidates (both layers disabled or failed). Rank
			// the actual leaf categories instead of an arbitrary taxonomy prefix,
			// otherwise the reranker can only ever pick the first few declared
			// nodes regardless of the article.
			rerankPaths = taxonomyLeafPaths(taxonomy)
			if len(rerankPaths) > maxRerankDocuments {
				s.warn("Rerank candidate set truncated from %d leaf nodes to the upstream limit of %d", len(rerankPaths), maxRerankDocuments)
				rerankPaths = rerankPaths[:maxRerankDocuments]
			}
		}
		scores, err := s.runRerankLayer(ctx, orgID, queryText, rerankPaths, taxonomyByPath, settings.RerankTopN, options.JobID)
		latency := nowMillis(s.now) - startedAt
		metrics.RerankLatencyMs = &latency
		if err != nil {
			if settings.StrictFail {
				return Result{}, err
			}
			s.warn("Rerank classification layer failed; falling back to remaining layers: %v", err)
		} else {
			metrics.LayerSuccess.Rerank = true
			for _, entry := range scores {
				node, ok := taxonomyByPath[entry.Path]
				if !ok {
					continue
				}
				candidate := candidates.get(node.Path, node.LegacyCategory)
				score := entry.Score
				candidate.rerankScore = &score
			}
		}
	}

	weighted := combineScores(candidates, metrics.LayerSuccess)
	sourceLabel := options.SourceLabel
	if sourceLabel == "" {
		sourceLabel = cleaned.Source
	}
	weightedWithSource, err := s.applySourceCategoryAuthority(ctx, orgID, weighted, sourceContext{
		SourceID: options.SourceID, SourceURL: options.SourceURL, SourceLabel: sourceLabel,
	})
	if err != nil {
		return Result{}, err
	}
	metrics.CandidateCount = len(weightedWithSource)

	if len(weightedWithSource) == 0 || weightedWithSource[0].Score < settings.MinConfidence {
		fallback := classifyByRule(cleaned, settings.TaxonomyVersion, taxonomy)
		fallback.Method = "rule-fallback-empty"
		if len(weightedWithSource) > 0 {
			fallback.Method = "rule-fallback-low-confidence"
		}
		if len(weightedWithSource) > 0 {
			fallback.Candidates = sliceCandidates(weightedWithSource, settings.RerankTopN)
		}
		fallback.Metrics = metrics
		return fallback, nil
	}

	limit := settings.RerankTopN
	if limit < 1 {
		limit = 1
	}
	topCandidates := sliceCandidates(weightedWithSource, limit)
	best := topCandidates[0]
	confidence := clamp01(best.Score)
	reason := best.Reason
	if reason == nil {
		reason = llmRationale
	}
	labels := splitPath(best.Path)
	var categoryPath *string
	if best.Path != "" {
		path := best.Path
		categoryPath = &path
	}
	return Result{
		LegacyCategory: best.LegacyCategory,
		CategoryPath:   categoryPath,
		Labels:         labels,
		Confidence:     &confidence,
		Reason:         reason,
		Method:         resolveMethod(metrics.LayerSuccess),
		Candidates:     topCandidates,
		Metrics:        metrics,
	}, nil
}

// --- LLM layer ---

type llmLayerResult struct {
	Candidates []llmCandidate
	Rationale  *string
}

func (s *Session) runLLMLayer(ctx context.Context, orgID, model, queryText string, taxonomy []TaxonomyNode, jobID string) (llmLayerResult, error) {
	if s.client == nil {
		return llmLayerResult{}, errors.New("news classifier model client is not configured")
	}
	userContent := strings.Join([]string{
		"Classify this news article into the provided taxonomy.",
		"Return 1-5 candidates sorted by confidence.",
		"Do not invent paths that are not in the taxonomy list.",
		"",
		"Article:",
		wrapUntrustedArticle(queryText),
		"",
		"Taxonomy:",
		taxonomyPrompt(taxonomy),
	}, "\n")
	response, err := s.client.Completion(ctx, litellmcompat.CompletionRequest{
		OrgID: orgID,
		Model: model,
		Messages: []litellmcompat.Message{
			{Role: "system", Content: classificationSystemPrompt},
			{Role: "user", Content: userContent},
		},
		Temperature:    floatPtr(0),
		TopP:           floatPtr(1),
		MaxTokens:      intPtr(450),
		ResponseFormat: classificationResponseFormat(),
		Metadata:       litellmcompat.NewsClassifierMetadata{OrgID: orgID, JobID: jobID},
	})
	if err != nil {
		return llmLayerResult{}, err
	}
	text := response.Content
	if text == "" {
		return llmLayerResult{}, errors.New("LLM classification returned empty content")
	}
	parsed, ok := SafeJSONParseFromText(text)
	if !ok {
		return llmLayerResult{}, errors.New("LLM classification did not return valid JSON")
	}
	validated, err := validateLLMClassificationResponse(parsed)
	if err != nil {
		return llmLayerResult{}, err
	}
	return llmLayerResult{Candidates: validated.Candidates, Rationale: validated.Rationale}, nil
}

// --- Embedding layer ---

type pathScore struct {
	Path  string
	Score float64
}

func (s *Session) runEmbeddingLayer(ctx context.Context, orgID, queryText string, taxonomy []TaxonomyNode, topK int, jobID string) ([]pathScore, error) {
	if s.client == nil {
		return nil, errors.New("news classifier model client is not configured")
	}
	documents := make([]string, len(taxonomy))
	for index, node := range taxonomy {
		documents[index] = taxonomyDocument(node)
	}
	configured, err := s.client.RuntimeEmbeddingModel(ctx)
	if err != nil {
		return nil, err
	}
	modelKey := configured.Model
	allCached := len(documents) > 0
	for _, document := range documents {
		vector, ok := s.embedding.get(modelKey, document)
		if !ok || len(vector) == 0 {
			allCached = false
			break
		}
	}
	input := make([]string, 0, len(documents)+1)
	input = append(input, queryText)
	if !allCached {
		input = append(input, documents...)
	}
	response, err := s.client.Embedding(ctx, litellmcompat.EmbeddingRequest{
		OrgID:    orgID,
		Input:    input,
		Metadata: litellmcompat.NewsClassifierMetadata{OrgID: orgID, Layer: "embedding", JobID: jobID},
	})
	if err != nil {
		return nil, err
	}
	vectors := make(map[int][]float64, len(response.Rows))
	for _, row := range response.Rows {
		vectors[row.Index] = row.Embedding
	}
	queryVector := vectors[0]
	if len(queryVector) == 0 {
		return nil, errors.New("Embedding classification missing query vector")
	}
	normalizedQuery := normalizeVector(queryVector)
	if len(normalizedQuery) == 0 {
		return nil, errors.New("Embedding classification query vector is invalid")
	}
	scores := make([]pathScore, 0, len(taxonomy))
	for index, node := range taxonomy {
		var vector []float64
		if allCached {
			vector, _ = s.embedding.get(modelKey, documents[index])
		} else {
			vector = vectors[index+1]
			if len(vector) > 0 {
				s.embedding.put(modelKey, documents[index], vector)
			}
		}
		if len(vector) != len(normalizedQuery) || len(vector) == 0 {
			continue
		}
		normalized := normalizeVector(vector)
		if len(normalized) == 0 {
			continue
		}
		cosine := dot(normalizedQuery, normalized)
		// Use the raw cosine similarity. The previous (cos+1)/2 squashed even
		// unrelated texts (cosine ~0.3-0.5) to 0.65-0.75, which let a candidate
		// seen only by the embedding layer outrank an explicit LLM pick.
		scores = append(scores, pathScore{Path: node.Path, Score: clamp01(cosine)})
	}
	sort.SliceStable(scores, func(i, j int) bool { return scores[i].Score > scores[j].Score })
	limit := topK
	if limit < 1 {
		limit = 1
	}
	if limit > len(scores) {
		limit = len(scores)
	}
	return scores[:limit], nil
}

// --- Rerank layer ---

func (s *Session) runRerankLayer(ctx context.Context, orgID, queryText string, candidatePaths []string, taxonomyByPath map[string]TaxonomyNode, topN int, jobID string) ([]pathScore, error) {
	if s.client == nil {
		return nil, errors.New("news classifier model client is not configured")
	}
	if len(candidatePaths) == 0 {
		return []pathScore{}, nil
	}
	documents := make([]string, 0, len(candidatePaths))
	documentPaths := make([]string, 0, len(candidatePaths))
	for _, path := range candidatePaths {
		node, ok := taxonomyByPath[path]
		if !ok {
			continue
		}
		documents = append(documents, taxonomyDocument(node))
		documentPaths = append(documentPaths, path)
	}
	if len(documents) == 0 {
		return []pathScore{}, nil
	}
	limit := topN
	if limit < 1 {
		limit = 1
	}
	if limit > len(documents) {
		limit = len(documents)
	}
	response, err := s.client.Rerank(ctx, litellmcompat.RerankRequest{
		OrgID:     orgID,
		Query:     queryText,
		Documents: documents,
		TopN:      limit,
		Metadata:  litellmcompat.NewsClassifierMetadata{OrgID: orgID, Layer: "rerank", JobID: jobID},
	})
	if err != nil {
		return nil, err
	}
	if len(response.Results) == 0 {
		return nil, errors.New("Rerank classification returned no usable results")
	}
	// Keep the upstream relevance score; do not min-max it. Min-max forced the
	// best hit to 1.0 even when every candidate was irrelevant, so MinConfidence
	// could never reject it.
	out := make([]pathScore, 0, len(response.Results))
	for _, result := range response.Results {
		if result.Index < 0 || result.Index >= len(documentPaths) {
			continue
		}
		out = append(out, pathScore{Path: documentPaths[result.Index], Score: rerankProbability(result.Score)})
	}
	if len(out) == 0 {
		return nil, errors.New("Rerank classification returned no usable results")
	}
	return out, nil
}

// rerankProbability normalizes one upstream rerank score to [0,1]. Cohere- and
// Jina-style providers already return a relevance probability in [0,1], which is
// used as-is. A value outside [0,1] is treated as a logit and mapped through the
// logistic function so absolute relevance is preserved.
func rerankProbability(score float64) float64 {
	if math.IsNaN(score) {
		return 0
	}
	if score < 0 || score > 1 {
		return clamp01(1 / (1 + math.Exp(-score)))
	}
	return clamp01(score)
}

// --- Candidate/fusion/source authority ---

type candidateScore struct {
	path           string
	legacyCategory string
	llmScore       *float64
	embeddingScore *float64
	rerankScore    *float64
	reason         *string
}

// candidateSet preserves the insertion order of the JS Map (LLM, embedding,
// rerank), which is the rerank candidate order and the fusion iteration order.
type candidateSet struct {
	order  []string
	byPath map[string]*candidateScore
}

func newCandidateSet() *candidateSet {
	return &candidateSet{byPath: map[string]*candidateScore{}}
}

func (c *candidateSet) get(path, legacyCategory string) *candidateScore {
	if existing, ok := c.byPath[path]; ok {
		return existing
	}
	entry := &candidateScore{path: path, legacyCategory: legacyCategory}
	c.byPath[path] = entry
	c.order = append(c.order, path)
	return entry
}

// combineScores fuses the per-layer scores into one weighted score.
//
// The denominator is the sum of the weights of the layers that were enabled and
// succeeded on this run. A layer that was active but did not score a candidate
// contributes a 0 for that candidate (the weight still counts). This stops a
// candidate seen by only one layer from winning merely because its denominator
// is smaller. Layers that were disabled or failed are excluded from the
// denominator.
func combineScores(candidates *candidateSet, success LayerSuccess) []ClassificationCandidate {
	weights := struct {
		llm       float64
		embedding float64
		rerank    float64
	}{}
	if success.LLM {
		weights.llm = 0.5
	}
	if success.Embedding {
		weights.embedding = 0.3
	}
	if success.Rerank {
		weights.rerank = 0.2
	}
	denominator := weights.llm + weights.embedding + weights.rerank
	out := make([]ClassificationCandidate, 0, len(candidates.order))
	for _, path := range candidates.order {
		candidate := candidates.byPath[path]
		score := 0.0
		if candidate.llmScore != nil {
			score += *candidate.llmScore * weights.llm
		}
		if candidate.embeddingScore != nil {
			score += *candidate.embeddingScore * weights.embedding
		}
		if candidate.rerankScore != nil {
			score += *candidate.rerankScore * weights.rerank
		}
		if denominator <= 0 {
			continue
		}
		out = append(out, ClassificationCandidate{
			Path:           candidate.path,
			Score:          clamp01(score / denominator),
			LegacyCategory: candidate.legacyCategory,
			Reason:         candidate.reason,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out
}

type sourceContext struct {
	SourceID    string
	SourceURL   string
	SourceLabel string
}

func (s *Session) applySourceCategoryAuthority(ctx context.Context, orgID string, candidates []ClassificationCandidate, source sourceContext) ([]ClassificationCandidate, error) {
	if len(candidates) == 0 {
		return candidates, nil
	}
	sourceURL := strings.TrimSpace(source.SourceURL)
	sourceLabel := strings.TrimSpace(source.SourceLabel)
	if sourceURL == "" && sourceLabel == "" {
		return candidates, nil
	}
	if s.policies == nil {
		return candidates, nil
	}
	policy, err := s.policies.Get(ctx, orgID)
	if err != nil {
		return nil, err
	}
	rules := policy.CategoryAuthority
	if len(rules) == 0 {
		return candidates, nil
	}
	sourceType := classifySource(sourceLabel, sourceURL, policy)
	hostname := extractHostname(sourceURL)
	adjusted := make([]ClassificationCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		nextScore := candidate.Score
		floor := 0.0
		for _, rule := range rules {
			if !pathStartsWithPrefix(candidate.Path, rule.CategoryPrefix) {
				continue
			}
			switch sourceType {
			case "authoritative":
				nextScore += rule.AuthoritativeBoost
				if rule.MinConfidenceFloor > floor {
					floor = rule.MinConfidenceFloor
				}
			case "blog":
				nextScore += rule.BlogPenalty
				nextScore -= math.Max(0, rule.MismatchPenalty)
			default:
				nextScore += rule.UnknownPenalty
			}
			for _, boost := range rule.DomainBoosts {
				if hostnameMatchesDomain(hostname, boost.Domain) {
					nextScore += boost.Delta
				}
			}
		}
		if sourceType == "authoritative" && floor > 0 && nextScore < floor {
			nextScore = floor
		}
		candidate.Score = clamp01(nextScore)
		adjusted = append(adjusted, candidate)
	}
	sort.SliceStable(adjusted, func(i, j int) bool { return adjusted[i].Score > adjusted[j].Score })
	return adjusted, nil
}

// --- Rule fallback ---

// classifyByRule is the deterministic keyword fallback used when the classifier
// is disabled, the taxonomy is empty, or every model layer is inconclusive.
//
// When taxonomy is non-empty the fallback may only return a rule whose path
// actually exists in that org's taxonomy; a rule that matches the text but whose
// path is absent is treated as no hit. A nil/empty taxonomy preserves the legacy
// hard-coded paths (classifier disabled or no taxonomy configured).
func classifyByRule(cleaned CleanedNews, taxonomyVersion string, taxonomy []TaxonomyNode) Result {
	text := strings.ToLower(buildQueryText(cleaned))
	var taxonomyPaths map[string]struct{}
	if len(taxonomy) > 0 {
		taxonomyPaths = make(map[string]struct{}, len(taxonomy))
		for _, node := range taxonomy {
			taxonomyPaths[node.Path] = struct{}{}
		}
	}
	for _, rule := range ruleDefinitions {
		if !rule.matches(text) {
			continue
		}
		if taxonomyPaths != nil {
			if _, ok := taxonomyPaths[rule.path]; !ok {
				continue
			}
		}
		confidence := 0.35
		reason := "rule-based fallback"
		path := rule.path
		return Result{
			LegacyCategory: rule.legacy,
			CategoryPath:   &path,
			Labels:         splitPath(rule.path),
			Confidence:     &confidence,
			Reason:         &reason,
			Method:         "rule-only",
			Candidates: []ClassificationCandidate{{
				Path: rule.path, Score: 0.35, LegacyCategory: rule.legacy, Reason: &reason,
			}},
			Metrics: Metrics{
				TaxonomyVersion: taxonomyVersion, CandidateCount: 1,
			},
		}
	}
	zero := 0.0
	reason := "no-classification-match"
	return Result{
		LegacyCategory: "",
		CategoryPath:   nil,
		Labels:         []string{},
		Confidence:     &zero,
		Reason:         &reason,
		Method:         "rule-only",
		Candidates:     []ClassificationCandidate{},
		Metrics: Metrics{
			TaxonomyVersion: taxonomyVersion, CandidateCount: 0,
		},
	}
}

func resolveMethod(success LayerSuccess) string {
	parts := make([]string, 0, 3)
	if success.LLM {
		parts = append(parts, "llm")
	}
	if success.Embedding {
		parts = append(parts, "embedding")
	}
	if success.Rerank {
		parts = append(parts, "rerank")
	}
	if len(parts) == 0 {
		return "rule-only"
	}
	return strings.Join(parts, "+")
}

// --- helpers ---

func sliceCandidates(candidates []ClassificationCandidate, limit int) []ClassificationCandidate {
	if limit < 0 {
		limit = 0
	}
	if limit > len(candidates) {
		limit = len(candidates)
	}
	out := make([]ClassificationCandidate, limit)
	copy(out, candidates[:limit])
	return out
}

// taxonomyLeafPaths returns the paths of leaf taxonomy nodes in declaration
// order: a node is a leaf when no other node's path is nested under it. Only
// leaves are real classification targets, so ranking them avoids scoring a
// parent-only path.
func taxonomyLeafPaths(taxonomy []TaxonomyNode) []string {
	leaves := make([]string, 0, len(taxonomy))
	for _, node := range taxonomy {
		isLeaf := true
		prefix := node.Path + "/"
		for _, other := range taxonomy {
			if other.Path != node.Path && strings.HasPrefix(other.Path, prefix) {
				isLeaf = false
				break
			}
		}
		if isLeaf {
			leaves = append(leaves, node.Path)
		}
	}
	return leaves
}

func splitPath(path string) []string {
	parts := strings.Split(path, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func normalizeVector(vector []float64) []float64 {
	magnitude := 0.0
	for _, value := range vector {
		magnitude += value * value
	}
	magnitude = math.Sqrt(magnitude)
	if math.IsNaN(magnitude) || math.IsInf(magnitude, 0) || magnitude <= 0 {
		return nil
	}
	out := make([]float64, len(vector))
	for index, value := range vector {
		out[index] = value / magnitude
	}
	return out
}

func dot(left, right []float64) float64 {
	length := len(left)
	if len(right) < length {
		length = len(right)
	}
	total := 0.0
	for index := 0; index < length; index++ {
		total += left[index] * right[index]
	}
	return total
}

func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func floatPtr(value float64) *float64 { return &value }
func intPtr(value int) *int           { return &value }

package newsclassifier

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

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
		return classifyByRule(cleaned, settings.TaxonomyVersion), nil
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
		return classifyByRule(cleaned, settings.TaxonomyVersion), nil
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
			limit := settings.EmbeddingTopK
			if settings.RerankTopN > limit {
				limit = settings.RerankTopN
			}
			if limit > len(taxonomy) {
				limit = len(taxonomy)
			}
			for _, node := range taxonomy[:limit] {
				rerankPaths = append(rerankPaths, node.Path)
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

	weighted := combineScores(candidates, Settings{
		EnableLlm: settings.EnableLlm, EnableEmbedding: settings.EnableEmbedding, EnableRerank: settings.EnableRerank,
	})
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
		fallback := classifyByRule(cleaned, settings.TaxonomyVersion)
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
		scores = append(scores, pathScore{Path: node.Path, Score: clamp01((cosine + 1) / 2)})
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
	raw := make([]pathScore, 0, len(response.Results))
	minScore := math.Inf(1)
	maxScore := math.Inf(-1)
	for _, result := range response.Results {
		if result.Index < 0 || result.Index >= len(documentPaths) {
			continue
		}
		raw = append(raw, pathScore{Path: documentPaths[result.Index], Score: result.Score})
		if result.Score < minScore {
			minScore = result.Score
		}
		if result.Score > maxScore {
			maxScore = result.Score
		}
	}
	if len(raw) == 0 {
		return nil, errors.New("Rerank classification returned no usable results")
	}
	out := make([]pathScore, 0, len(raw))
	for _, entry := range raw {
		score := 1.0
		if maxScore != minScore {
			score = clamp01((entry.Score - minScore) / (maxScore - minScore))
		}
		out = append(out, pathScore{Path: entry.Path, Score: score})
	}
	return out, nil
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

func combineScores(candidates *candidateSet, settings Settings) []ClassificationCandidate {
	weights := struct {
		llm       float64
		embedding float64
		rerank    float64
	}{}
	if settings.EnableLlm {
		weights.llm = 0.5
	}
	if settings.EnableEmbedding {
		weights.embedding = 0.3
	}
	if settings.EnableRerank {
		weights.rerank = 0.2
	}
	out := make([]ClassificationCandidate, 0, len(candidates.order))
	for _, path := range candidates.order {
		candidate := candidates.byPath[path]
		score := 0.0
		applied := 0.0
		if candidate.llmScore != nil {
			score += *candidate.llmScore * weights.llm
			applied += weights.llm
		}
		if candidate.embeddingScore != nil {
			score += *candidate.embeddingScore * weights.embedding
			applied += weights.embedding
		}
		if candidate.rerankScore != nil {
			score += *candidate.rerankScore * weights.rerank
			applied += weights.rerank
		}
		if applied <= 0 {
			continue
		}
		out = append(out, ClassificationCandidate{
			Path:           candidate.path,
			Score:          clamp01(score / applied),
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

type ruleDefinition struct {
	pattern *regexp.Regexp
	legacy  string
	path    string
}

var ruleDefinitions = []ruleDefinition{
	{pattern: regexp.MustCompile(`\b(openai|anthropic|deepmind|llm|gpt|model release|ai model)\b`), legacy: "ai", path: "tech/ai/model-release"},
	{pattern: regexp.MustCompile(`\b(fed|fomc|inflation|cpi|gdp|bond|yield|stock|equity|nasdaq|dow)\b`), legacy: "finance", path: "finance/macro/monetary-policy"},
	{pattern: regexp.MustCompile(`\b(regulation|regulatory|sec|doj|congress|white house|policy)\b`), legacy: "gov", path: "gov/regulation/enforcement"},
	{pattern: regexp.MustCompile(`\b(cyber|breach|malware|ransomware|defense|military|missile|osint)\b`), legacy: "intel", path: "intel/defense/military-operation"},
	{pattern: regexp.MustCompile(`\b(election|campaign|parliament|geopolitic|sanction|ceasefire|conflict)\b`), legacy: "politics", path: "politics/geopolitics/conflict"},
	{pattern: regexp.MustCompile(`\b(semiconductor|chip|software|hardware|cloud|startup|technology)\b`), legacy: "tech", path: "tech/semiconductor/supply-chain"},
}

func classifyByRule(cleaned CleanedNews, taxonomyVersion string) Result {
	text := strings.ToLower(buildQueryText(cleaned))
	for _, rule := range ruleDefinitions {
		if !rule.pattern.MatchString(text) {
			continue
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

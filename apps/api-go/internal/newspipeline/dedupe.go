package newspipeline

// This file ports NewsPipelineDedupeService: the summary dedupe stage of the
// itemPipeline worker.
//
// The stage runs after classification and before persist. It has three paths:
//
//   - content-duplicate short circuit: a content-cache hit marks the item
//     Duplicate with similarity 1 unless the cached document is this item's own
//     previous run (a replay/retry cache reuse, never a duplicate);
//   - LLM judge path (when the org disabled embeddings): load up to
//     summaryDedupMaxCandidates completed summaries from the same org, pre-rank
//     them with the quick n-gram similarity, compare at most maxComparisons of
//     them through the judge with concurrency 4, stop early on a >= 0.98
//     duplicate and keep the best similarity at or above the threshold;
//   - embedding path (default): embed the summary, query the vector service,
//     validate the hits against Mongo, preserve the vector rank order, and fall
//     back to a local cosine scan when the vector service is disabled,
//     unavailable or returns nothing and fallbackToMongo allows it.
//
// Every ProcessedItem query is scoped to the job orgId, a completed item with no
// duplicate mark and the configured lookback window; this item's own previous
// runs (same itemMetaId) are always excluded so a replay cannot match itself.
//
// Failure semantics follow the TypeScript service: Mongo and embedding-model
// resolution failures propagate and fail the stage, while a failed judge call, a
// failed duplicate mark, a failed embedding call and a failed revert are logged
// and never abort the pipeline.

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// Dedupe defaults shared with the NestJS pipeline-internal constants.
const (
	// dedupeDefaultConcurrency is DEFAULT_LLM_DEDUPE_CONCURRENCY.
	dedupeDefaultConcurrency = 4
	// dedupeDefaultMaxComparisons is MAX_LLM_DEDUPE_COMPARISONS.
	dedupeDefaultMaxComparisons = 12
	// dedupeDefaultCandidateChars is MAX_LLM_DEDUPE_CANDIDATE_CHARS.
	dedupeDefaultCandidateChars = 1_200
	// dedupeEarlyExitSimilarity is LLM_DEDUPE_EARLY_EXIT_SIMILARITY: a judge
	// result at or above it stops the comparison pool.
	dedupeEarlyExitSimilarity = 0.98
	// dedupeHighConfidenceSimilarity is the Mongo cosine scan's early
	// termination bound. The TypeScript comparison is strict (>) here, unlike
	// the judge pool's >=.
	dedupeHighConfidenceSimilarity = 0.98
	// dedupeJudgeMaxTokens is the judge completion max_tokens.
	dedupeJudgeMaxTokens = 256
	// dedupeMaxVectorLimit caps the vector-service limit like the NestJS
	// Math.min(Math.max(maxCandidates, 1), 200).
	dedupeMaxVectorLimit = 200
	// dedupeProcessedItemsCollection is the Mongo ProcessedItem collection.
	dedupeProcessedItemsCollection = "processeditems"
)

// errDedupeMongoNotConfigured reports a Deduper built without a Mongo handle on
// a path that needs ProcessedItem access.
var errDedupeMongoNotConfigured = errors.New("newspipeline: mongo is not configured for dedupe")

// DeduperDeps wires the summary dedupe stage.
type DeduperDeps struct {
	// DB is the MySQL pool used for the ItemMeta duplicate mark.
	DB *sql.DB
	// Mongo is the pipeline database (processeditems).
	Mongo *mongo.Database
	// Models is the LiteLLM surface (embedding + dedupe judge).
	Models Models
	// Vector is the vector-go search port. A nil value means the integration is
	// disabled and the Mongo cosine fallback runs directly.
	Vector vectorclient.Searcher
	// Settings is the org-scoped settings reader.
	Settings *SettingsReader
	// Runtime is the pipeline runtime config.
	Runtime RuntimeConfig
	// Now is an optional clock (tests).
	Now func() time.Time
	// Random is an optional jitter source kept for wiring parity.
	Random func() float64
}

// Deduper executes evaluateSummaryDedupe and the persist-failure revert.
type Deduper struct {
	sql      dedupeSQL
	store    dedupeStore
	models   Models
	vector   vectorclient.Searcher
	settings dedupeSettingsProvider
	runtime  RuntimeConfig
	now      func() time.Time
}

// dedupeSQL is the *sql.DB surface the duplicate marks use. Tests inject a fake
// that records the statements.
type dedupeSQL interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// dedupeSettingsProvider is the org-scoped dedupe settings read. *SettingsReader
// satisfies it; tests inject a fake.
type dedupeSettingsProvider interface {
	Dedupe(ctx context.Context, orgID string) DedupeSettings
}

// dedupeStore is the ProcessedItem access surface the deduper needs. The Mongo
// implementation lives in this file; tests inject a fake so the candidate
// filters, the fallback rules and the ranking can run without a server.
type dedupeStore interface {
	// ProcessedItemExists reports whether the org owns a ProcessedItem with the
	// given _id and itemMetaId (the content-cache self-reference check).
	ProcessedItemExists(ctx context.Context, orgID, itemMetaID, processedItemID string) (bool, error)
	// LLMCandidates returns up to limit completed summaries of the org created
	// at or after cutoff, newest first, excluding excludeItemMetaID.
	LLMCandidates(ctx context.Context, orgID, excludeItemMetaID string, cutoff time.Time, limit int) ([]dedupeLLMCandidate, error)
	// AllowedVectorIDs returns the subset of ids that are still valid dedupe
	// candidates for the org and embedding model.
	AllowedVectorIDs(ctx context.Context, orgID, embeddingModel, excludeItemMetaID string, cutoff time.Time, ids []bson.ObjectID) (map[string]struct{}, error)
	// SemanticCandidates returns up to limit completed ProcessedItems with a
	// summary embedding for the org and model, newest first.
	SemanticCandidates(ctx context.Context, orgID, embeddingModel, excludeItemMetaID string, cutoff time.Time, limit int) ([]dedupeSemanticCandidate, error)
}

// dedupeLLMCandidate is one ProcessedItem projection for the judge path.
type dedupeLLMCandidate struct {
	ID      string
	Summary *string
	Title   *string
}

// dedupeSemanticCandidate is one ProcessedItem projection for the Mongo cosine
// fallback.
type dedupeSemanticCandidate struct {
	ID               string
	SummaryEmbedding []float64
}

// dedupeDuplicate is one found duplicate (id + similarity).
type dedupeDuplicate struct {
	ID         string
	Similarity float64
}

// dedupeLLMScore is one judge verdict.
type dedupeLLMScore struct {
	Similarity  float64
	IsDuplicate bool
}

// dedupePreparedCandidate is one candidate after the quick-similarity ranking
// and the candidate-character truncation.
type dedupePreparedCandidate struct {
	ID    string
	Title *string
	Text  string
}

// dedupeRankedCandidate is one candidate with its quick similarity.
type dedupeRankedCandidate struct {
	ID      string
	Summary *string
	Title   *string
	Quick   float64
}

// dedupeLLMOptions is one findLlmDuplicate call.
type dedupeLLMOptions struct {
	Job                  Job
	OrgID                string
	Summary              string
	Threshold            float64
	Cleaned              CleanedNews
	Instructions         *string
	Model                *string
	Concurrency          int
	MaxComparisons       int
	CandidateChars       int
	PromptVersion        string
	SystemPromptTemplate *string
	UserPromptTemplate   *string
}

// dedupeJudgeOptions is one scoreSummaryDuplicateWithLLM call.
type dedupeJudgeOptions struct {
	Job                  Job
	Threshold            float64
	SummaryA             string
	SummaryB             string
	TitleA               *string
	TitleB               *string
	Language             *string
	Instructions         *string
	Model                *string
	PromptVersion        string
	SystemPromptTemplate *string
	UserPromptTemplate   *string
}

// dedupeEmbeddingData is buildSummaryEmbedding's success value.
type dedupeEmbeddingData struct {
	Embedding []float64
	Model     string
}

// NewDeduper wires the summary dedupe stage.
func NewDeduper(deps DeduperDeps) *Deduper {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	deduper := &Deduper{
		models:  deps.Models,
		vector:  deps.Vector,
		runtime: deps.Runtime,
		now:     now,
	}
	if deps.DB != nil {
		deduper.sql = deps.DB
	}
	if deps.Mongo != nil {
		deduper.store = &mongoDedupeStore{mongo: deps.Mongo}
	}
	if deps.Settings != nil {
		deduper.settings = deps.Settings
	}
	return deduper
}

// EvaluateSummaryDedupe ports evaluateSummaryDedupe. A nil error always means
// the stage completed; the caller persists the returned embedding/duplicate
// fields.
func (d *Deduper) EvaluateSummaryDedupe(ctx context.Context, input DedupeInput) (DedupeResult, error) {
	if d == nil {
		return DedupeResult{}, nil
	}
	cfg := d.runtime

	// The content cache may legitimately hit this item's own previous run
	// (replay/retry clones the same content under a new rawItemId). In that case
	// the cached processed item belongs to the same itemMetaId, so it is a cache
	// reuse, not a duplicate.
	if ref := input.ContentDuplicateOf; ref != nil && *ref != "" {
		isSelf, err := d.isSelfProcessedItemRef(ctx, input.Job, *ref)
		if err != nil {
			return DedupeResult{}, err
		}
		if isSelf {
			return DedupeResult{}, nil
		}
		d.markItemMetaDuplicate(ctx, input.Job, *ref, 1)
		return DedupeResult{
			DuplicateOf:         stringPointer(*ref),
			DuplicateSimilarity: floatPointer(1),
		}, nil
	}

	if !cfg.SummaryDedupEnabled {
		return DedupeResult{}, nil
	}

	summary := ""
	if input.Cleaned.Summary != nil {
		summary = dedupeTrimSpace(*input.Cleaned.Summary)
	}
	if summary == "" || dedupeUTF16Length(summary) < cfg.SummaryDedupMinChars {
		return DedupeResult{}, nil
	}

	settings := d.settingsFor(ctx, input.Job.OrgID)
	sourceID := input.Job.SourceID
	if sourceID == nil {
		sourceID = extractSourceId(input.Payload)
	}
	language := input.Cleaned.Language
	if language == nil {
		language = input.Payload.Language
	}
	baseThreshold, _ := ResolveDedupeBaseThreshold(settings, sourceID, language, input.Cleaned.CategoryPath)
	threshold := resolveSummaryDedupThreshold(dedupeUTF16Length(summary), baseThreshold)
	baseResult := DedupeResult{ThresholdUsed: floatPointer(threshold)}

	if !settings.UseEmbeddings {
		duplicate, err := d.findLlmDuplicate(ctx, dedupeLLMOptions{
			Job:                  input.Job,
			OrgID:                input.Job.OrgID,
			Summary:              summary,
			Threshold:            threshold,
			Cleaned:              input.Cleaned,
			Instructions:         settings.LLMJudgeInstructions,
			Model:                settings.LLMJudgeModel,
			Concurrency:          settings.LLMJudgeConcurrency,
			MaxComparisons:       settings.LLMJudgeMaxComparisons,
			CandidateChars:       settings.LLMJudgeCandidateChars,
			PromptVersion:        settings.LLMJudgePromptVersion,
			SystemPromptTemplate: dedupeOptionalTemplate(settings.LLMJudgeSystemPrompt),
			UserPromptTemplate:   dedupeOptionalTemplate(settings.LLMJudgeUserPrompt),
		})
		if err != nil {
			return DedupeResult{}, err
		}
		if duplicate == nil {
			return baseResult, nil
		}
		d.markItemMetaDuplicate(ctx, input.Job, duplicate.ID, duplicate.Similarity)
		baseResult.DuplicateOf = stringPointer(duplicate.ID)
		baseResult.DuplicateSimilarity = floatPointer(duplicate.Similarity)
		return baseResult, nil
	}

	embeddingData, err := d.buildSummaryEmbedding(ctx, summary, input.Job)
	if err != nil {
		return DedupeResult{}, err
	}
	if embeddingData == nil {
		return baseResult, nil
	}
	embeddingBaseResult := baseResult
	embeddingBaseResult.SummaryEmbedding = embeddingData.Embedding
	embeddingBaseResult.SummaryEmbeddingModel = stringPointer(embeddingData.Model)

	duplicate, err := d.findSemanticDuplicate(
		ctx,
		input.Job.OrgID,
		embeddingData.Embedding,
		embeddingData.Model,
		threshold,
		input.Job.ItemMetaID,
	)
	if err != nil {
		return DedupeResult{}, err
	}
	if duplicate == nil {
		return embeddingBaseResult, nil
	}
	d.markItemMetaDuplicate(ctx, input.Job, duplicate.ID, duplicate.Similarity)
	embeddingBaseResult.DuplicateOf = stringPointer(duplicate.ID)
	embeddingBaseResult.DuplicateSimilarity = floatPointer(duplicate.Similarity)
	return embeddingBaseResult, nil
}

// settingsFor reads the org dedupe settings, falling back to the runtime
// defaults when no reader is wired (tests).
func (d *Deduper) settingsFor(ctx context.Context, orgID string) DedupeSettings {
	if d != nil && d.settings != nil {
		return d.settings.Dedupe(ctx, orgID)
	}
	return DedupeSettings{
		DefaultThreshold:       d.runtime.SummaryDedupThreshold,
		UseEmbeddings:          true,
		LLMJudgeConcurrency:    dedupeDefaultConcurrency,
		LLMJudgeMaxComparisons: dedupeDefaultMaxComparisons,
		LLMJudgeCandidateChars: dedupeDefaultCandidateChars,
		LLMJudgePromptVersion:  DefaultNewsDedupePromptVersion,
	}
}

// findLlmDuplicate ports findLlmDuplicate: candidate load, quick-similarity
// ranking, identity shortcut, then the bounded judge worker pool.
func (d *Deduper) findLlmDuplicate(ctx context.Context, options dedupeLLMOptions) (*dedupeDuplicate, error) {
	cfg := d.runtime
	if d.store == nil {
		return nil, errDedupeMongoNotConfigured
	}

	lookback := time.Duration(cfg.SummaryDedupLookbackHours) * time.Hour
	cutoff := d.now().Add(-lookback)

	maxComparisons := options.MaxComparisons
	if maxComparisons <= 0 {
		maxComparisons = dedupeDefaultMaxComparisons
	}
	concurrency := options.Concurrency
	if concurrency <= 0 {
		concurrency = dedupeDefaultConcurrency
	}
	candidateChars := options.CandidateChars
	if candidateChars <= 0 {
		candidateChars = dedupeDefaultCandidateChars
	}

	candidates, err := d.store.LLMCandidates(ctx, options.OrgID, options.Job.ItemMetaID, cutoff, cfg.SummaryDedupMaxCandidates)
	if err != nil {
		return nil, err
	}

	normalizedQuery := normalizeForQuickSimilarity(options.Summary)
	ranked := make([]dedupeRankedCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.ID == "" || candidate.Summary == nil {
			continue
		}
		quick := 0.0
		if normalizedQuery != "" {
			quick = quickSimilarity(normalizedQuery, normalizeForQuickSimilarity(*candidate.Summary))
		}
		ranked = append(ranked, dedupeRankedCandidate{
			ID:      candidate.ID,
			Summary: candidate.Summary,
			Title:   candidate.Title,
			Quick:   quick,
		})
	}
	// Array.prototype.sort is stable, so equal quick scores keep the Mongo order.
	sort.SliceStable(ranked, func(left, right int) bool {
		return ranked[left].Quick > ranked[right].Quick
	})
	rankLimit := maxComparisons * 3
	if cfg.SummaryDedupMaxCandidates < rankLimit {
		rankLimit = cfg.SummaryDedupMaxCandidates
	}
	if rankLimit < 0 {
		rankLimit = 0
	}
	if rankLimit < len(ranked) {
		ranked = ranked[:rankLimit]
	}

	queryText := dedupeSliceUTF16(options.Summary, candidateChars)
	comparisonCount := maxComparisons
	if comparisonCount > len(ranked) {
		comparisonCount = len(ranked)
	}
	comparisons := make([]dedupePreparedCandidate, 0, comparisonCount)
	for index := 0; index < comparisonCount; index++ {
		candidate := ranked[index]
		comparisons = append(comparisons, dedupePreparedCandidate{
			ID:    candidate.ID,
			Title: candidate.Title,
			Text:  dedupeSliceUTF16(*candidate.Summary, candidateChars),
		})
	}

	// An identical normalized summary is an immediate duplicate, no judge call.
	for _, candidate := range comparisons {
		if normalizeForQuickSimilarity(candidate.Text) == normalizedQuery {
			return &dedupeDuplicate{ID: candidate.ID, Similarity: 1}, nil
		}
	}

	scores := make([]*dedupeLLMScore, len(comparisons))
	var state struct {
		sync.Mutex
		nextIndex  int
		shouldStop bool
	}
	workers := concurrency
	if workers > len(comparisons) {
		workers = len(comparisons)
	}
	var waitGroup sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for {
				state.Lock()
				if state.shouldStop {
					state.Unlock()
					return
				}
				index := state.nextIndex
				state.nextIndex++
				state.Unlock()
				if index >= len(comparisons) {
					return
				}
				candidate := comparisons[index]
				score := d.scoreSummaryDuplicateWithLLM(ctx, dedupeJudgeOptions{
					Job:                  options.Job,
					Threshold:            options.Threshold,
					SummaryA:             queryText,
					SummaryB:             candidate.Text,
					TitleA:               options.Cleaned.Title,
					TitleB:               candidate.Title,
					Language:             options.Cleaned.Language,
					Instructions:         options.Instructions,
					Model:                options.Model,
					PromptVersion:        options.PromptVersion,
					SystemPromptTemplate: options.SystemPromptTemplate,
					UserPromptTemplate:   options.UserPromptTemplate,
				})
				if score == nil {
					continue
				}
				scores[index] = score
				if score.IsDuplicate && score.Similarity >= dedupeEarlyExitSimilarity {
					state.Lock()
					state.shouldStop = true
					state.Unlock()
				}
			}
		}()
	}
	waitGroup.Wait()

	var best *dedupeDuplicate
	for index := 0; index < len(scores); index++ {
		score := scores[index]
		if score == nil || !score.IsDuplicate {
			continue
		}
		candidate := comparisons[index]
		if best == nil || score.Similarity > best.Similarity {
			best = &dedupeDuplicate{ID: candidate.ID, Similarity: score.Similarity}
		}
		if score.Similarity >= dedupeEarlyExitSimilarity {
			break
		}
	}
	if best != nil && best.Similarity >= options.Threshold {
		return best, nil
	}
	return nil, nil
}

// scoreSummaryDuplicateWithLLM ports scoreSummaryDuplicateWithLlm. A failed or
// invalid judge call yields nil (the candidate is skipped), exactly like the
// TypeScript warn-and-continue branches.
func (d *Deduper) scoreSummaryDuplicateWithLLM(ctx context.Context, options dedupeJudgeOptions) *dedupeLLMScore {
	if d.models == nil {
		return nil
	}
	model := ""
	if options.Model != nil {
		model = strings.TrimSpace(*options.Model)
	}
	metadata := litellmcompat.NewNewsPipelineMetadata(options.Job.OrgID, options.Job.JobID)
	metadata = metadata.AddText("stage", "dedupe")
	metadata = metadata.AddNumber("threshold", options.Threshold)
	metadata = metadata.AddText("promptVersion", options.PromptVersion)

	response, err := d.models.Completion(ctx, litellmcompat.CompletionRequest{
		OrgID: options.Job.OrgID,
		Model: model,
		Messages: []litellmcompat.Message{
			{
				Role: "system",
				Content: buildNewsDedupeSystemPrompt(
					options.Language,
					options.Instructions,
					options.SystemPromptTemplate,
				),
			},
			{
				Role: "user",
				Content: buildNewsDedupeUserPrompt(
					DedupeJudgePromptInput{
						Threshold: options.Threshold,
						SummaryA:  options.SummaryA,
						SummaryB:  options.SummaryB,
						TitleA:    options.TitleA,
						TitleB:    options.TitleB,
					},
					options.UserPromptTemplate,
				),
			},
		},
		Temperature:    floatPointer(0),
		TopP:           floatPointer(1),
		MaxTokens:      intPointer(dedupeJudgeMaxTokens),
		ResponseFormat: NewsDedupeResponseFormat,
		Metadata:       metadata,
	})
	if err != nil {
		return nil
	}
	content := response.Content
	if content == "" {
		return nil
	}
	judge, ok := ParseNewsDedupeJudgeResponse(content)
	if !ok {
		return nil
	}
	similarity := math.Min(1, math.Max(0, judge.Similarity))
	isDuplicate := judge.IsDuplicate || similarity >= options.Threshold
	return &dedupeLLMScore{Similarity: similarity, IsDuplicate: isDuplicate}
}

// buildSummaryEmbedding ports buildSummaryEmbedding. A missing embedding model
// or a failed embedding call yields nil (semantic dedupe is skipped); a failed
// model resolution propagates, exactly like the TypeScript getEmbeddingModel
// call that sits outside the try block.
func (d *Deduper) buildSummaryEmbedding(ctx context.Context, summary string, job Job) (*dedupeEmbeddingData, error) {
	if d.models == nil {
		return nil, errors.New("newspipeline: model client is not configured")
	}
	runtimeModel, err := d.models.RuntimeEmbeddingModel(ctx)
	if err != nil {
		return nil, err
	}
	model := strings.TrimSpace(runtimeModel.Model)
	if !runtimeModel.Configured || model == "" {
		log.Printf("newspipeline: summary embedding model not configured; skipping semantic dedupe (job %s)", job.JobID)
		return nil, nil
	}
	metadata := litellmcompat.NewNewsPipelineMetadata(job.OrgID, job.JobID)
	metadata = metadata.AddText("stage", "dedupe")
	response, err := d.models.Embedding(ctx, litellmcompat.EmbeddingRequest{
		OrgID:    job.OrgID,
		Model:    model,
		Input:    []string{summary},
		Metadata: metadata,
	})
	if err != nil {
		log.Printf("newspipeline: failed to generate summary embedding (job %s): %v", job.JobID, err)
		return nil, nil
	}
	var embedding []float64
	if len(response.Rows) > 0 {
		embedding = response.Rows[0].Embedding
	}
	if len(embedding) == 0 {
		return nil, nil
	}
	resolvedModel := response.Model
	if resolvedModel == "" {
		resolvedModel = model
	}
	return &dedupeEmbeddingData{Embedding: embedding, Model: resolvedModel}, nil
}

// findSemanticDuplicate ports findSemanticDuplicate. The vector service is
// consulted first; its matches must still be valid candidates in Mongo, and the
// first allowed match in vector rank order wins. When the service is disabled,
// unavailable, returns nothing or every hit was filtered out, the local cosine
// scan runs unless fallbackToMongo is off.
func (d *Deduper) findSemanticDuplicate(
	ctx context.Context,
	orgID string,
	embedding []float64,
	model string,
	threshold float64,
	excludeItemMetaID string,
) (*dedupeDuplicate, error) {
	cfg := d.runtime
	lookback := time.Duration(cfg.SummaryDedupLookbackHours) * time.Hour
	cutoff := d.now().Add(-lookback)

	if d.vector != nil {
		limit := cfg.SummaryDedupMaxCandidates
		if limit < 1 {
			limit = 1
		}
		if limit > dedupeMaxVectorLimit {
			limit = dedupeMaxVectorLimit
		}
		lookbackMs := int64(lookback / time.Millisecond)
		matches, err := d.vector.SearchBestEffort(ctx, vectorclient.SearchRequest{
			OrgID:          orgID,
			EmbeddingModel: model,
			Vector:         embedding,
			Limit:          limit,
			MinScore:       floatPointer(threshold),
			LookbackMS:     &lookbackMs,
		})
		if err == nil {
			if len(matches) == 0 && !d.vectorFallbackToMongo(ctx) {
				return nil, nil
			}
			if len(matches) > 0 {
				objectIDs := make([]bson.ObjectID, 0, len(matches))
				for _, match := range matches {
					if !dedupeObjectIDIsValid(match.ProcessedItemID) {
						continue
					}
					objectID, err := bson.ObjectIDFromHex(match.ProcessedItemID)
					if err != nil {
						continue
					}
					objectIDs = append(objectIDs, objectID)
				}
				if len(objectIDs) > 0 {
					if d.store == nil {
						return nil, errDedupeMongoNotConfigured
					}
					allowed, err := d.store.AllowedVectorIDs(ctx, orgID, model, excludeItemMetaID, cutoff, objectIDs)
					if err != nil {
						return nil, err
					}
					// Preserve the vector service's rank order, not the Mongo
					// _id order.
					for _, match := range matches {
						if _, ok := allowed[match.ProcessedItemID]; ok {
							return &dedupeDuplicate{ID: match.ProcessedItemID, Similarity: match.Score}, nil
						}
					}
				}
			}
		} else if !d.vectorFallbackToMongo(ctx) {
			return nil, nil
		}
	}

	if d.store == nil {
		return nil, errDedupeMongoNotConfigured
	}
	candidates, err := d.store.SemanticCandidates(ctx, orgID, model, excludeItemMetaID, cutoff, cfg.SummaryDedupMaxCandidates)
	if err != nil {
		return nil, err
	}

	// NP-PERF-003: pre-normalize the query embedding so the dot product equals
	// the cosine similarity.
	normalizedEmbedding := normalizeVector(embedding)
	var best *dedupeDuplicate
	for _, candidate := range candidates {
		vector := candidate.SummaryEmbedding
		if len(vector) != len(embedding) {
			continue
		}
		similarity := cosineSimilarity(normalizedEmbedding, vector)
		if math.IsNaN(similarity) || math.IsInf(similarity, 0) {
			continue
		}
		if similarity < threshold {
			continue
		}
		if best == nil || similarity > best.Similarity {
			if candidate.ID == "" {
				continue
			}
			best = &dedupeDuplicate{ID: candidate.ID, Similarity: similarity}
			// NP-PERF-003: early termination for high-confidence matches.
			if similarity > dedupeHighConfidenceSimilarity {
				break
			}
		}
	}
	return best, nil
}

// isSelfProcessedItemRef reports whether the content-cache reference is this
// item's own previous ProcessedItem.
func (d *Deduper) isSelfProcessedItemRef(ctx context.Context, job Job, ref string) (bool, error) {
	if !dedupeObjectIDIsValid(ref) {
		return false, nil
	}
	if d.store == nil {
		return false, errDedupeMongoNotConfigured
	}
	return d.store.ProcessedItemExists(ctx, job.OrgID, job.ItemMetaID, ref)
}

// vectorFallbackToMongo reports the effective fallbackToMongo flag. The concrete
// vectorclient search client exposes it; a port without that method keeps the
// VECTOR_SERVICE_FALLBACK_TO_MONGO default (true).
func (d *Deduper) vectorFallbackToMongo(ctx context.Context) bool {
	if d != nil && d.vector != nil {
		if source, ok := d.vector.(interface {
			FallbackToMongoEnabled(context.Context) bool
		}); ok {
			return source.FallbackToMongoEnabled(ctx)
		}
	}
	return true
}

// markItemMetaDuplicate ports markItemMetaDuplicate: a best-effort
// ItemMeta.status Duplicate mark. Failures are logged and swallowed, exactly
// like the TypeScript warn branch.
func (d *Deduper) markItemMetaDuplicate(ctx context.Context, job Job, duplicateOf string, similarity float64) {
	if d == nil || d.sql == nil {
		return
	}
	_, err := d.sql.ExecContext(ctx,
		"UPDATE `ItemMeta` SET `status` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?",
		itemsreading.ItemStatusDuplicate, d.now(), job.ItemMetaID, job.OrgID)
	if err != nil {
		log.Printf("newspipeline: failed to mark item meta as duplicate (itemMetaId %s, duplicateOf %s, similarity %v): %v",
			job.ItemMetaID, duplicateOf, similarity, err)
	}
}

// RevertDuplicateMarkOnPersistFailure ports
// revertDuplicateMarkOnPersistFailure: when persist fails after the dedupe stage
// already marked the item Duplicate, put it back to Pending. Like the TypeScript
// service the call never fails the pipeline: a database error is logged and
// swallowed, so the original persist error is the one the queue classifies.
func (d *Deduper) RevertDuplicateMarkOnPersistFailure(ctx context.Context, job Job, duplicateOf *string) error {
	if duplicateOf == nil || *duplicateOf == "" {
		return nil
	}
	if d == nil || d.sql == nil {
		return nil
	}
	_, err := d.sql.ExecContext(ctx,
		"UPDATE `ItemMeta` SET `status` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `status` = ?",
		itemsreading.ItemStatusPending, d.now(), job.ItemMetaID, job.OrgID, itemsreading.ItemStatusDuplicate)
	if err != nil {
		log.Printf("newspipeline: failed to revert Duplicate mark after persist failure (itemMetaId %s, duplicateOf %s): %v",
			job.ItemMetaID, *duplicateOf, err)
	}
	return nil
}

// resolveSummaryDedupThreshold ports resolveSummaryDedupThreshold: shorter
// summaries need a stricter threshold and very long ones get a small discount.
func resolveSummaryDedupThreshold(summaryLength int, baseThreshold float64) float64 {
	if summaryLength < 80 {
		return math.Min(0.96, baseThreshold+0.04)
	}
	if summaryLength < 120 {
		return math.Min(0.94, baseThreshold+0.02)
	}
	if summaryLength > 280 {
		return math.Max(0.86, baseThreshold-0.03)
	}
	if summaryLength > 200 {
		return math.Max(0.88, baseThreshold-0.02)
	}
	return baseThreshold
}

// dedupeOptionalTemplate turns an empty settings template into nil so the
// news-config prompt builder applies its default template.
func dedupeOptionalTemplate(template string) *string {
	trimmed := dedupeTrimSpace(template)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeForQuickSimilarity ports normalizeForQuickSimilarity: lowercase and
// strip punctuation, symbols and whitespace.
func normalizeForQuickSimilarity(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	for _, value := range text {
		if unicode.IsPunct(value) || unicode.IsSymbol(value) || dedupeIsJSWhitespace(value) {
			continue
		}
		builder.WriteRune(unicode.ToLower(value))
	}
	return dedupeTrimSpace(builder.String())
}

// quickSimilarity ports quickSimilarity: the Jaccard index of the 2- or
// 3-grams of two normalized summaries.
func quickSimilarity(left, right string) float64 {
	if left == "" || right == "" {
		return 0
	}
	if left == right {
		return 1
	}
	ngramSize := 2
	if dedupeUTF16Length(left) >= 64 && dedupeUTF16Length(right) >= 64 {
		ngramSize = 3
	}
	leftGrams := toNgrams(left, ngramSize)
	rightGrams := toNgrams(right, ngramSize)
	if len(leftGrams) == 0 || len(rightGrams) == 0 {
		return 0
	}
	intersection := 0
	for gram := range leftGrams {
		if _, ok := rightGrams[gram]; ok {
			intersection++
		}
	}
	union := len(leftGrams) + len(rightGrams) - intersection
	if union <= 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

// toNgrams ports toNgrams. For n >= 2 the JavaScript String.prototype.slice
// window is expressed in UTF-16 code units, so a CJK character counts the same
// as it does in TypeScript. (A window that splits a surrogate pair decodes the
// same way Go's utf16.Decode handles a lone surrogate.)
func toNgrams(text string, n int) map[string]struct{} {
	grams := make(map[string]struct{})
	if n <= 1 {
		for _, value := range text {
			grams[string(value)] = struct{}{}
		}
		return grams
	}
	units := utf16.Encode([]rune(text))
	for index := 0; index+n <= len(units); index++ {
		grams[string(utf16.Decode(units[index:index+n]))] = struct{}{}
	}
	return grams
}

// normalizeVector ports normalizeVector: scale a vector to unit length; a zero
// vector is returned unchanged.
func normalizeVector(vector []float64) []float64 {
	sum := 0.0
	for _, value := range vector {
		sum += value * value
	}
	norm := math.Sqrt(sum)
	if norm == 0 {
		return vector
	}
	normalized := make([]float64, len(vector))
	for index, value := range vector {
		normalized[index] = value / norm
	}
	return normalized
}

// cosineSimilarity ports cosineSimilarity: equal non-zero dimensions, finite
// components and non-zero norms are required, every other input returns 0.
func cosineSimilarity(left, right []float64) float64 {
	if len(left) != len(right) || len(left) == 0 {
		return 0
	}
	dot := 0.0
	normLeft := 0.0
	normRight := 0.0
	for index := 0; index < len(left); index++ {
		leftValue := left[index]
		rightValue := right[index]
		if !dedupeIsFiniteNumber(leftValue) || !dedupeIsFiniteNumber(rightValue) {
			return 0
		}
		dot += leftValue * rightValue
		normLeft += leftValue * leftValue
		normRight += rightValue * rightValue
	}
	if normLeft == 0 || normRight == 0 {
		return 0
	}
	return dot / (math.Sqrt(normLeft) * math.Sqrt(normRight))
}

// dedupeIsFiniteNumber reports Number.isFinite.
func dedupeIsFiniteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// dedupeTrimSpace reproduces String.prototype.trim: Unicode whitespace plus the
// BOM, U+2028 and U+2029 (which JavaScript also treats as whitespace).
func dedupeTrimSpace(value string) string {
	return strings.TrimFunc(value, dedupeIsJSWhitespace)
}

// dedupeIsJSWhitespace reports the JavaScript \s set plus String.prototype.trim's
// whitespace definition.
func dedupeIsJSWhitespace(value rune) bool {
	return value == '\uFEFF' || value == '\u2028' || value == '\u2029' || unicode.IsSpace(value)
}

// dedupeUTF16Length returns String.prototype.length: the number of UTF-16 code
// units.
func dedupeUTF16Length(value string) int {
	length := 0
	for _, current := range value {
		if current > 0xFFFF {
			length += 2
			continue
		}
		length++
	}
	return length
}

// dedupeSliceUTF16 ports String.prototype.slice(0, limit) for the prefix case.
// A limit that lands inside a surrogate pair drops that rune instead of
// producing an unpaired surrogate (Go strings are UTF-8 and cannot carry one).
func dedupeSliceUTF16(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := 0
	for index := 0; index < len(value); {
		current, size := utf8.DecodeRuneInString(value[index:])
		width := 1
		if current > 0xFFFF {
			width = 2
		}
		if units+width > limit {
			return value[:index]
		}
		units += width
		index += size
	}
	return value
}

// dedupeObjectIDIsValid ports Types.ObjectId.isValid: a 24 character lowercase
// or uppercase hex string.
func dedupeObjectIDIsValid(value string) bool {
	if len(value) != 24 {
		return false
	}
	for _, current := range value {
		switch {
		case current >= '0' && current <= '9':
		case current >= 'a' && current <= 'f':
		case current >= 'A' && current <= 'F':
		default:
			return false
		}
	}
	return true
}

// --- Mongo-backed store ---

// mongoDedupeStore is the production dedupeStore.
type mongoDedupeStore struct {
	mongo *mongo.Database
}

// Compile-time assertion that the Mongo store satisfies the dedupe surface.
var _ dedupeStore = (*mongoDedupeStore)(nil)

// dedupeLLMCandidateDocument is one projection of the judge candidate query.
type dedupeLLMCandidateDocument struct {
	ID     bson.ObjectID `bson:"_id"`
	Result struct {
		Summary bson.RawValue `bson:"summary"`
		Title   bson.RawValue `bson:"title"`
	} `bson:"result"`
}

// dedupeSemanticCandidateDocument is one projection of the cosine-scan query.
type dedupeSemanticCandidateDocument struct {
	ID               bson.ObjectID `bson:"_id"`
	SummaryEmbedding bson.RawValue `bson:"summaryEmbedding"`
}

// ProcessedItemExists implements dedupeStore.
func (s *mongoDedupeStore) ProcessedItemExists(ctx context.Context, orgID, itemMetaID, processedItemID string) (bool, error) {
	if s == nil || s.mongo == nil {
		return false, errDedupeMongoNotConfigured
	}
	objectID, err := bson.ObjectIDFromHex(processedItemID)
	if err != nil {
		return false, nil
	}
	findOptions := options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})
	err = s.mongo.Collection(dedupeProcessedItemsCollection).FindOne(ctx, bson.D{
		{Key: "_id", Value: objectID},
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: itemMetaID},
	}, findOptions).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// LLMCandidates implements dedupeStore.
func (s *mongoDedupeStore) LLMCandidates(ctx context.Context, orgID, excludeItemMetaID string, cutoff time.Time, limit int) ([]dedupeLLMCandidate, error) {
	if s == nil || s.mongo == nil {
		return nil, errDedupeMongoNotConfigured
	}
	findOptions := options.Find().
		SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "result.summary", Value: 1},
			{Key: "result.title", Value: 1},
		}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit))
	cursor, err := s.mongo.Collection(dedupeProcessedItemsCollection).Find(ctx,
		dedupeLLMCandidateFilter(orgID, excludeItemMetaID, cutoff), findOptions)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	candidates := make([]dedupeLLMCandidate, 0, 8)
	for cursor.Next(ctx) {
		var document dedupeLLMCandidateDocument
		if err := cursor.Decode(&document); err != nil {
			return nil, err
		}
		if document.ID.IsZero() {
			continue
		}
		candidates = append(candidates, dedupeLLMCandidate{
			ID:      document.ID.Hex(),
			Summary: dedupeExtractCandidateString(document.Result.Summary),
			Title:   dedupeExtractCandidateString(document.Result.Title),
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

// AllowedVectorIDs implements dedupeStore.
func (s *mongoDedupeStore) AllowedVectorIDs(ctx context.Context, orgID, embeddingModel, excludeItemMetaID string, cutoff time.Time, ids []bson.ObjectID) (map[string]struct{}, error) {
	if s == nil || s.mongo == nil {
		return nil, errDedupeMongoNotConfigured
	}
	findOptions := options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}})
	cursor, err := s.mongo.Collection(dedupeProcessedItemsCollection).Find(ctx,
		dedupeVectorAllowedFilter(orgID, embeddingModel, excludeItemMetaID, cutoff, ids), findOptions)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	allowed := make(map[string]struct{}, len(ids))
	for cursor.Next(ctx) {
		var document struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cursor.Decode(&document); err != nil {
			return nil, err
		}
		if document.ID.IsZero() {
			continue
		}
		allowed[document.ID.Hex()] = struct{}{}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return allowed, nil
}

// SemanticCandidates implements dedupeStore.
func (s *mongoDedupeStore) SemanticCandidates(ctx context.Context, orgID, embeddingModel, excludeItemMetaID string, cutoff time.Time, limit int) ([]dedupeSemanticCandidate, error) {
	if s == nil || s.mongo == nil {
		return nil, errDedupeMongoNotConfigured
	}
	findOptions := options.Find().
		SetProjection(bson.D{{Key: "summaryEmbedding", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit))
	cursor, err := s.mongo.Collection(dedupeProcessedItemsCollection).Find(ctx,
		dedupeSemanticCandidateFilter(orgID, embeddingModel, excludeItemMetaID, cutoff), findOptions)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	candidates := make([]dedupeSemanticCandidate, 0, 8)
	for cursor.Next(ctx) {
		var document dedupeSemanticCandidateDocument
		if err := cursor.Decode(&document); err != nil {
			return nil, err
		}
		if document.ID.IsZero() {
			continue
		}
		candidates = append(candidates, dedupeSemanticCandidate{
			ID:               document.ID.Hex(),
			SummaryEmbedding: dedupeExtractEmbedding(document.SummaryEmbedding),
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

// dedupeLLMCandidateFilter is the findLlmDuplicate ProcessedItem filter, scoped
// to one organization, completed items with a summary, not already a duplicate,
// not this item's own previous run and inside the lookback window.
func dedupeLLMCandidateFilter(orgID, excludeItemMetaID string, cutoff time.Time) bson.D {
	return bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "duplicateOf", Value: nil},
		{Key: "itemMetaId", Value: bson.D{{Key: "$ne", Value: excludeItemMetaID}}},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: cutoff}}},
		{Key: "result.summary", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}},
	}
}

// dedupeVectorAllowedFilter is the findSemanticDuplicate Mongo validation
// filter for vector-service hits.
func dedupeVectorAllowedFilter(orgID, embeddingModel, excludeItemMetaID string, cutoff time.Time, ids []bson.ObjectID) bson.D {
	filter := bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "summaryEmbeddingModel", Value: embeddingModel},
		{Key: "duplicateOf", Value: nil},
	}
	if excludeItemMetaID != "" {
		filter = append(filter, bson.E{Key: "itemMetaId", Value: bson.D{{Key: "$ne", Value: excludeItemMetaID}}})
	}
	filter = append(filter, bson.E{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: cutoff}}})
	return filter
}

// dedupeSemanticCandidateFilter is the local cosine scan filter.
func dedupeSemanticCandidateFilter(orgID, embeddingModel, excludeItemMetaID string, cutoff time.Time) bson.D {
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "summaryEmbeddingModel", Value: embeddingModel},
		{Key: "summaryEmbedding", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: bson.A{}}}},
		{Key: "duplicateOf", Value: nil},
	}
	if excludeItemMetaID != "" {
		filter = append(filter, bson.E{Key: "itemMetaId", Value: bson.D{{Key: "$ne", Value: excludeItemMetaID}}})
	}
	filter = append(filter, bson.E{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: cutoff}}})
	return filter
}

// dedupeExtractCandidateString ports extractCandidateSummary/extractCandidateTitle:
// only a string member is used, trimmed and non-empty.
func dedupeExtractCandidateString(raw bson.RawValue) *string {
	if raw.IsZero() || raw.Type != bson.TypeString {
		return nil
	}
	var value string
	if err := raw.Unmarshal(&value); err != nil {
		return nil
	}
	trimmed := dedupeTrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// dedupeExtractEmbedding decodes one stored summary embedding; a non-array or
// malformed member is treated as absent and the candidate is skipped by the
// dimension check.
func dedupeExtractEmbedding(raw bson.RawValue) []float64 {
	if raw.IsZero() {
		return nil
	}
	var vector []float64
	if err := raw.Unmarshal(&vector); err != nil {
		return nil
	}
	return vector
}

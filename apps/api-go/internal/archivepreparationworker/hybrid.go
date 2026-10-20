package archivepreparationworker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
)

const (
	classificationTaxonomyVersion = "archive-vertical-v2"
	classificationPipelineVersion = "archive-hybrid-v2"
	classificationTextVersion     = "archive-text-v2"
	persistBatchSize              = 100
)

var classificationWeights = struct {
	Rule      float64
	Embedding float64
	Rerank    float64
}{Rule: 0.4, Embedding: 0.3, Rerank: 0.3}

// ClassificationError is the typed archive classification failure.
type ClassificationError struct {
	Code    string
	Layer   string
	Message string
}

func (e *ClassificationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func classificationErrorf(code, layer, message string) *ClassificationError {
	return &ClassificationError{Code: code, Layer: layer, Message: message}
}

func layerFailure(code, layer string, cause error) *ClassificationError {
	message := "Archive classification " + layer + " layer failed."
	if cause != nil && cause.Error() != "" {
		message = cause.Error()
	}
	return &ClassificationError{Code: code, Layer: layer, Message: message}
}

// scoreDocument is the stored five-vertical JSON object.
type scoreDocument struct {
	EastSea         float64 `json:"EAST_SEA"`
	SouthSea        float64 `json:"SOUTH_SEA"`
	WestFront       float64 `json:"WEST_FRONT"`
	ForeignAffairs  float64 `json:"FOREIGN_AFFAIRS"`
	DomesticAffairs float64 `json:"DOMESTIC_AFFAIRS"`
}

func scoreDocumentFromMap(scores map[archivereading.Vertical]float64) scoreDocument {
	return scoreDocument{
		EastSea:         scores[archivereading.VerticalEastSea],
		SouthSea:        scores[archivereading.VerticalSouthSea],
		WestFront:       scores[archivereading.VerticalWestFront],
		ForeignAffairs:  scores[archivereading.VerticalForeignAffairs],
		DomesticAffairs: scores[archivereading.VerticalDomesticAffairs],
	}
}

// scoreMap is a fresh full five-vertical map.
func scoreMap() map[archivereading.Vertical]float64 {
	out := make(map[archivereading.Vertical]float64, len(archivereading.VerticalOrder))
	for _, vertical := range archivereading.VerticalOrder {
		out[vertical] = 0
	}
	return out
}

// ClassificationResult is the ArchiveHybridClassificationResult projection.
type ClassificationResult struct {
	ProcessedArticleID     string
	ArticleID              string
	Region                 archivereading.Region
	Vertical               archivereading.Vertical
	DecisionReason         archivereading.DecisionReason
	CountryCode            *string
	CountryLabel           string
	EntityTags             []string
	RuleScores             map[archivereading.Vertical]float64
	EmbeddingScores        map[archivereading.Vertical]float64
	RerankScores           map[archivereading.Vertical]float64
	FusedScores            map[archivereading.Vertical]float64
	ClassificationTextHash string
	TextVersion            string
	TaxonomyVersion        string
	PipelineVersion        string
	EmbeddingModel         string
	RerankModel            string
}

type preparedClassification struct {
	lookup archivereading.ClassificationLookup
	rule   archivereading.RuleSignals
}

type anchorVector struct {
	AnchorText     string
	AnchorTextHash string
	Vector         []float64
}

// classifyRowsBatch mirrors ArchiveService.classifyRowsBatch: classify, then
// backfill the selected rows' display signals.
func (p *Processor) classifyRowsBatch(ctx context.Context, orgID string, rows []*archivereading.ArchiveRow, session *newsclassifier.Session, display *taskDisplay, runtime settingsView) error {
	if len(rows) == 0 {
		return nil
	}
	prepared := make([]preparedClassification, 0, len(rows))
	for _, row := range rows {
		lookup := classificationLookup(row)
		prepared = append(prepared, preparedClassification{lookup: lookup, rule: lookup.Rule})
	}
	if _, err := p.classifyHybridBatch(ctx, orgID, prepared, runtime); err != nil {
		return err
	}
	return p.backfillMissingProcessedItemDisplaySignals(ctx, orgID, rows, session, display)
}

// classifyHybridBatch reproduces ArchiveClassificationService.classifyHybridBatch.
func (p *Processor) classifyHybridBatch(ctx context.Context, orgID string, inputs []preparedClassification, settings settingsView) ([]ClassificationResult, error) {
	if len(inputs) == 0 {
		return []ClassificationResult{}, nil
	}
	embeddingState, err := p.models.RuntimeEmbeddingModel(ctx)
	if err != nil {
		return nil, err
	}
	if !embeddingState.Configured {
		return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_UNAVAILABLE", "embedding",
			"Archive classification embedding model is not configured.")
	}
	rerankState, err := p.models.RuntimeRerankModel(ctx)
	if err != nil {
		return nil, err
	}
	if !rerankState.Configured {
		return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_RERANK_UNAVAILABLE", "rerank",
			"Archive classification rerank model is not configured.")
	}
	embeddingModel := embeddingState.Model
	rerankModel := rerankState.Model

	cached, err := p.store.LoadCached(ctx, orgID, lookupsOf(inputs), &embeddingModel, &rerankModel)
	if err != nil {
		return nil, err
	}
	resultsByID := make(map[string]ClassificationResult, len(inputs))
	missing := make([]preparedClassification, 0, len(inputs))
	for _, input := range inputs {
		entry, ok := cached[input.lookup.ProcessedArticleID]
		if ok && entry.Fresh {
			resultsByID[input.lookup.ProcessedArticleID] = classificationResultFromCache(entry, input)
			continue
		}
		missing = append(missing, input)
	}

	if len(missing) > 0 {
		anchors, err := p.loadAnchorEmbeddings(ctx, orgID, embeddingModel, missing)
		if err != nil {
			return nil, err
		}
		batchSize := settings.JobBatchSize
		if batchSize < 1 {
			batchSize = 1
		}
		for start := 0; start < len(missing); start += batchSize {
			end := start + batchSize
			if end > len(missing) {
				end = len(missing)
			}
			slice := missing[start:end]
			embeddingScores, err := p.computeEmbeddingScores(ctx, orgID, slice, embeddingModel, anchors, settings)
			if err != nil {
				return nil, err
			}
			rerankScores, err := p.computeRerankScores(ctx, orgID, slice, rerankModel, settings)
			if err != nil {
				return nil, err
			}
			computed := make([]ClassificationResult, 0, len(slice))
			for _, input := range slice {
				embedding := embeddingScores[input.lookup.ProcessedArticleID]
				if embedding == nil {
					embedding = scoreMap()
				}
				rerank := rerankScores[input.lookup.ProcessedArticleID]
				if rerank == nil {
					rerank = scoreMap()
				}
				fused := combineArchiveScores(input.rule.RuleScores, embedding, rerank)
				vertical, reason := archivereading.SelectOutcome(fused, input.rule.RuleScores, embedding, rerank, input.rule)
				computed = append(computed, ClassificationResult{
					ProcessedArticleID:     input.lookup.ProcessedArticleID,
					ArticleID:              input.lookup.ArticleID,
					Region:                 input.rule.Region,
					Vertical:               vertical,
					DecisionReason:         reason,
					CountryCode:            input.rule.CountryCode,
					CountryLabel:           input.rule.CountryLabel,
					EntityTags:             input.rule.EntityTags,
					RuleScores:             input.rule.RuleScores,
					EmbeddingScores:        embedding,
					RerankScores:           rerank,
					FusedScores:            fused,
					ClassificationTextHash: input.lookup.TextHash,
					TextVersion:            classificationTextVersion,
					TaxonomyVersion:        classificationTaxonomyVersion,
					PipelineVersion:        classificationPipelineVersion,
					EmbeddingModel:         embeddingModel,
					RerankModel:            rerankModel,
				})
			}
			if err := p.persistResults(ctx, orgID, computed); err != nil {
				return nil, err
			}
			for _, result := range computed {
				resultsByID[result.ProcessedArticleID] = result
			}
		}
	}

	out := make([]ClassificationResult, 0, len(inputs))
	for _, input := range inputs {
		result, ok := resultsByID[input.lookup.ProcessedArticleID]
		if !ok {
			return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_FAILED", "",
				"Archive classification result is missing after batch processing.")
		}
		out = append(out, result)
	}
	return out, nil
}

func lookupsOf(inputs []preparedClassification) []archivereading.ClassificationLookup {
	out := make([]archivereading.ClassificationLookup, len(inputs))
	for index, input := range inputs {
		out[index] = input.lookup
	}
	return out
}

func classificationResultFromCache(cached archivereading.CachedClassification, input preparedClassification) ClassificationResult {
	return ClassificationResult{
		ProcessedArticleID:     cached.ProcessedArticleID,
		ArticleID:              input.lookup.ArticleID,
		Region:                 cached.Region,
		Vertical:               cached.Vertical,
		DecisionReason:         cached.DecisionReason,
		CountryCode:            input.rule.CountryCode,
		CountryLabel:           input.rule.CountryLabel,
		EntityTags:             input.rule.EntityTags,
		RuleScores:             cached.RuleScores,
		EmbeddingScores:        cached.EmbeddingScores,
		RerankScores:           cached.RerankScores,
		FusedScores:            cached.FusedScores,
		ClassificationTextHash: cached.ClassificationHash,
		TextVersion:            classificationTextVersion,
		TaxonomyVersion:        cached.TaxonomyVersion,
		PipelineVersion:        cached.PipelineVersion,
		EmbeddingModel:         cached.EmbeddingModel,
		RerankModel:            cached.RerankModel,
	}
}

// loadAnchorEmbeddings reproduces loadAnchorEmbeddings: read stored anchors,
// compute the missing vectors in one call and upsert them.
func (p *Processor) loadAnchorEmbeddings(ctx context.Context, orgID, embeddingModel string, inputs []preparedClassification) (map[archivereading.Vertical][]anchorVector, error) {
	anchors := buildAnchorVariants()
	byKey := make(map[string]archiveAnchor, len(anchors))
	for _, anchor := range anchors {
		byKey[string(anchor.Vertical)+":"+anchor.AnchorTextHash] = anchor
	}
	rows, err := p.db.QueryContext(ctx, `
SELECT vertical, anchorTextHash, embeddingVector
FROM ArchiveVerticalAnchorEmbedding
WHERE taxonomyVersion = ? AND embeddingModel = ? AND vertical IN (?, ?, ?, ?, ?)`,
		classificationTaxonomyVersion, embeddingModel,
		string(archivereading.VerticalEastSea), string(archivereading.VerticalSouthSea),
		string(archivereading.VerticalWestFront), string(archivereading.VerticalForeignAffairs),
		string(archivereading.VerticalDomesticAffairs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	vectors := make(map[archivereading.Vertical][]anchorVector, len(archivereading.VerticalOrder))
	for _, vertical := range archivereading.VerticalOrder {
		vectors[vertical] = []anchorVector{}
	}
	for rows.Next() {
		var verticalRaw, hash string
		var raw []byte
		if err := rows.Scan(&verticalRaw, &hash, &raw); err != nil {
			return nil, err
		}
		vertical, ok := archivereading.ParseVertical(verticalRaw)
		if !ok {
			continue
		}
		anchor, ok := byKey[verticalRaw+":"+hash]
		if !ok {
			continue
		}
		vector := decodeVector(raw)
		if len(vector) == 0 {
			continue
		}
		existing := vectors[vertical]
		duplicate := false
		for _, entry := range existing {
			if entry.AnchorTextHash == hash {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		vectors[vertical] = append(existing, anchorVector{AnchorText: anchor.AnchorText, AnchorTextHash: hash, Vector: vector})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	missing := make([]archiveAnchor, 0, len(anchors))
	for _, anchor := range anchors {
		found := false
		for _, entry := range vectors[anchor.Vertical] {
			if entry.AnchorTextHash == anchor.AnchorTextHash {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, anchor)
		}
	}
	if len(missing) == 0 {
		return vectors, nil
	}

	texts := make([]string, len(missing))
	for index, anchor := range missing {
		texts[index] = anchor.AnchorText
	}
	response, err := p.models.Embedding(ctx, litellmcompat.EmbeddingRequest{
		OrgID: orgID,
		Input: texts,
		Metadata: litellmcompat.ArchiveAnchorMetadata{
			Layer: "embedding-anchor", OrgID: orgID, TaxonomyVersion: classificationTaxonomyVersion,
		},
	})
	if err != nil {
		return nil, layerFailure("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding", err)
	}
	byIndex := make(map[int][]float64, len(response.Rows))
	for _, row := range response.Rows {
		byIndex[row.Index] = row.Embedding
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	for index, anchor := range missing {
		vector := byIndex[index]
		if len(vector) == 0 {
			return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding",
				"Archive anchor embedding response is missing a usable vector.")
		}
		vectors[anchor.Vertical] = append(vectors[anchor.Vertical], anchorVector{
			AnchorText: anchor.AnchorText, AnchorTextHash: anchor.AnchorTextHash, Vector: vector,
		})
		if _, err := p.db.ExecContext(ctx, `
INSERT INTO ArchiveVerticalAnchorEmbedding
  (id, vertical, taxonomyVersion, anchorText, anchorTextHash, embeddingModel, embeddingVector, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row
ON DUPLICATE KEY UPDATE anchorText = new_row.anchorText, embeddingVector = new_row.embeddingVector, updatedAt = new_row.updatedAt`,
			newRowID(), string(anchor.Vertical), classificationTaxonomyVersion, anchor.AnchorText,
			anchor.AnchorTextHash, embeddingModel, encodeVector(vector), now, now); err != nil {
			return nil, layerFailure("ARCHIVE_CLASSIFICATION_PERSIST_FAILED", "embedding", err)
		}
	}
	return vectors, nil
}

func (p *Processor) computeEmbeddingScores(ctx context.Context, orgID string, inputs []preparedClassification, embeddingModel string, anchors map[archivereading.Vertical][]anchorVector, settings settingsView) (map[string]map[archivereading.Vertical]float64, error) {
	normalized := make(map[archivereading.Vertical][][]float64, len(archivereading.VerticalOrder))
	for _, vertical := range archivereading.VerticalOrder {
		entries := anchors[vertical]
		if len(entries) == 0 {
			return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding",
				"Archive anchor embedding is missing for one or more verticals.")
		}
		vectors := make([][]float64, 0, len(entries))
		for _, entry := range entries {
			vector := normalizeVector(entry.Vector)
			if len(vector) == 0 {
				return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding",
					"Archive anchor embedding vector is invalid.")
			}
			vectors = append(vectors, vector)
		}
		normalized[vertical] = vectors
	}

	chunkSize := settings.EmbeddingBatchSize
	if chunkSize < 1 {
		chunkSize = 1
	}
	chunks := make([][]preparedClassification, 0)
	for start := 0; start < len(inputs); start += chunkSize {
		end := start + chunkSize
		if end > len(inputs) {
			end = len(inputs)
		}
		chunks = append(chunks, inputs[start:end])
	}
	results, err := mapWithConcurrency(chunks, settings.EmbeddingMaxConcurrency, func(chunk []preparedClassification) (map[string]map[archivereading.Vertical]float64, error) {
		texts := make([]string, len(chunk))
		ids := make([]string, len(chunk))
		for index, input := range chunk {
			texts[index] = input.lookup.Text
			ids[index] = input.lookup.ProcessedArticleID
		}
		response, err := p.models.Embedding(ctx, litellmcompat.EmbeddingRequest{
			OrgID: orgID,
			Model: embeddingModel,
			Input: texts,
			Metadata: litellmcompat.ArchiveEmbeddingMetadata{
				Layer: "embedding", OrgID: orgID, TaxonomyVersion: classificationTaxonomyVersion, ProcessedArticleIDs: ids,
			},
		})
		if err != nil {
			return nil, layerFailure("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding", err)
		}
		byIndex := make(map[int][]float64, len(response.Rows))
		for _, row := range response.Rows {
			byIndex[row.Index] = row.Embedding
		}
		out := make(map[string]map[archivereading.Vertical]float64, len(chunk))
		for index, input := range chunk {
			vector := byIndex[index]
			if len(vector) == 0 {
				return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding",
					"Archive article embedding response is missing a usable vector.")
			}
			query := normalizeVector(vector)
			if len(query) == 0 {
				return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding",
					"Archive article embedding vector is invalid.")
			}
			scores := scoreMap()
			for _, vertical := range archivereading.VerticalOrder {
				perVertical := normalized[vertical]
				variantScores := make([]float64, 0, len(perVertical))
				for _, anchor := range perVertical {
					if len(anchor) != len(query) {
						return nil, classificationErrorf("ARCHIVE_CLASSIFICATION_EMBEDDING_FAILED", "embedding",
							"Archive embedding vectors use inconsistent dimensions.")
					}
					variantScores = append(variantScores, clamp01((dot(query, anchor)+1)/2))
				}
				scores[vertical] = clamp01(averageTopScores(variantScores))
			}
			out[input.lookup.ProcessedArticleID] = scores
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	merged := make(map[string]map[archivereading.Vertical]float64, len(inputs))
	for _, batch := range results {
		for id, scores := range batch {
			merged[id] = scores
		}
	}
	return merged, nil
}

func (p *Processor) computeRerankScores(ctx context.Context, orgID string, inputs []preparedClassification, rerankModel string, settings settingsView) (map[string]map[archivereading.Vertical]float64, error) {
	anchors := buildAnchorVariants()
	documents := make([]string, len(anchors))
	for index, anchor := range anchors {
		documents[index] = anchor.AnchorText
	}
	results, err := mapWithConcurrency(inputs, settings.RerankMaxConcurrency, func(input preparedClassification) (rerankOutcome, error) {
		response, err := p.models.Rerank(ctx, litellmcompat.RerankRequest{
			OrgID:     orgID,
			Model:     rerankModel,
			Query:     input.lookup.Text,
			Documents: documents,
			TopN:      len(documents),
			Metadata: litellmcompat.ArchiveRerankMetadata{
				Layer: "rerank", OrgID: orgID, TaxonomyVersion: classificationTaxonomyVersion,
				ProcessedArticleID: input.lookup.ProcessedArticleID, ArticleID: input.lookup.ArticleID,
			},
		})
		if err != nil {
			return rerankOutcome{}, layerFailure("ARCHIVE_CLASSIFICATION_RERANK_FAILED", "rerank", err)
		}
		raw := make([]verticalScore, 0, len(response.Results))
		for _, result := range response.Results {
			if result.Index < 0 || result.Index >= len(anchors) {
				continue
			}
			raw = append(raw, verticalScore{vertical: anchors[result.Index].Vertical, score: result.Score})
		}
		if len(raw) == 0 {
			return rerankOutcome{}, classificationErrorf("ARCHIVE_CLASSIFICATION_RERANK_FAILED", "rerank",
				"Archive rerank returned no usable results.")
		}
		grouped := make(map[archivereading.Vertical][]float64, len(archivereading.VerticalOrder))
		for _, vertical := range archivereading.VerticalOrder {
			grouped[vertical] = []float64{}
		}
		for _, entry := range raw {
			grouped[entry.vertical] = append(grouped[entry.vertical], entry.score)
		}
		aggregated := scoreMap()
		for _, vertical := range archivereading.VerticalOrder {
			aggregated[vertical] = averageTopScores(grouped[vertical])
		}
		return rerankOutcome{id: input.lookup.ProcessedArticleID, scores: normalizeVerticalScores(aggregated)}, nil
	})
	if err != nil {
		return nil, err
	}
	out := make(map[string]map[archivereading.Vertical]float64, len(results))
	for _, result := range results {
		out[result.id] = result.scores
	}
	return out, nil
}

type verticalScore struct {
	vertical archivereading.Vertical
	score    float64
}

type rerankOutcome struct {
	id     string
	scores map[archivereading.Vertical]float64
}

func combineArchiveScores(rule, embedding, rerank map[archivereading.Vertical]float64) map[archivereading.Vertical]float64 {
	out := scoreMap()
	for _, vertical := range archivereading.VerticalOrder {
		total := 0.0
		totalWeight := 0.0
		if value, ok := rule[vertical]; ok {
			total += value * classificationWeights.Rule
			totalWeight += classificationWeights.Rule
		}
		if value, ok := embedding[vertical]; ok {
			total += value * classificationWeights.Embedding
			totalWeight += classificationWeights.Embedding
		}
		if value, ok := rerank[vertical]; ok {
			total += value * classificationWeights.Rerank
			totalWeight += classificationWeights.Rerank
		}
		if totalWeight > 0 {
			out[vertical] = clamp01(total / totalWeight)
		}
	}
	return out
}

func (p *Processor) persistResults(ctx context.Context, orgID string, results []ClassificationResult) error {
	if len(results) == 0 {
		return nil
	}
	for start := 0; start < len(results); start += persistBatchSize {
		end := start + persistBatchSize
		if end > len(results) {
			end = len(results)
		}
		if err := p.writeResultsBatch(ctx, orgID, results[start:end]); err != nil {
			return layerFailure("ARCHIVE_CLASSIFICATION_PERSIST_FAILED", "persist", err)
		}
	}
	return nil
}

func (p *Processor) writeResultsBatch(ctx context.Context, orgID string, results []ClassificationResult) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Truncate(time.Millisecond)
	for _, result := range results {
		rule, err := json.Marshal(scoreDocumentFromMap(result.RuleScores))
		if err != nil {
			return err
		}
		embedding, err := json.Marshal(scoreDocumentFromMap(result.EmbeddingScores))
		if err != nil {
			return err
		}
		rerank, err := json.Marshal(scoreDocumentFromMap(result.RerankScores))
		if err != nil {
			return err
		}
		fused, err := json.Marshal(scoreDocumentFromMap(result.FusedScores))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO ArchiveArticleClassification
  (id, orgId, articleId, processedArticleId, region, vertical, ruleScores, embeddingScores, rerankScores, fusedScores,
   classificationTextHash, classificationTextVersion, taxonomyVersion, pipelineVersion, embeddingModel, rerankModel,
   createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row
ON DUPLICATE KEY UPDATE
  articleId = new_row.articleId, region = new_row.region, vertical = new_row.vertical,
  ruleScores = new_row.ruleScores, embeddingScores = new_row.embeddingScores,
  rerankScores = new_row.rerankScores, fusedScores = new_row.fusedScores,
  classificationTextHash = new_row.classificationTextHash,
  classificationTextVersion = new_row.classificationTextVersion,
  taxonomyVersion = new_row.taxonomyVersion, pipelineVersion = new_row.pipelineVersion,
  embeddingModel = new_row.embeddingModel, rerankModel = new_row.rerankModel,
  updatedAt = new_row.updatedAt`,
			newRowID(), orgID, result.ArticleID, result.ProcessedArticleID, string(result.Region), string(result.Vertical),
			rule, embedding, rerank, fused, result.ClassificationTextHash, result.TextVersion,
			result.TaxonomyVersion, result.PipelineVersion, result.EmbeddingModel, result.RerankModel,
			now, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// --- helpers ---

func decodeVector(raw []byte) []float64 {
	if len(raw) == 0 {
		return nil
	}
	var values []float64
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	out := make([]float64, 0, len(values))
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func encodeVector(vector []float64) []byte {
	encoded, _ := json.Marshal(vector)
	return encoded
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
	total := 0.0
	for index := 0; index < len(left); index++ {
		total += left[index] * right[index]
	}
	return total
}

func averageTopScores(scores []float64) float64 {
	if len(scores) == 0 {
		return 0
	}
	finite := make([]float64, 0, len(scores))
	for _, score := range scores {
		if !math.IsNaN(score) && !math.IsInf(score, 0) {
			finite = append(finite, score)
		}
	}
	if len(finite) == 0 {
		return 0
	}
	sort.SliceStable(finite, func(i, j int) bool { return finite[i] > finite[j] })
	take := 2
	if take > len(finite) {
		take = len(finite)
	}
	total := 0.0
	for index := 0; index < take; index++ {
		total += finite[index]
	}
	return clamp01(total / float64(take))
}

// normalizeVerticalScores reproduces the rerank min/max normalization: an equal
// maximum and minimum maps every vertical to 1.
func normalizeVerticalScores(aggregated map[archivereading.Vertical]float64) map[archivereading.Vertical]float64 {
	values := make([]float64, 0, len(archivereading.VerticalOrder))
	for _, vertical := range archivereading.VerticalOrder {
		values = append(values, aggregated[vertical])
	}
	minScore, maxScore := minMax(values)
	normalized := scoreMap()
	for _, vertical := range archivereading.VerticalOrder {
		if maxScore == minScore {
			normalized[vertical] = 1
			continue
		}
		normalized[vertical] = clamp01((aggregated[vertical] - minScore) / (maxScore - minScore))
	}
	return normalized
}

func minMax(values []float64) (float64, float64) {
	if len(values) == 0 {
		return 0, 0
	}
	minimum, maximum := values[0], values[0]
	for _, value := range values[1:] {
		if value < minimum {
			minimum = value
		}
		if value > maximum {
			maximum = value
		}
	}
	return minimum, maximum
}

func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	if value >= 1 {
		return 1
	}
	return value
}

// mapWithConcurrency preserves result order and starts at most concurrency
// mappers, matching ArchiveClassificationService.mapWithConcurrency.
func mapWithConcurrency[TInput any, TResult any](items []TInput, concurrency int, mapper func(TInput) (TResult, error)) ([]TResult, error) {
	if len(items) == 0 {
		return []TResult{}, nil
	}
	results := make([]TResult, len(items))
	safe := concurrency
	if safe < 1 {
		safe = 1
	}
	if safe > len(items) {
		safe = len(items)
	}
	var (
		mu       sync.Mutex
		next     int
		firstErr error
		wg       sync.WaitGroup
	)
	wg.Add(safe)
	for worker := 0; worker < safe; worker++ {
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if firstErr != nil || next >= len(items) {
					mu.Unlock()
					return
				}
				index := next
				next++
				mu.Unlock()
				result, err := mapper(items[index])
				if err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					return
				}
				results[index] = result
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

func hashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func newRowID() string {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "c" + fmt.Sprintf("%024x", time.Now().UnixNano())
	}
	return "c" + hex.EncodeToString(buffer[:])
}

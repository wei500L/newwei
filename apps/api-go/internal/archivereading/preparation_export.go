package archivereading

// This file is the narrow export surface the archive-preparation worker needs
// from the archive reading package. It adds no behaviour: every method below
// delegates to the existing private store, classification or display helpers so
// the read paths and the worker share one implementation of the archive rule,
// cache-freshness and display-signal semantics.

import (
	"context"
	"database/sql"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ClassificationTextInput is the normalized article data the classification
// text hash is built from. It mirrors classificationTextInput exactly.
type ClassificationTextInput struct {
	Title    string
	Summary  string
	Source   string
	Topics   []string
	Entities []Entity
	Location string
	Rule     RuleSignals
}

// BuildClassificationText is the exported buildClassificationText.
func BuildClassificationText(input ClassificationTextInput) string {
	return buildClassificationText(classificationTextInput{
		Title:    input.Title,
		Summary:  input.Summary,
		Source:   input.Source,
		Topics:   input.Topics,
		Entities: input.Entities,
		Location: input.Location,
		Rule:     input.Rule,
	})
}

// HashClassificationText is the exported SHA-256 hex text hash.
func HashClassificationText(text string) string { return hashClassificationText(text) }

// ClassificationLookup is one article's prepared classification text and rule
// context used for the cached-result freshness decision.
type ClassificationLookup struct {
	ProcessedArticleID string
	ArticleID          string
	Text               string
	TextHash           string
	Rule               RuleSignals
}

// CachedClassification is one stored ArchiveArticleClassification row plus the
// freshness diagnostics computed for the current rule context.
type CachedClassification struct {
	ProcessedArticleID string
	ArticleID          string
	Region             Region
	Vertical           Vertical
	DecisionReason     DecisionReason
	RuleScores         map[Vertical]float64
	EmbeddingScores    map[Vertical]float64
	RerankScores       map[Vertical]float64
	FusedScores        map[Vertical]float64
	ClassificationHash string
	TextVersion        string
	TaxonomyVersion    string
	PipelineVersion    string
	EmbeddingModel     string
	RerankModel        string
	CountryLabel       string
	EntityTags         []string
	Fresh              bool
	StaleReasons       []StaleReason
}

func verticalScoreMap(scores scoreVector) map[Vertical]float64 {
	out := make(map[Vertical]float64, len(VerticalOrder))
	for index, vertical := range VerticalOrder {
		out[vertical] = scores[index]
	}
	return out
}

func scoreVectorFromMap(scores map[Vertical]float64) scoreVector {
	var out scoreVector
	for index, vertical := range VerticalOrder {
		if value, ok := scores[vertical]; ok {
			out[index] = value
		}
	}
	return out
}

// PreparationStore is the archive-preparation read surface: the two candidate
// keyset pages, the org-scoped cached classification rows and the ProcessedItem
// display signals.
type PreparationStore struct {
	store          *archiveStore
	classification *classificationStore
	db             *sql.DB
	mongo          *mongo.Database
}

// NewPreparationStore wires the shared query handles. It starts no goroutine and
// owns no connection.
func NewPreparationStore(db *sql.DB, database *mongo.Database) *PreparationStore {
	return &PreparationStore{
		store:          &archiveStore{db: db},
		classification: &classificationStore{db: db},
		db:             db,
		mongo:          database,
	}
}

// RecentBatch reads one digest candidate page ordered by (processedAt, id)
// descending. anchor is the digest day-end; cursor is the scan keyset.
func (s *PreparationStore) RecentBatch(ctx context.Context, orgID string, anchor time.Time, cursor Cursor, take int) ([]*ArchiveRow, error) {
	return s.store.recentBatch(ctx, orgID, anchor, &cursor, take)
}

// RecentFirstBatch reads the first digest candidate page (no keyset cursor).
func (s *PreparationStore) RecentFirstBatch(ctx context.Context, orgID string, anchor time.Time, take int) ([]*ArchiveRow, error) {
	return s.store.recentBatch(ctx, orgID, anchor, nil, take)
}

// RangeBatch reads one calendar candidate page ordered by (processedAt, id)
// descending. A nil cursor starts at the beginning of the range.
func (s *PreparationStore) RangeBatch(ctx context.Context, orgID string, start, end Cursor, cursor *Cursor, take int) ([]*ArchiveRow, error) {
	return s.store.rangeBatch(ctx, orgID, start.ProcessedAt, end.ProcessedAt, cursor, take)
}

// LoadCached reads the org-scoped cache rows and reproduces the freshness
// decision. A nil model pointer keeps the corresponding "model changed" stale
// reason disabled, exactly like the NestJS optional modelSelection.
func (s *PreparationStore) LoadCached(ctx context.Context, orgID string, lookups []ClassificationLookup, embeddingModel, rerankModel *string) (map[string]CachedClassification, error) {
	prepared := make([]classificationLookup, len(lookups))
	for index, lookup := range lookups {
		prepared[index] = classificationLookup{
			ProcessedArticleID: lookup.ProcessedArticleID,
			Text:               lookup.Text,
			TextHash:           lookup.TextHash,
			Rule:               lookup.Rule,
		}
	}
	loaded, err := s.classification.loadCached(ctx, orgID, prepared, modelSelection{
		EmbeddingModel: embeddingModel,
		RerankModel:    rerankModel,
	})
	if err != nil {
		return nil, err
	}
	byID := make(map[string]ClassificationLookup, len(lookups))
	for _, lookup := range lookups {
		byID[lookup.ProcessedArticleID] = lookup
	}
	out := make(map[string]CachedClassification, len(loaded))
	for id, cached := range loaded {
		lookup := byID[id]
		out[id] = CachedClassification{
			ProcessedArticleID: cached.Result.ProcessedArticleID,
			ArticleID:          lookup.ArticleID,
			Region:             cached.Result.Region,
			Vertical:           cached.Result.Vertical,
			DecisionReason:     cached.Result.DecisionReason,
			RuleScores:         verticalScoreMap(cached.Result.RuleScores),
			EmbeddingScores:    verticalScoreMap(cached.Result.EmbeddingScores),
			RerankScores:       verticalScoreMap(cached.Result.RerankScores),
			FusedScores:        verticalScoreMap(cached.Result.FusedScores),
			ClassificationHash: lookup.TextHash,
			TextVersion:        classificationTextVersion,
			TaxonomyVersion:    cached.Result.TaxonomyVersion,
			PipelineVersion:    cached.Result.PipelineVersion,
			EmbeddingModel:     cached.Result.EmbeddingModel,
			RerankModel:        cached.Result.RerankModel,
			CountryLabel:       cached.Result.CountryLabel,
			EntityTags:         cached.Result.EntityTags,
			Fresh:              cached.Fresh,
			StaleReasons:       cached.StaleReasons,
		}
	}
	return out, nil
}

// SelectOutcome is the exported selectVerticalOutcome over named score maps.
func SelectOutcome(fused, rule, embedding, rerank map[Vertical]float64, context RuleSignals) (Vertical, DecisionReason) {
	outcome := selectVerticalOutcome(
		scoreVectorFromMap(fused),
		scoreVectorFromMap(rule),
		scoreVectorFromMap(embedding),
		scoreVectorFromMap(rerank),
		context,
	)
	return outcome.vertical, outcome.reason
}

// RankedVertical is the exported rankedWinner over a named score map.
func RankedVertical(scores map[Vertical]float64) Vertical {
	return rankedWinner(scoreVectorFromMap(scores))
}

// DisplaySignal is the ProcessedItem projection the worker caches per task.
type DisplaySignal struct {
	Exists         bool
	ContentType    string
	CategoryPath   string
	CategoryMethod string
}

// NeedsBackfill reports the exact condition: the document exists but has no
// content type, or neither a category path nor a category method.
func (d DisplaySignal) NeedsBackfill() bool {
	return needsBackfill(displaySignals{
		Exists:         d.Exists,
		ContentType:    displayContentType(d.ContentType),
		CategoryPath:   d.CategoryPath,
		CategoryMethod: d.CategoryMethod,
	})
}

func displayContentType(value string) *contentType {
	if value == "" {
		return nil
	}
	typed := contentType(value)
	return &typed
}

// ExtractDisplaySignalFromBSON converts one stored ProcessedItem.result BSON
// value (or a decoded BSON document) into the exported display-signal view.
// The archive worker loads signals itself because the stored _id can be either
// a string or an ObjectId and a single-form $in would miss one of them.
func ExtractDisplaySignalFromBSON(value any) DisplaySignal {
	signals := extractDisplaySignals(value)
	return DisplaySignal{
		Exists:         signals.Exists,
		ContentType:    displayContentTypeString(signals.ContentType),
		CategoryPath:   signals.CategoryPath,
		CategoryMethod: signals.CategoryMethod,
	}
}

func displayContentTypeString(value *contentType) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

// NormalizeNewsContentTypeValue is the exported normalizeNewsContentType.
func NormalizeNewsContentTypeValue(value string) (string, bool) {
	normalized := normalizeNewsContentType(&value)
	if normalized == nil {
		return "", false
	}
	return string(*normalized), true
}

// InferNewsContentTypeValue is the exported inferNewsContentType.
func InferNewsContentTypeValue(title, summary, source, rawURL string, topics, tags []string) string {
	return string(inferNewsContentType(title, summary, source, rawURL, topics, tags))
}

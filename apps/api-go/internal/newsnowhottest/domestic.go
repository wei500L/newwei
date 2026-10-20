package newsnowhottest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Domestic opinion snapshot persistence (O4). The calculation is the same as
// NewsnowDomesticOpinionIndexService.persistSnapshots; only the candidate rows
// are written with one multi-row upsert instead of one upsert per row. The
// deleteMany and the index snapshot upsert stay in the same transaction.

const (
	maxKeywordsPerCandidate  = 10
	maxKeywordsPerIndex      = 12
	processedItemsCollection = "processeditems"
)

var (
	cjkKeywordPattern   = regexp.MustCompile(`[\x{3400}-\x{9fff}]{2,8}`)
	latinKeywordPattern = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9.+-]{1,30}`)
)

// persistedKeyword is one keyword with its originating dimension.
type persistedKeyword struct {
	Keyword string  `json:"keyword"`
	Weight  float64 `json:"weight"`
	Source  string  `json:"source"`
}

// summaryKeyword is the keywordSummary JSON member.
type summaryKeyword struct {
	Keyword string  `json:"keyword"`
	Weight  float64 `json:"weight"`
}

// persistedCandidate is the fully calculated candidate row.
type persistedCandidate struct {
	CandidateHash       string
	Label               string
	Summary             *string
	Themes              []string
	Keywords            []persistedKeyword
	Entities            []string
	SourceIDs           []string
	DomesticSourceIDs   []string
	SourceCount         int
	ItemCount           int
	HeatScore           float64
	FreshnessScore      float64
	CandidateScore      float64
	AuthorityScore      float64
	DomesticSourceCount int
	DomesticItemCount   int
	DomesticRatio       float64
	IsDomestic          bool
	SentimentPressure   float64
}

// opinionSnapshot is the index snapshot row.
type opinionSnapshot struct {
	IndexValue        float64
	AttentionScore    float64
	BreadthScore      float64
	FreshnessScore    float64
	SentimentPressure float64
	CandidateCount    int
	KeywordSummary    []summaryKeyword
}

type opinionStore struct {
	db    *sql.DB
	mongo *mongo.Database
	now   func() time.Time
}

// NewOpinionStore builds the domestic opinion persistence port. The MySQL pool
// and the Mongo database are both required; the NestJS path reads the sentiment
// labels from the processeditems collection.
func NewOpinionStore(db *sql.DB, database *mongo.Database) OpinionStore {
	return &opinionStore{db: db, mongo: database, now: time.Now}
}

// PersistSnapshots ports NewsnowDomesticOpinionIndexService.persistSnapshots.
func (s *opinionStore) PersistSnapshots(ctx context.Context, input OpinionSnapshotInput) error {
	if s == nil || s.db == nil {
		return errors.New("newsnowhottest: mysql is not configured for the opinion index")
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	bucketStart := toUTCHourStart(input.GeneratedAt)
	uniqueItemIDs := make([]string, 0, len(input.Candidates))
	seenItemIDs := make(map[string]struct{}, len(input.Candidates))
	for _, candidate := range input.Candidates {
		for _, itemID := range candidate.MatchedItemIDs {
			trimmed := jsTrim(itemID)
			if trimmed == "" {
				continue
			}
			if _, exists := seenItemIDs[trimmed]; exists {
				continue
			}
			seenItemIDs[trimmed] = struct{}{}
			uniqueItemIDs = append(uniqueItemIDs, trimmed)
		}
	}
	sentimentLabels, err := s.loadLatestSentimentLabels(ctx, input.OrgID, uniqueItemIDs)
	if err != nil {
		return err
	}
	persisted := make([]persistedCandidate, 0, len(input.Candidates))
	for _, candidate := range input.Candidates {
		persisted = append(persisted, buildPersistedCandidate(candidate, sentimentLabels))
	}
	keywordSummary := summarizeKeywords(persisted)
	indexSnapshot := buildIndexSnapshot(persisted, input.TotalDomesticSourceCount, keywordSummary)
	candidateHashes := make([]string, 0, len(persisted))
	for _, candidate := range persisted {
		candidateHashes = append(candidateHashes, candidate.CandidateHash)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// deleteMany(orgId, bucketStart, candidateHash notIn hashes). With no
	// candidates the NestJS filter omits the notIn member, so the whole bucket
	// is removed.
	if len(candidateHashes) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(candidateHashes)), ",")
		arguments := make([]any, 0, len(candidateHashes)+2)
		arguments = append(arguments, input.OrgID, bucketStart)
		for _, hash := range candidateHashes {
			arguments = append(arguments, hash)
		}
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM NewsnowCandidateSnapshot WHERE orgId = ? AND bucketStart = ? AND candidateHash NOT IN ("+placeholders+")",
			arguments...); err != nil {
			return err
		}
	} else if _, err := tx.ExecContext(ctx,
		"DELETE FROM NewsnowCandidateSnapshot WHERE orgId = ? AND bucketStart = ?",
		input.OrgID, bucketStart); err != nil {
		return err
	}

	if err := s.upsertCandidates(ctx, tx, input.OrgID, bucketStart, now, persisted); err != nil {
		return err
	}
	if err := s.upsertIndexSnapshot(ctx, tx, input.OrgID, bucketStart, now, indexSnapshot); err != nil {
		return err
	}
	return tx.Commit()
}

// upsertCandidates writes the candidate rows in batches with one multi-row
// INSERT ... ON DUPLICATE KEY UPDATE per batch. The unique key is
// (orgId, bucketStart, candidateHash), so the resulting rows are identical to
// the per-row upsert sequence.
func (s *opinionStore) upsertCandidates(
	ctx context.Context,
	tx *sql.Tx,
	orgID string,
	bucketStart time.Time,
	now time.Time,
	candidates []persistedCandidate,
) error {
	const batchSize = 100
	for start := 0; start < len(candidates); start += batchSize {
		end := start + batchSize
		if end > len(candidates) {
			end = len(candidates)
		}
		batch := candidates[start:end]
		var builder strings.Builder
		builder.WriteString("INSERT INTO NewsnowCandidateSnapshot ")
		builder.WriteString("(id, orgId, bucketStart, candidateHash, label, summary, themes, keywords, entities, sourceIds,")
		builder.WriteString(" sourceCount, itemCount, heatScore, freshnessScore, candidateScore, authorityScore,")
		builder.WriteString(" domesticSourceCount, domesticItemCount, domesticRatio, isDomestic, sentimentPressure,")
		builder.WriteString(" createdAt, updatedAt) VALUES ")
		arguments := make([]any, 0, len(batch)*23)
		for index, candidate := range batch {
			if index > 0 {
				builder.WriteByte(',')
			}
			builder.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
			rowID, err := newRowID()
			if err != nil {
				return err
			}
			arguments = append(arguments,
				rowID,
				orgID,
				bucketStart,
				candidate.CandidateHash,
				candidate.Label,
				nullableText(candidate.Summary),
				mustJSON(candidate.Themes),
				mustJSON(candidate.Keywords),
				mustJSON(candidate.Entities),
				mustJSON(candidate.SourceIDs),
				candidate.SourceCount,
				candidate.ItemCount,
				candidate.HeatScore,
				candidate.FreshnessScore,
				candidate.CandidateScore,
				candidate.AuthorityScore,
				candidate.DomesticSourceCount,
				candidate.DomesticItemCount,
				candidate.DomesticRatio,
				candidate.IsDomestic,
				candidate.SentimentPressure,
				now,
				now,
			)
		}
		builder.WriteString(" AS new_row ON DUPLICATE KEY UPDATE")
		builder.WriteString(" label = new_row.label, summary = new_row.summary, themes = new_row.themes,")
		builder.WriteString(" keywords = new_row.keywords, entities = new_row.entities, sourceIds = new_row.sourceIds,")
		builder.WriteString(" sourceCount = new_row.sourceCount, itemCount = new_row.itemCount,")
		builder.WriteString(" heatScore = new_row.heatScore, freshnessScore = new_row.freshnessScore,")
		builder.WriteString(" candidateScore = new_row.candidateScore, authorityScore = new_row.authorityScore,")
		builder.WriteString(" domesticSourceCount = new_row.domesticSourceCount, domesticItemCount = new_row.domesticItemCount,")
		builder.WriteString(" domesticRatio = new_row.domesticRatio, isDomestic = new_row.isDomestic,")
		builder.WriteString(" sentimentPressure = new_row.sentimentPressure, updatedAt = new_row.updatedAt")
		if _, err := tx.ExecContext(ctx, builder.String(), arguments...); err != nil {
			return err
		}
	}
	return nil
}

// upsertIndexSnapshot writes the one index row of the bucket.
func (s *opinionStore) upsertIndexSnapshot(
	ctx context.Context,
	tx *sql.Tx,
	orgID string,
	bucketStart time.Time,
	now time.Time,
	snapshot opinionSnapshot,
) error {
	rowID, err := newRowID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		"INSERT INTO NewsnowDomesticOpinionIndexSnapshot "+
			"(id, orgId, bucketStart, indexValue, attentionScore, breadthScore, freshnessScore,"+
			" sentimentPressure, candidateCount, keywordSummary, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?,?) AS new_row "+
			"ON DUPLICATE KEY UPDATE indexValue = new_row.indexValue,"+
			" attentionScore = new_row.attentionScore, breadthScore = new_row.breadthScore,"+
			" freshnessScore = new_row.freshnessScore, sentimentPressure = new_row.sentimentPressure,"+
			" candidateCount = new_row.candidateCount, keywordSummary = new_row.keywordSummary,"+
			" updatedAt = new_row.updatedAt",
		rowID, orgID, bucketStart, snapshot.IndexValue, snapshot.AttentionScore, snapshot.BreadthScore,
		snapshot.FreshnessScore, snapshot.SentimentPressure, snapshot.CandidateCount,
		mustJSON(snapshot.KeywordSummary), now, now)
	return err
}

// loadLatestSentimentLabels ports loadLatestSentimentLabels: one aggregation over
// the completed ProcessedItem rows of the organization, keeping the newest
// sentiment label per itemMetaId.
func (s *opinionStore) loadLatestSentimentLabels(ctx context.Context, orgID string, itemMetaIDs []string) (map[string]string, error) {
	labels := make(map[string]string, len(itemMetaIDs))
	if len(itemMetaIDs) == 0 || s.mongo == nil {
		return labels, nil
	}
	pipeline := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: itemMetaIDs}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{
			{Key: "itemMetaId", Value: 1},
			{Key: "createdAt", Value: -1},
			{Key: "_id", Value: -1},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$itemMetaId"},
			{Key: "itemMetaId", Value: bson.D{{Key: "$first", Value: "$itemMetaId"}}},
			{Key: "sentiment", Value: bson.D{{Key: "$first", Value: "$result.sentiment_label"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "itemMetaId", Value: 1},
			{Key: "sentiment", Value: 1},
		}}},
	}
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	for cursor.Next(ctx) {
		var row struct {
			ItemMetaID *string `bson:"itemMetaId"`
			Sentiment  *string `bson:"sentiment"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if row.ItemMetaID == nil || row.Sentiment == nil {
			continue
		}
		itemMetaID := jsTrim(*row.ItemMetaID)
		sentiment := toLowerCase(jsTrim(*row.Sentiment))
		if itemMetaID == "" || sentiment == "" {
			continue
		}
		labels[itemMetaID] = sentiment
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return labels, nil
}

// buildPersistedCandidate ports buildPersistedCandidate.
func buildPersistedCandidate(candidate CandidatePersistenceInput, sentimentLabels map[string]string) persistedCandidate {
	sourceIDs := sanitizeStringList(candidate.SourceIDs)
	domesticSourceIDs := sanitizeStringList(candidate.DomesticSourceIDs)
	domesticSourceCount := candidate.DomesticSourceCount
	if domesticSourceCount < 0 {
		domesticSourceCount = 0
	}
	limit := len(domesticSourceIDs)
	if limit == 0 {
		limit = candidate.DomesticSourceCount
	}
	if limit >= 0 && domesticSourceCount > limit {
		domesticSourceCount = limit
	}
	domesticRatio := 0.0
	if candidate.SourceCount > 0 {
		domesticRatio = clamp01(float64(domesticSourceCount) / float64(candidate.SourceCount))
	}
	keywords := buildKeywords(candidate, domesticRatio)
	matchedSentiments := make([]string, 0, len(candidate.MatchedItemIDs))
	for _, itemID := range candidate.MatchedItemIDs {
		if label, exists := sentimentLabels[jsTrim(itemID)]; exists && label != "" {
			matchedSentiments = append(matchedSentiments, label)
		}
	}
	negativeCount := 0
	for _, label := range matchedSentiments {
		if label == "negative" {
			negativeCount++
		}
	}
	sentimentPressure := 0.0
	if len(matchedSentiments) > 0 {
		sentimentPressure = clamp01(float64(negativeCount) / float64(len(matchedSentiments)))
	}
	return persistedCandidate{
		CandidateHash:       candidate.CandidateHash,
		Label:               candidate.Label,
		Summary:             candidate.Summary,
		Themes:              sanitizeStringList(candidate.Themes),
		Keywords:            keywords,
		Entities:            sanitizeStringList(candidate.Entities),
		SourceIDs:           sourceIDs,
		DomesticSourceIDs:   domesticSourceIDs,
		SourceCount:         candidate.SourceCount,
		ItemCount:           candidate.ItemCount,
		HeatScore:           roundN(candidate.HeatScore, 4),
		FreshnessScore:      roundN(candidate.FreshnessScore, 4),
		CandidateScore:      roundN(candidate.CandidateScore, 4),
		AuthorityScore:      roundN(candidate.AuthorityScore, 4),
		DomesticSourceCount: domesticSourceCount,
		DomesticItemCount:   candidate.DomesticItemCount,
		DomesticRatio:       domesticRatio,
		IsDomestic:          domesticSourceCount > 0,
		SentimentPressure:   sentimentPressure,
	}
}

// buildKeywords ports buildKeywords.
func buildKeywords(candidate CandidatePersistenceInput, domesticRatio float64) []persistedKeyword {
	order := make([]string, 0, 8)
	byKey := make(map[string]persistedKeyword, 8)
	push := func(rawValue, source string, baseWeight float64) {
		keyword := normalizeKeywordDisplay(rawValue)
		if keyword == "" {
			return
		}
		key := normalizeKeywordKey(keyword)
		candidateWeight := baseWeight *
			clamp01(candidate.CandidateScore) *
			math.Log1p(math.Max(1, float64(candidate.SourceCount))) *
			domesticRatio
		if candidateWeight <= 0 {
			return
		}
		nextWeight := roundN(candidateWeight, 4)
		current, exists := byKey[key]
		if !exists {
			order = append(order, key)
			byKey[key] = persistedKeyword{Keyword: keyword, Weight: nextWeight, Source: source}
			return
		}
		if nextWeight > current.Weight {
			current.Keyword = keyword
			current.Weight = nextWeight
			current.Source = source
			byKey[key] = current
		}
	}
	for _, topic := range candidate.Topics {
		push(topic, "topic", 1)
	}
	for _, entity := range candidate.Entities {
		push(entity, "entity", 0.8)
	}
	if len(order) == 0 {
		for _, keyword := range extractTitleFallbackKeywords(candidate.RepresentativeTitle) {
			push(keyword, "title", 0.45)
		}
	}
	keywords := make([]persistedKeyword, 0, len(order))
	for _, key := range order {
		keywords = append(keywords, byKey[key])
	}
	sort.SliceStable(keywords, func(left, right int) bool {
		if keywords[left].Weight != keywords[right].Weight {
			return keywords[left].Weight > keywords[right].Weight
		}
		return localeCompare(keywords[left].Keyword, keywords[right].Keyword) < 0
	})
	return firstN(keywords, maxKeywordsPerCandidate)
}

// summarizeKeywords ports summarizeKeywords: only domestic candidates
// contribute, and a repeated normalized keyword accumulates its weight.
func summarizeKeywords(candidates []persistedCandidate) []summaryKeyword {
	order := make([]string, 0, 16)
	byKey := make(map[string]summaryKeyword, 16)
	for _, candidate := range candidates {
		if !candidate.IsDomestic {
			continue
		}
		for _, keyword := range candidate.Keywords {
			key := normalizeKeywordKey(keyword.Keyword)
			current, exists := byKey[key]
			if exists {
				current.Weight = roundN(current.Weight+keyword.Weight, 4)
				byKey[key] = current
				continue
			}
			order = append(order, key)
			byKey[key] = summaryKeyword{Keyword: keyword.Keyword, Weight: keyword.Weight}
		}
	}
	summary := make([]summaryKeyword, 0, len(order))
	for _, key := range order {
		summary = append(summary, byKey[key])
	}
	sort.SliceStable(summary, func(left, right int) bool {
		if summary[left].Weight != summary[right].Weight {
			return summary[left].Weight > summary[right].Weight
		}
		return localeCompare(summary[left].Keyword, summary[right].Keyword) < 0
	})
	return firstN(summary, maxKeywordsPerIndex)
}

// buildIndexSnapshot ports buildIndexSnapshot.
func buildIndexSnapshot(candidates []persistedCandidate, totalDomesticSourceCount int, keywordSummary []summaryKeyword) opinionSnapshot {
	domesticCandidates := make([]persistedCandidate, 0, len(candidates))
	uniqueDomesticSourceIDs := make(map[string]struct{}, 16)
	for _, candidate := range candidates {
		if !candidate.IsDomestic {
			continue
		}
		domesticCandidates = append(domesticCandidates, candidate)
		for _, sourceID := range candidate.DomesticSourceIDs {
			uniqueDomesticSourceIDs[sourceID] = struct{}{}
		}
	}
	totalDomesticSources := totalDomesticSourceCount
	if totalDomesticSources < 0 {
		totalDomesticSources = 0
	}
	weightedAverage := func(resolve func(persistedCandidate) float64) float64 {
		totalWeight := 0
		totalValue := 0.0
		for _, candidate := range domesticCandidates {
			weight := candidate.DomesticSourceCount
			if weight < 1 {
				weight = 1
			}
			totalWeight += weight
			totalValue += resolve(candidate) * float64(weight)
		}
		if totalWeight <= 0 {
			return 0
		}
		return clamp01(totalValue / float64(totalWeight))
	}
	attentionScore := weightedAverage(func(candidate persistedCandidate) float64 {
		return clamp01((candidate.CandidateScore*0.6 + candidate.HeatScore*0.4) * candidate.DomesticRatio)
	})
	breadthScore := 0.0
	if totalDomesticSources > 0 {
		breadthScore = clamp01(float64(len(uniqueDomesticSourceIDs)) / float64(totalDomesticSources))
	}
	freshnessScore := weightedAverage(func(candidate persistedCandidate) float64 {
		return clamp01(candidate.FreshnessScore * candidate.DomesticRatio)
	})
	sentimentPressure := weightedAverage(func(candidate persistedCandidate) float64 {
		return candidate.SentimentPressure
	})
	indexValue := clamp01(attentionScore*0.5 + breadthScore*0.2 + freshnessScore*0.2 + sentimentPressure*0.1)
	return opinionSnapshot{
		IndexValue:        roundN(indexValue, 4),
		AttentionScore:    roundN(attentionScore, 4),
		BreadthScore:      roundN(breadthScore, 4),
		FreshnessScore:    roundN(freshnessScore, 4),
		SentimentPressure: roundN(sentimentPressure, 4),
		CandidateCount:    len(domesticCandidates),
		KeywordSummary:    keywordSummary,
	}
}

// extractTitleFallbackKeywords ports extractTitleFallbackKeywords.
func extractTitleFallbackKeywords(title string) []string {
	normalized := normalizeKeywordDisplay(title)
	if normalized == "" {
		return []string{}
	}
	results := make([]string, 0, maxKeywordsPerCandidate)
	seen := make(map[string]struct{}, maxKeywordsPerCandidate)
	for _, match := range cjkKeywordPattern.FindAllString(normalized, -1) {
		keyword := normalizeKeywordDisplay(match)
		key := normalizeKeywordKey(keyword)
		if keyword == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		results = append(results, keyword)
		if len(results) >= maxKeywordsPerCandidate {
			return results
		}
	}
	for _, match := range latinKeywordPattern.FindAllString(normalized, -1) {
		keyword := normalizeKeywordDisplay(match)
		key := normalizeKeywordKey(keyword)
		if keyword == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		results = append(results, keyword)
		if len(results) >= maxKeywordsPerCandidate {
			break
		}
	}
	return results
}

// normalizeKeywordDisplay collapses whitespace and trims.
func normalizeKeywordDisplay(value string) string {
	return jsTrim(whitespaceRunPattern.ReplaceAllString(value, " "))
}

// normalizeKeywordKey is the lowercased lookup key.
func normalizeKeywordKey(value string) string {
	return toLowerCase(normalizeKeywordDisplay(value))
}

// sanitizeStringList ports sanitizeStringList.
func sanitizeStringList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if normalized := normalizeKeywordDisplay(value); normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

// toUTCHourStart truncates an instant to the UTC hour.
func toUTCHourStart(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), utc.Hour(), 0, 0, 0, time.UTC)
}

// mustJSON marshals a JSON column. An encoding failure yields null, matching the
// nullable Prisma Json column.
func mustJSON(value any) []byte {
	encoded, err := marshalJSON(value)
	if err != nil {
		return []byte("null")
	}
	return encoded
}

// nullableText converts an optional string pointer to a database value.
func nullableText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// newRowID writes a Prisma cuid-shaped primary key. The column has no database
// default, so a client-side id is required on every insert.
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

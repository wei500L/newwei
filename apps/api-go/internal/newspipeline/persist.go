package newspipeline

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"go.mongodb.org/mongo-driver/v2/bson"
	"golang.org/x/net/idna"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// This file ports persistProcessedResult and the create side of
// NewsPipelineOutboxService.upsertArticleAndProcessed:
//
//	build the processed_item outbox payload JSON
//	-> one MySQL transaction:
//	     upsert Article (org-scoped contentHash first, then the (orgId,url)
//	     unique-key race fallback)
//	     link Article.sourceId / PipelineJob.articleId+crawlRunId
//	     upsert ProcessedArticle by articleId + rewrite its term-hourly buckets
//	     insert the MongoOutbox pending processed_item row
//	-> commit, then immediate delivery (outbox.go) and the snapshot refresh.
//
// Column values and order follow news-pipeline-outbox.service.ts. The Article
// upsert is implemented here (not in dedupe.go) because the persist transaction
// is the news-core owner; the dedupe service only marks/reverts the Duplicate
// ItemMeta status.
//
// The URL canonicalisation below is the news-sources scheduler's proven port of
// packages/utils/src/url-canonical.ts and crawl/url-fingerprint.ts, copied with
// pipeline* names so the crawled Article row stores the same url/urlFingerprint
// metadata the NestJS worker stored.

// pipelineStore is the persist transaction surface. The production
// implementation is pipelineMySQLStore; tests substitute a fake.
type pipelineStore interface {
	persist(ctx context.Context, input pipelineStoreInput) (PersistResult, error)
}

// pipelineStoreInput is one persist transaction input.
type pipelineStoreInput struct {
	Job                  Job
	Raw                  RawItem
	Payload              NormalizedPayload
	Article              CrawledArticle
	Cleaned              CleanedNews
	LLM                  LLMMetadata
	ContentHash          string
	ProcessedArticleID   *string
	ArticleMetadataPatch json.RawMessage
	ProcessedItemID      string
	OutboxPayload        []byte
}

// pipelineMySQLStore is the database/sql implementation. Every statement that
// can touch a tenant carries orgId.
type pipelineMySQLStore struct {
	db  *sql.DB
	now func() time.Time
}

// pipelinePersistOptions is persistProcessedResult's input.
type pipelinePersistOptions struct {
	Job                   Job
	Raw                   RawItem
	Payload               NormalizedPayload
	Article               CrawledArticle
	Cleaned               CleanedNews
	LLM                   LLMMetadata
	ContentHash           string
	ProcessedArticleID    *string
	ArticleMetadataPatch  json.RawMessage
	SummaryEmbedding      []float64
	SummaryEmbeddingModel *string
	DuplicateOf           *string
	DuplicateSimilarity   *float64
}

// persistProcessedResult is persistProcessedResult.
func (s *Service) persistProcessedResult(ctx context.Context, options pipelinePersistOptions) (PersistResult, error) {
	processedItemID := pipelineResolveProcessedItemID(options.Job.ProcessedItemID)
	cleaned := options.Cleaned
	if cleaned.PublishedAt == nil {
		cleaned.PublishedAt = pipelineISOString(parseDate(options.Article.PublishedAt))
	}

	payload := buildProcessedItemOutboxPayload(processedItemOutboxInput{
		ProcessedItemID:       processedItemID,
		Raw:                   options.Raw,
		OrgID:                 options.Job.OrgID,
		SourceID:              pipelineFirstNonNilString(options.Job.SourceID, extractSourceId(options.Payload)),
		Payload:               options.Payload,
		Cleaned:               cleaned,
		LLM:                   options.LLM,
		SummaryEmbedding:      options.SummaryEmbedding,
		SummaryEmbeddingModel: options.SummaryEmbeddingModel,
		DuplicateOf:           options.DuplicateOf,
		DuplicateSimilarity:   options.DuplicateSimilarity,
	})
	encoded, err := json.Marshal(payload)
	if err != nil {
		return PersistResult{}, err
	}

	result, err := s.store.persist(ctx, pipelineStoreInput{
		Job:                  options.Job,
		Raw:                  options.Raw,
		Payload:              options.Payload,
		Article:              options.Article,
		Cleaned:              cleaned,
		LLM:                  options.LLM,
		ContentHash:          options.ContentHash,
		ProcessedArticleID:   options.ProcessedArticleID,
		ArticleMetadataPatch: options.ArticleMetadataPatch,
		ProcessedItemID:      processedItemID,
		OutboxPayload:        encoded,
	})
	if err != nil {
		return PersistResult{}, err
	}
	result.ProcessedItemID = processedItemID
	result.Document = pipelinePendingProcessedItemDocument(processedItemID)

	// createOutboxEntry emits the delivery event and triggers the snapshot
	// refresh only after the transaction committed.
	s.dispatchOutboxDelivery(result.OutboxID)
	s.dispatchSnapshotRefresh(options.Job.OrgID, options.Job.SourceID)
	return result, nil
}

// pipelineResolveProcessedItemID is the processedItemId resolution:
// a valid ObjectId is kept, anything else (e.g. a cuid) is replaced by a new
// ObjectId hex string.
func pipelineResolveProcessedItemID(value string) string {
	if pipelineObjectIDIsValid(value) {
		return value
	}
	return bson.NewObjectID().Hex()
}

// pipelineObjectIDIsValid is Types.ObjectId.isValid for the string form: exactly
// 24 hex characters.
func pipelineObjectIDIsValid(value string) bool {
	if len(value) != 24 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// persist is the single MySQL transaction of the pipeline persist stage.
func (s *pipelineMySQLStore) persist(ctx context.Context, input pipelineStoreInput) (PersistResult, error) {
	now := s.now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PersistResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	resolvedSourceID, err := pipelineResolveSourceIDForOrg(ctx, tx, input.Job, input.Payload)
	if err != nil {
		return PersistResult{}, err
	}
	resolvedPipelineJobID := pipelineNonEmptyString(input.Job.PipelineJobID)

	if input.ProcessedArticleID == nil || *input.ProcessedArticleID == "" {
		if err := pipelineUpsertArticleAndProcessed(ctx, tx, input, resolvedSourceID, resolvedPipelineJobID, now); err != nil {
			return PersistResult{}, err
		}
	} else if resolvedPipelineJobID != nil || resolvedSourceID != nil {
		var articleID string
		err := tx.QueryRowContext(ctx,
			"SELECT `articleId` FROM `ProcessedArticle` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
			*input.ProcessedArticleID, input.Job.OrgID).Scan(&articleID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			// Nothing to link.
		case err != nil:
			return PersistResult{}, err
		case articleID != "":
			if err := pipelineLinkArticleAndPipelineJob(ctx, tx, input, articleID, resolvedSourceID, resolvedPipelineJobID, now); err != nil {
				return PersistResult{}, err
			}
		}
	}

	outboxID := pipelineNewRowID()
	query, args := buildMongoOutboxInsertQuery(outboxID, input.Job.OrgID, input.OutboxPayload, now)
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return PersistResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return PersistResult{}, err
	}
	return PersistResult{ProcessedItemID: input.ProcessedItemID, OutboxID: outboxID}, nil
}

// pipelineResolveSourceIDForOrg mirrors createOutboxEntry's source resolution: a
// job-level sourceId wins, otherwise the payload metadata sourceId is accepted
// only when it names a NewsSource of the same organization.
func pipelineResolveSourceIDForOrg(ctx context.Context, tx *sql.Tx, job Job, payload NormalizedPayload) (*string, error) {
	if job.SourceID != nil {
		return job.SourceID, nil
	}
	payloadSourceID := extractSourceId(payload)
	if payloadSourceID == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*payloadSourceID)
	if trimmed == "" {
		return nil, nil
	}
	var existingOrgID string
	err := tx.QueryRowContext(ctx, "SELECT `orgId` FROM `NewsSource` WHERE `id` = ? LIMIT 1", trimmed).Scan(&existingOrgID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if existingOrgID != job.OrgID {
		return nil, nil
	}
	return &trimmed, nil
}

// pipelineLinkArticleAndPipelineJob is the processedArticleId branch of
// createOutboxEntry: it only links the existing article/job.
func pipelineLinkArticleAndPipelineJob(ctx context.Context, tx *sql.Tx, input pipelineStoreInput, articleID string, resolvedSourceID, resolvedPipelineJobID *string, now time.Time) error {
	if resolvedPipelineJobID != nil {
		if _, err := tx.ExecContext(ctx,
			"UPDATE `PipelineJob` SET `articleId` = ?, `crawlRunId` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?",
			articleID, pipelineNullableString(input.Article.RunID), now.UTC().Truncate(time.Millisecond), *resolvedPipelineJobID, input.Job.OrgID,
		); err != nil {
			return err
		}
	}
	if resolvedSourceID != nil {
		if _, err := tx.ExecContext(ctx,
			"UPDATE `Article` SET `sourceId` = ?, `updatedAt` = ? WHERE `id` = ? AND `sourceId` IS NULL AND `orgId` = ?",
			*resolvedSourceID, now.UTC().Truncate(time.Millisecond), articleID, input.Job.OrgID,
		); err != nil {
			return err
		}
	}
	return nil
}

// pipelineUpsertArticleAndProcessed is upsertArticleAndProcessed.
func pipelineUpsertArticleAndProcessed(ctx context.Context, tx *sql.Tx, input pipelineStoreInput, resolvedSourceID, resolvedPipelineJobID *string, now time.Time) error {
	crawlAt := parseDate(input.Article.PublishedAt)
	if crawlAt == nil {
		crawlAt = parseDate(input.Article.FetchedAt)
	}
	if crawlAt == nil {
		crawlAt = &now
	}

	sourceURL := strings.TrimSpace(input.Article.SourceURL)
	queryParamAllowlist := extractUrlQueryParamAllowlist(input.Payload)
	canonicalURL, fingerprint, hasCanonical := pipelineBuildCanonicalURLFingerprint(sourceURL, queryParamAllowlist)
	persistedURL := toArticleUrl(sourceURL)
	if hasCanonical {
		persistedURL = toArticleUrl(canonicalURL)
	}
	persistedMetadata, err := pipelineBuildArticleMetadata(
		input.Article.Metadata,
		input.ArticleMetadataPatch,
		sourceURL,
		persistedURL,
		canonicalURL,
		fingerprint,
		hasCanonical,
		queryParamAllowlist,
	)
	if err != nil {
		return err
	}

	var fingerprintValue *string
	if hasCanonical {
		fingerprintValue = &fingerprint
	}
	language := pipelineFirstNonNilString(input.Cleaned.Language, input.Payload.Language)

	articleID, err := pipelineUpsertArticle(ctx, tx, input, crawlAt, persistedURL, fingerprintValue, language, persistedMetadata, resolvedSourceID, now)
	if err != nil {
		return err
	}
	if resolvedSourceID != nil {
		if _, err := tx.ExecContext(ctx,
			"UPDATE `Article` SET `sourceId` = ?, `updatedAt` = ? WHERE `id` = ? AND `sourceId` IS NULL AND `orgId` = ?",
			*resolvedSourceID, now.UTC().Truncate(time.Millisecond), articleID, input.Job.OrgID,
		); err != nil {
			return err
		}
	}
	if resolvedPipelineJobID != nil {
		if _, err := tx.ExecContext(ctx,
			"UPDATE `PipelineJob` SET `articleId` = ?, `crawlRunId` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?",
			articleID, pipelineNullableString(input.Article.RunID), now.UTC().Truncate(time.Millisecond), *resolvedPipelineJobID, input.Job.OrgID,
		); err != nil {
			return err
		}
	}

	publishedAt := parseDate(input.Cleaned.PublishedAt)
	if publishedAt == nil {
		publishedAt = parseDate(input.Article.PublishedAt)
	}
	normalizedLocation := pipelineNormalizeProcessedArticleLocation(input.Cleaned.Location)
	processedSource := pipelineFirstNonNilString(input.Cleaned.Source, input.Payload.SourceName)
	eventAt := pipelineResolveProcessedArticleEventAt(publishedAt, crawlAt)

	processedArticleID, err := pipelineUpsertProcessedArticle(ctx, tx, input, articleID, publishedAt, normalizedLocation, processedSource, eventAt, now)
	if err != nil {
		return err
	}
	return pipelineRewriteTermHourlyBuckets(ctx, tx, input, processedArticleID, eventAt, processedSource, now)
}

// pipelineUpsertArticle is the org-scoped Article upsert.
func pipelineUpsertArticle(ctx context.Context, tx *sql.Tx, input pipelineStoreInput, crawlAt *time.Time, persistedURL string, fingerprint *string, language *string, metadata []byte, resolvedSourceID *string, now time.Time) (string, error) {
	titleGuess := input.Cleaned.Title

	var existingID string
	err := tx.QueryRowContext(ctx,
		"SELECT `id` FROM `Article` WHERE `orgId` = ? AND `contentHash` = ? LIMIT 1",
		input.Job.OrgID, input.ContentHash).Scan(&existingID)
	switch {
	case err == nil:
		if err := pipelineUpdateArticle(ctx, tx, existingID, input, persistedURL, fingerprint, language, titleGuess, metadata, crawlAt, now); err != nil {
			return "", err
		}
		return existingID, nil
	case !errors.Is(err, sql.ErrNoRows):
		return "", err
	}

	articleID := pipelineNewRowID()
	query := "INSERT INTO `Article` (`id`,`orgId`,`sourceId`,`url`,`urlFingerprint`,`sourceLabel`,`language`,`titleGuess`,`crawlAt`,`contentHash`,`metadata`,`version`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
	if _, err := tx.ExecContext(ctx, query,
		articleID,
		input.Job.OrgID,
		pipelineNullableString(resolvedSourceID),
		persistedURL,
		pipelineNullableString(fingerprint),
		pipelineNullableString(input.Payload.SourceName),
		pipelineNullableString(language),
		pipelineNullableString(titleGuess),
		crawlAt.UTC().Truncate(time.Millisecond),
		input.ContentHash,
		string(metadata),
		1,
		now.UTC().Truncate(time.Millisecond),
		now.UTC().Truncate(time.Millisecond),
	); err != nil {
		if !pipelineDuplicateKeyError(err) {
			return "", err
		}
		// Concurrent write or the (orgId, url) uniqueness fired (the URL was
		// crawled by this org under a different content hash): resolve to this
		// org's row.
		var racedID string
		raceErr := tx.QueryRowContext(ctx,
			"SELECT `id` FROM `Article` WHERE `orgId` = ? AND (`contentHash` = ? OR `url` = ?) LIMIT 1",
			input.Job.OrgID, input.ContentHash, persistedURL).Scan(&racedID)
		if raceErr != nil {
			return "", err
		}
		if err := pipelineUpdateArticle(ctx, tx, racedID, input, persistedURL, fingerprint, language, titleGuess, metadata, crawlAt, now); err != nil {
			return "", err
		}
		return racedID, nil
	}
	return articleID, nil
}

// pipelineUpdateArticle writes the Article update block. titleGuess is omitted
// when the cleaned title is null, exactly like the Prisma `?? undefined`.
func pipelineUpdateArticle(ctx context.Context, tx *sql.Tx, articleID string, input pipelineStoreInput, persistedURL string, fingerprint *string, language *string, titleGuess *string, metadata []byte, crawlAt *time.Time, now time.Time) error {
	setParts := []string{
		"`url` = ?", "`urlFingerprint` = ?", "`sourceLabel` = ?", "`language` = ?",
	}
	args := []any{
		persistedURL,
		pipelineNullableString(fingerprint),
		pipelineNullableString(input.Payload.SourceName),
		pipelineNullableString(language),
	}
	if titleGuess != nil {
		setParts = append(setParts, "`titleGuess` = ?")
		args = append(args, *titleGuess)
	}
	setParts = append(setParts, "`metadata` = ?", "`crawlAt` = ?", "`updatedAt` = ?")
	args = append(args, string(metadata), crawlAt.UTC().Truncate(time.Millisecond), now.UTC().Truncate(time.Millisecond), articleID, input.Job.OrgID)
	query := "UPDATE `Article` SET " + strings.Join(setParts, ", ") + " WHERE `id` = ? AND `orgId` = ?"
	_, err := tx.ExecContext(ctx, query, args...)
	return err
}

// pipelineUpsertProcessedArticle is the Prisma ProcessedArticle upsert by
// articleId. The insert is ON DUPLICATE KEY UPDATE so it is one statement; the
// row id is read back afterwards (Prisma upsert returns the row id).
func pipelineUpsertProcessedArticle(ctx context.Context, tx *sql.Tx, input pipelineStoreInput, articleID string, publishedAt *time.Time, normalizedLocation, processedSource *string, eventAt time.Time, now time.Time) (string, error) {
	processedArticleID := pipelineNewRowID()
	topics, err := pipelineJSONArray(input.Cleaned.Topics)
	if err != nil {
		return "", err
	}
	keyPoints, err := pipelineJSONArray(input.Cleaned.KeyPoints)
	if err != nil {
		return "", err
	}
	entities, err := pipelineJSONArray(input.Cleaned.Entities)
	if err != nil {
		return "", err
	}
	kgRelations, err := pipelineJSONArray(input.Cleaned.KGRelations)
	if err != nil {
		return "", err
	}
	removedNoiseTypes, err := pipelineJSONArray(input.Cleaned.RemovedNoiseTypes)
	if err != nil {
		return "", err
	}
	hasLocation := normalizedLocation != nil
	llmModel := pipelineFirstNonNilString(input.LLM.Model, input.Cleaned.LLMModel)
	llmPromptVersion := pipelineFirstNonNilString(input.Cleaned.LLMPromptVersion, input.LLM.PromptVersion)
	language := pipelineFirstNonNilString(input.Cleaned.Language, input.Payload.Language)

	columns := []string{
		"`id`", "`orgId`", "`articleId`", "`status`", "`title`", "`subtitle`", "`author`", "`source`",
		"`publishedAt`", "`category`", "`topics`", "`summary`", "`keyPoints`", "`entities`",
		"`kgRelations`", "`cleanedMarkdownRef`", "`removedNoiseTypes`", "`qualityScore`",
		"`llmModel`", "`llmPromptVersion`", "`language`", "`location`", "`promptTokens`",
		"`completionTokens`", "`totalTokens`", "`costUsd`", "`latencyMs`", "`eventAt`",
		"`hasLocation`", "`createdAt`", "`processedAt`", "`updatedAt`",
	}
	args := []any{
		processedArticleID,
		input.Job.OrgID,
		articleID,
		"completed",
		pipelineNullableString(input.Cleaned.Title),
		pipelineNullableString(input.Cleaned.Subtitle),
		pipelineNullableString(input.Cleaned.Author),
		pipelineNullableString(processedSource),
		pipelineNullableTime(publishedAt),
		pipelineNullableString(input.Cleaned.Category),
		string(topics),
		pipelineNullableString(input.Cleaned.Summary),
		string(keyPoints),
		string(entities),
		string(kgRelations),
		input.ProcessedItemID,
		string(removedNoiseTypes),
		pipelineNullableFloat(input.Cleaned.QualityScore),
		pipelineNullableString(llmModel),
		pipelineNullableString(llmPromptVersion),
		pipelineNullableString(language),
		pipelineNullableString(normalizedLocation),
		pipelineNullableInt(input.LLM.PromptTokens),
		pipelineNullableInt(input.LLM.CompletionTokens),
		pipelineNullableInt(input.LLM.TotalTokens),
		pipelineNullableFloat(input.LLM.CostUSD),
		pipelineNullableInt(input.LLM.LatencyMS),
		eventAt.UTC().Truncate(time.Millisecond),
		hasLocation,
		now.UTC().Truncate(time.Millisecond),
		now.UTC().Truncate(time.Millisecond),
		now.UTC().Truncate(time.Millisecond),
	}
	placeholders := make([]string, len(columns))
	for index := range placeholders {
		placeholders[index] = "?"
	}
	updateColumns := []string{
		"`orgId`", "`status`", "`title`", "`subtitle`", "`author`", "`source`", "`publishedAt`",
		"`category`", "`topics`", "`summary`", "`keyPoints`", "`entities`", "`kgRelations`",
		"`cleanedMarkdownRef`", "`removedNoiseTypes`", "`qualityScore`", "`llmModel`",
		"`llmPromptVersion`", "`language`", "`location`", "`promptTokens`", "`completionTokens`",
		"`totalTokens`", "`costUsd`", "`latencyMs`", "`eventAt`", "`hasLocation`", "`updatedAt`",
	}
	assignments := make([]string, 0, len(updateColumns))
	for _, column := range updateColumns {
		assignments = append(assignments, column+" = new_row."+column)
	}
	query := "INSERT INTO `ProcessedArticle` (" + strings.Join(columns, ",") + ") VALUES (" + strings.Join(placeholders, ",") + ") AS new_row ON DUPLICATE KEY UPDATE " + strings.Join(assignments, ",")
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return "", err
	}

	var upsertedID string
	err = tx.QueryRowContext(ctx,
		"SELECT `id` FROM `ProcessedArticle` WHERE `articleId` = ? AND `orgId` = ? LIMIT 1",
		articleID, input.Job.OrgID).Scan(&upsertedID)
	if err != nil {
		return "", err
	}
	return upsertedID, nil
}

// pipelineRewriteTermHourlyBuckets is the deleteMany + createMany pair of
// upsertArticleAndProcessed.
func pipelineRewriteTermHourlyBuckets(ctx context.Context, tx *sql.Tx, input pipelineStoreInput, processedArticleID string, eventAt time.Time, processedSource *string, now time.Time) error {
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM `ProcessedArticleTermHourly` WHERE `processedArticleId` = ?",
		processedArticleID); err != nil {
		return err
	}
	terms := pipelineExtractProcessedArticleTerms(input.Cleaned.Title, input.Cleaned.Summary, input.Cleaned.Topics)
	if len(terms) == 0 {
		return nil
	}
	bucketStart := pipelineAlignUTCHourStart(eventAt)
	source := pipelineNormalizeProcessedArticleSource(processedSource)
	timestamp := now.UTC().Truncate(time.Millisecond)
	columns := "(`id`,`orgId`,`processedArticleId`,`bucketStart`,`term`,`source`,`articleCount`,`createdAt`,`updatedAt`)"
	valueGroups := make([]string, 0, len(terms))
	args := make([]any, 0, len(terms)*9)
	for _, term := range terms {
		valueGroups = append(valueGroups, "(?,?,?,?,?,?,?,?,?)")
		args = append(args, pipelineNewRowID(), input.Job.OrgID, processedArticleID, bucketStart, term, source, 1, timestamp, timestamp)
	}
	query := "INSERT INTO `ProcessedArticleTermHourly` " + columns + " VALUES " + strings.Join(valueGroups, ",")
	_, err := tx.ExecContext(ctx, query, args...)
	return err
}

// pipelineNewRowID builds a Prisma-cuid-shaped identifier (c + 24 hex
// characters), the shape the other Go migrations write for client-generated
// cuid columns.
func pipelineNewRowID() string {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "c00000000000000000000000"
	}
	return "c" + hex.EncodeToString(buffer[:])
}

// pipelineBuildArticleMetadata merges Article.metadata (open JSON leaf) with the
// cleaner's patch and the canonical URL members, in the same order the
// TypeScript object spread applies: article metadata, patch, originalUrl,
// canonicalUrl/urlFingerprint/urlQueryParamAllowlist.
func pipelineBuildArticleMetadata(articleMetadata, patch json.RawMessage, sourceURL, persistedURL, canonicalURL, fingerprint string, hasCanonical bool, allowlist []string) ([]byte, error) {
	metadata := map[string]json.RawMessage{}
	if err := pipelineMergeRawObject(metadata, articleMetadata); err != nil {
		return nil, err
	}
	if err := pipelineMergeRawObject(metadata, patch); err != nil {
		return nil, err
	}
	if sourceURL != "" && sourceURL != persistedURL {
		raw, err := json.Marshal(sourceURL)
		if err != nil {
			return nil, err
		}
		metadata["originalUrl"] = raw
	}
	if hasCanonical {
		canonicalRaw, err := json.Marshal(canonicalURL)
		if err != nil {
			return nil, err
		}
		fingerprintRaw, err := json.Marshal(fingerprint)
		if err != nil {
			return nil, err
		}
		allowlistRaw, err := json.Marshal(allowlist)
		if err != nil {
			return nil, err
		}
		metadata["canonicalUrl"] = canonicalRaw
		metadata["urlFingerprint"] = fingerprintRaw
		metadata["urlQueryParamAllowlist"] = allowlistRaw
	}
	return json.Marshal(metadata)
}

// pipelineMergeRawObject overlays one JSON object onto target. Empty/null input
// is a no-op, matching a spread of null/undefined.
func pipelineMergeRawObject(target map[string]json.RawMessage, raw json.RawMessage) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed[0] != '{' {
		// A spread of null/undefined is a no-op; a non-object leaf cannot be a
		// metadata/patch object, so it is ignored like an empty spread.
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &object); err != nil {
		return err
	}
	for key, value := range object {
		target[key] = value
	}
	return nil
}

// pipelineJSONArray serialises a business array into the JSON column value. A
// nil slice is written as [] (the Prisma `?? []` default).
func pipelineJSONArray[T any](values []T) ([]byte, error) {
	if values == nil {
		values = []T{}
	}
	return json.Marshal(values)
}

// pipelineNullableString maps a *string to a database argument.
func pipelineNullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// pipelineNullableTime maps a *time.Time to a database argument.
func pipelineNullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Truncate(time.Millisecond)
}

// pipelineNullableFloat maps a *float64 to a database argument.
func pipelineNullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

// pipelineNullableInt maps a *float64 token/latency count to the Int column
// value Prisma would send (JavaScript number, MySQL rounds to the nearest int).
func pipelineNullableInt(value *float64) any {
	if value == nil {
		return nil
	}
	return int64(math.Round(*value))
}

// pipelineNonEmptyString returns the value when it is a non-empty string.
func pipelineNonEmptyString(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

// pipelineFirstNonNilString is `left ?? right`.
func pipelineFirstNonNilString(left, right *string) *string {
	if left != nil {
		return left
	}
	return right
}

// pipelineISOString is Date.prototype.toISOString for a parsed date.
func pipelineISOString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format("2006-01-02T15:04:05.000Z")
	return &formatted
}

// pipelineDuplicateKeyError reports MySQL ER_DUP_ENTRY (1062), the P2002
// equivalent.
func pipelineDuplicateKeyError(err error) bool {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	return false
}

// --- canonical URL + fingerprint (packages/utils/src/url-canonical.ts and
// apps/api/src/modules/crawl/url-fingerprint.ts) ---

// pipelineBuildCanonicalURLFingerprint is buildCanonicalUrlFingerprint.
func pipelineBuildCanonicalURLFingerprint(value string, allowlist []string) (canonicalURL string, fingerprint string, ok bool) {
	canonical, ok := pipelineCanonicalizeURLWithQueryAllowlist(value, allowlist)
	if !ok {
		return "", "", false
	}
	return canonical, hashContent(canonical), true
}

// pipelineParseHTTPURL is parseHttpUrl: a missing scheme defaults to https://,
// and only http/https survive.
func pipelineParseHTTPURL(value string) (*url.URL, bool) {
	trimmed := pipelineTrimJS(value)
	if trimmed == "" {
		return nil, false
	}
	withProtocol := trimmed
	lowered := strings.ToLower(trimmed)
	if !strings.HasPrefix(lowered, "http://") && !strings.HasPrefix(lowered, "https://") {
		withProtocol = "https://" + trimmed
	}
	parsed, err := url.Parse(withProtocol)
	if err != nil {
		return nil, false
	}
	// net/url keeps the scheme's original case; URL() lowercases it.
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	// net/url accepts an empty ":port" where WHATWG URL rejects it (e.g. the
	// "ftp://x" input above prefixes to "https://ftp://x").
	if strings.HasSuffix(parsed.Host, ":") || strings.HasPrefix(parsed.Host, ":") {
		return nil, false
	}
	if parsed.Hostname() == "" {
		return nil, false
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	parsed.User = nil
	return parsed, true
}

// pipelineCanonicalizeURLWithQueryAllowlist is
// canonicalizeUrlWithQueryAllowlist.
func pipelineCanonicalizeURLWithQueryAllowlist(value string, allowlistInput []string) (string, bool) {
	parsed, ok := pipelineParseHTTPURL(value)
	if !ok {
		return "", false
	}
	if allowlistInput == nil {
		// undefined/null keeps the default allowlist (explicit [] still strips all).
		allowlistInput = newssources.DefaultURLQueryParamAllowlist
	}
	allowlist := newssources.NormalizeURLQueryParamAllowlist(allowlistInput, newssources.DefaultURLQueryParamAllowlist)
	allowed := make(map[string]bool, len(allowlist))
	for _, key := range allowlist {
		allowed[key] = true
	}

	host := strings.ToLower(parsed.Hostname())
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		host = ascii
	}
	port := parsed.Port()
	if parsed.Scheme == "http" && port == "80" {
		port = ""
	}
	if parsed.Scheme == "https" && port == "443" {
		port = ""
	}

	path := pipelineNormalizeCanonicalPath(parsed.EscapedPath())
	query := pipelineNormalizeCanonicalSearch(parsed.RawQuery, allowed)

	var builder strings.Builder
	builder.WriteString(parsed.Scheme)
	builder.WriteString("://")
	builder.WriteString(host)
	if port != "" {
		builder.WriteString(":")
		builder.WriteString(port)
	}
	builder.WriteString(path)
	if query != "" {
		builder.WriteString("?")
		builder.WriteString(query)
	}
	return builder.String(), true
}

// pipelineNormalizeCanonicalPath collapses repeated slashes and drops the
// trailing slash unless the path is exactly "/".
func pipelineNormalizeCanonicalPath(escapedPath string) string {
	path := escapedPath
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")
	resolved := make([]string, 0, len(segments))
	for index, segment := range segments {
		if segment == "" {
			if index == 0 {
				resolved = append(resolved, "")
			}
			continue
		}
		if segment == "." {
			continue
		}
		if segment == ".." {
			if len(resolved) > 1 {
				resolved = resolved[:len(resolved)-1]
			}
			continue
		}
		resolved = append(resolved, segment)
	}
	if len(resolved) == 0 {
		return "/"
	}
	normalized := strings.Join(resolved, "/")
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	if normalized == "/" {
		return "/"
	}
	return strings.TrimRight(normalized, "/")
}

// pipelineNormalizeCanonicalSearch keeps the allowlisted query pairs and
// re-serialises them with URLSearchParams' form encoding, sorted by key and then
// value with the root collation.
func pipelineNormalizeCanonicalSearch(rawQuery string, allowed map[string]bool) string {
	if len(allowed) == 0 {
		return ""
	}
	type pair struct {
		key   string
		value string
	}
	accepted := make([]pair, 0, 4)
	for _, field := range strings.Split(rawQuery, "&") {
		if field == "" {
			continue
		}
		rawKey := field
		rawValue := ""
		if index := strings.Index(field, "="); index >= 0 {
			rawKey = field[:index]
			rawValue = field[index+1:]
		}
		key := pipelineNormalizeQueryParamKey(pipelineDecodeFormComponent(rawKey))
		if key == "" || !allowed[key] {
			continue
		}
		accepted = append(accepted, pair{key: key, value: pipelineDecodeFormComponent(rawValue)})
	}
	sort.SliceStable(accepted, func(left, right int) bool {
		if accepted[left].key != accepted[right].key {
			return pipelineLocaleCompare(accepted[left].key, accepted[right].key) < 0
		}
		return pipelineLocaleCompare(accepted[left].value, accepted[right].value) < 0
	})
	var builder strings.Builder
	for index, entry := range accepted {
		if index > 0 {
			builder.WriteString("&")
		}
		builder.WriteString(pipelineEncodeFormComponent(entry.key))
		builder.WriteString("=")
		builder.WriteString(pipelineEncodeFormComponent(entry.value))
	}
	return builder.String()
}

// pipelineLocaleCompare is a.localeCompare(b) under the default ICU root
// collation.
func pipelineLocaleCompare(left, right string) int {
	if left == right {
		return 0
	}
	return collate.New(language.Und).CompareString(left, right)
}

// pipelineNormalizeQueryParamKey is normalizeParamKey.
func pipelineNormalizeQueryParamKey(value string) string {
	trimmed := strings.ToLower(pipelineTrimJS(value))
	if trimmed == "" || len(trimmed) > 64 {
		return ""
	}
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' {
			continue
		}
		return ""
	}
	return trimmed
}

// pipelineDecodeFormComponent is URLSearchParams' form decoding.
func pipelineDecodeFormComponent(value string) string {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return strings.ReplaceAll(value, "+", " ")
	}
	return decoded
}

// pipelineEncodeFormComponent is the URLSearchParams serializer.
func pipelineEncodeFormComponent(value string) string {
	var builder strings.Builder
	for _, b := range []byte(value) {
		switch {
		case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
			builder.WriteByte(b)
		case b == '-', b == '_', b == '.', b == '!', b == '~', b == '*', b == '\'', b == '(', b == ')':
			builder.WriteByte(b)
		case b == ' ':
			builder.WriteByte('+')
		default:
			const hexDigits = "0123456789ABCDEF"
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[b>>4])
			builder.WriteByte(hexDigits[b&0x0f])
		}
	}
	return builder.String()
}

// --- processed-article indexing helpers
// (apps/api/src/common/processed-article-indexing.ts) ---

// pipelineSimpleStopwords is SIMPLE_STOPWORDS.
var pipelineSimpleStopwords = map[string]bool{
	"this": true, "that": true, "with": true, "from": true, "will": true,
	"have": true, "about": true, "their": true, "there": true, "after": true,
	"before": true, "where": true, "which": true, "while": true, "into": true,
	"within": true, "across": true, "against": true, "under": true,
	"between": true, "said": true, "says": true, "report": true,
	"reports": true, "update": true, "latest": true, "breaking": true,
	"market": true, "global": true, "world": true, "news": true,
	"analysis": true, "today": true, "live": true,
}

// pipelineNormalizeProcessedArticleLocation is normalizeProcessedArticleLocation.
func pipelineNormalizeProcessedArticleLocation(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := pipelineTrimJS(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// pipelineResolveProcessedArticleEventAt is resolveProcessedArticleEventAt with
// the processedAt fallback of the call site (now).
func pipelineResolveProcessedArticleEventAt(publishedAt, crawlAt *time.Time) time.Time {
	if publishedAt != nil {
		return *publishedAt
	}
	if crawlAt != nil {
		return *crawlAt
	}
	return time.Now().UTC()
}

// pipelineAlignUTCHourStart is alignUtcHourStart.
func pipelineAlignUTCHourStart(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), utc.Hour(), 0, 0, 0, time.UTC)
}

// pipelineNormalizeProcessedArticleSource is normalizeProcessedArticleSource.
func pipelineNormalizeProcessedArticleSource(value *string) string {
	if value == nil {
		return "unknown"
	}
	trimmed := pipelineTrimJS(*value)
	if trimmed == "" {
		return "unknown"
	}
	return strings.ToLower(trimmed)
}

// pipelineExtractProcessedArticleTerms is extractProcessedArticleTerms.
func pipelineExtractProcessedArticleTerms(title, summary *string, topics []string) []string {
	terms := make([]string, 0, 16)
	seen := map[string]bool{}
	pushTokens := func(text *string) {
		if text == nil {
			return
		}
		for _, token := range pipelineSplitNonAlnum(strings.ToLower(*text)) {
			normalized := pipelineTrimJS(token)
			if len(normalized) < 4 || pipelineSimpleStopwords[normalized] {
				continue
			}
			if seen[normalized] {
				continue
			}
			seen[normalized] = true
			terms = append(terms, normalized)
		}
	}
	pushTokens(title)
	pushTokens(summary)
	for _, topic := range topics {
		value := topic
		pushTokens(&value)
	}
	return terms
}

// pipelineSplitNonAlnum is text.split(/[^a-z0-9]+/g).
func pipelineSplitNonAlnum(value string) []string {
	fields := make([]string, 0, 16)
	start := -1
	for index, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if start < 0 {
				start = index
			}
			continue
		}
		if start >= 0 {
			fields = append(fields, value[start:index])
			start = -1
		}
	}
	if start >= 0 {
		fields = append(fields, value[start:])
	}
	return fields
}

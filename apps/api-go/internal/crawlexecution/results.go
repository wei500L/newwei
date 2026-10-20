package crawlexecution

// This file ports the persistResults half of
// apps/api/src/modules/crawl/crawl-result.service.ts that runTask executes:
// markdown extraction and hashing, task/org dedupe, CrawlResult +
// CrawlResultContent writes, org-race rollback, dedupe-stage logs, optional
// ingestToItems and the summary projection.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

const (
	// resultPersistConcurrencyLimit is RESULT_PERSIST_CONCURRENCY_LIMIT. The
	// Go port persists sequentially: the observable order is the same (a failed
	// entry aborts the batch) and it keeps the shared connection count low.
	resultPersistConcurrencyLimit = 6
	crawlResultContentsCollection = "crawlresultcontents"
)

// hashedItem is HashedCrawlResultItem.
type hashedItem struct {
	Article              crawl4ai.PipelineArticle
	Markdown             string
	MarkdownResult       markdownResult
	Hash                 string
	SourceURL            string
	CanonicalSourceURL   *string
	SourceURLFingerprint *string
}

// existingResult is one existing CrawlResult dedupe row.
type existingResult struct {
	ID          string
	ContentHash string
	FetchedAt   time.Time
}

// partitionCrawlerResults is partitionCrawlerResults.
func partitionCrawlerResults(items []crawl4ai.PipelineArticle) partitionedResults {
	partition := partitionedResults{
		Successes:           make([]crawl4ai.PipelineArticle, 0, len(items)),
		Failures:            make([]Failure, 0, len(items)),
		LowSignalCandidates: make([]crawl4ai.PipelineArticle, 0),
	}
	for _, item := range items {
		kind, _, _, _, _ := classifyResult(item)
		switch kind {
		case "success":
			partition.Successes = append(partition.Successes, item)
		case "low_signal":
			partition.LowSignalCandidates = append(partition.LowSignalCandidates, item)
			partition.Failures = append(partition.Failures, buildFailureDetail(item))
		default:
			partition.Failures = append(partition.Failures, buildFailureDetail(item))
		}
	}
	return partition
}

// buildExpansionSeedCandidates is buildExpansionSeedCandidates.
func buildExpansionSeedCandidates(successes, lowSignalCandidates []crawl4ai.PipelineArticle) []crawl4ai.PipelineArticle {
	if len(successes) > 0 {
		return successes
	}
	return lowSignalCandidates
}

// isRetryableStatus is isRetryableStatus.
func isRetryableStatus(statusCode *int, errorMessage string) bool {
	if statusCode != nil {
		switch *statusCode {
		case 408, 423, 425, 429, 500, 502, 503, 504:
			return true
		}
	}
	if errorMessage == "" {
		return false
	}
	normalized := strings.ToLower(errorMessage)
	for _, needle := range []string{"timeout", "temporarily", "rate limit", "connection reset", "connection refused"} {
		if strings.Contains(normalized, needle) {
			return true
		}
	}
	return false
}

// countRetryableFailures counts the retryable failure details.
func countRetryableFailures(failures []Failure) int {
	count := 0
	for _, failure := range failures {
		if failure.Retryable {
			count++
		}
	}
	return count
}

// crawlerLogMessage is the crawler-stage task log message.
func crawlerLogMessage(failures []Failure, warnings []string) string {
	if len(failures) > 0 {
		return "crawl4ai completed with partial failures"
	}
	if len(warnings) > 0 {
		return "crawl4ai completed with warnings"
	}
	return "crawl4ai request completed"
}

// failureSamples projects the first limit failures for task-log data.
func failureSamples(failures []Failure, limit int) []map[string]any {
	if len(failures) == 0 {
		return []map[string]any{}
	}
	if limit <= 0 || limit > len(failures) {
		limit = len(failures)
	}
	samples := make([]map[string]any, 0, limit)
	for _, failure := range failures[:limit] {
		samples = append(samples, map[string]any{
			"url":        nullableStringValue(stringPtrOrNil(failure.URL)),
			"error":      failure.Message,
			"statusCode": intPtrValue(failure.StatusCode),
			"retryable":  failure.Retryable,
		})
	}
	return samples
}

// buildNoResultsError is the "crawl task produced no results" error.
func buildNoResultsError(failures []Failure) error {
	if len(failures) > 0 {
		first := failures[0]
		statusLabel := ""
		if first.StatusCode != nil {
			statusLabel = fmt.Sprintf("HTTP %d: ", *first.StatusCode)
		}
		urlLabel := ""
		if first.URL != "" {
			urlLabel = first.URL + ": "
		}
		countLabel := fmt.Sprintf("%d failures", len(failures))
		if len(failures) == 1 {
			countLabel = "1 failure"
		}
		return fmt.Errorf("crawl task produced no results (%s). %s%s%s", countLabel, urlLabel, statusLabel, first.Message)
	}
	return errors.New("crawl task produced no results (0 results returned)")
}

// memoryStatsOf projects the crawl4ai response memory stats.
func memoryStatsOf(response crawl4ai.PipelineResponse) memoryStats {
	return memoryStats{
		ServerMemoryMB:    response.ServerMemoryMB,
		PeakMemoryMB:      response.PeakMemoryMB,
		EfficiencyPercent: response.MemoryEfficiency,
	}
}

// summaryLogData is the data block of the complete-stage task log.
func summaryLogData(summary Summary) map[string]any {
	data := map[string]any{
		"inserted": summary.Inserted,
		"skipped":  summary.Skipped,
	}
	if summary.ReusedResultID != "" {
		data["reusedResultId"] = summary.ReusedResultID
	}
	if summary.RunID != "" {
		data["runId"] = summary.RunID
	}
	if summary.LastFetchedAt != nil {
		data["lastFetchedAt"] = summary.LastFetchedAt.UTC().Format(time.RFC3339Nano)
	}
	if summary.ItemsQueued > 0 || summary.ItemsQueueFailed > 0 {
		data["itemsQueued"] = summary.ItemsQueued
		data["itemsQueueFailed"] = summary.ItemsQueueFailed
	}
	if summary.RetryableFailures > 0 {
		data["retryableFailures"] = summary.RetryableFailures
	}
	return data
}

// hashMarkdown is hashMarkdown.
func hashMarkdown(markdown string) string {
	sum := sha256.Sum256([]byte(markdown))
	return hex.EncodeToString(sum[:])
}

// persistResults is CrawlResultService.persistResults for the runTask path. The
// memory stats are returned separately because the Summary contract the
// pipeline bridge reads does not carry them.
func (s *Service) persistResults(
	ctx context.Context,
	task *taskRow,
	items []crawl4ai.PipelineArticle,
	options normalizedOptions,
	response crawl4ai.PipelineResponse,
	ingestToItems bool,
	orgID string,
) (Summary, memoryStats, error) {
	runID := response.RunID
	if len(items) == 0 {
		return Summary{Inserted: 0, Skipped: 0, RunID: runID}, memoryStatsOf(response), nil
	}
	if s.db == nil {
		return Summary{}, memoryStats{}, errNotConfigured("crawlexecution: mysql is not configured")
	}
	inserted := 0
	skipped := 0
	var latestResultAt *time.Time
	var reusedResultID *string
	var reusedResultFetchedAt *time.Time
	taskReuseCount := 0
	orgReuseCount := 0
	batchDuplicateCount := 0
	itemsQueued := 0
	itemsQueueFailed := 0

	urlQueryParamAllowlist := extractURLQueryParamAllowlistFromTaskConfig(task.Config)
	orgContentDedupeWindowHours := extractOrgContentDedupeWindowHours(task.Config)
	var orgContentDedupeSince *time.Time
	if orgContentDedupeWindowHours > 0 {
		value := s.now().UTC().Add(-time.Duration(orgContentDedupeWindowHours) * time.Hour)
		orgContentDedupeSince = &value
	}

	itemsWithHash := make([]hashedItem, 0, len(items))
	for _, item := range items {
		markdown := extractMarkdownResult(item.Markdown)
		primary := ""
		if markdown.Primary != nil {
			primary = *markdown.Primary
		}
		if primary == "" {
			skipped++
			continue
		}
		sourceURL := strings.TrimSpace(item.URL)
		if sourceURL == "" {
			sourceURL = task.TargetURL
		}
		canonical := buildCanonicalURLFingerprint(sourceURL, urlQueryParamAllowlist)
		entry := hashedItem{
			Article:        item,
			Markdown:       primary,
			MarkdownResult: markdown,
			Hash:           hashMarkdown(primary),
			SourceURL:      sourceURL,
		}
		if canonical != nil {
			copiedCanonical := canonical.CanonicalURL
			copiedFingerprint := canonical.Fingerprint
			entry.CanonicalSourceURL = &copiedCanonical
			entry.SourceURLFingerprint = &copiedFingerprint
		}
		itemsWithHash = append(itemsWithHash, entry)
	}
	if len(itemsWithHash) == 0 {
		return Summary{Inserted: 0, Skipped: skipped, RunID: runID}, memoryStatsOf(response), nil
	}

	hashes := make([]string, 0, len(itemsWithHash))
	for _, entry := range itemsWithHash {
		hashes = append(hashes, entry.Hash)
	}
	existingTask, err := s.findExistingResults(ctx, "`taskId` = ?", task.ID, hashes)
	if err != nil {
		return Summary{}, memoryStats{}, err
	}
	existingTaskMap := make(map[string]existingResult, len(existingTask))
	for _, record := range existingTask {
		existingTaskMap[record.ContentHash] = record
	}
	existingOrg := make([]existingResult, 0)
	if orgContentDedupeSince != nil {
		existingOrg, err = s.findExistingOrgResults(ctx, task.OrgID, hashes, *orgContentDedupeSince)
		if err != nil {
			return Summary{}, memoryStats{}, err
		}
	}
	existingOrgMap := make(map[string]existingResult, len(existingOrg))
	for _, record := range existingOrg {
		if _, ok := existingOrgMap[record.ContentHash]; !ok {
			existingOrgMap[record.ContentHash] = record
		}
	}

	newItems := make([]hashedItem, 0, len(itemsWithHash))
	existingItems := make([]existingResult, 0, len(itemsWithHash))
	seenNewHashes := map[string]struct{}{}
	registerReused := func(existing existingResult) {
		if reusedResultFetchedAt == nil || existing.FetchedAt.After(*reusedResultFetchedAt) {
			fetchedAt := existing.FetchedAt
			reusedResultFetchedAt = &fetchedAt
			resultID := existing.ID
			reusedResultID = &resultID
		}
	}
	for _, entry := range itemsWithHash {
		if existing, ok := existingTaskMap[entry.Hash]; ok {
			skipped++
			taskReuseCount++
			existingItems = append(existingItems, existing)
			registerReused(existing)
			continue
		}
		if existing, ok := existingOrgMap[entry.Hash]; ok {
			skipped++
			orgReuseCount++
			existingItems = append(existingItems, existing)
			registerReused(existing)
			continue
		}
		if _, ok := seenNewHashes[entry.Hash]; ok {
			skipped++
			batchDuplicateCount++
			continue
		}
		seenNewHashes[entry.Hash] = struct{}{}
		newItems = append(newItems, entry)
	}

	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   task.ID,
		OrgID:   task.OrgID,
		Stage:   "dedupe",
		Status:  "completed",
		Message: stringPtr("Crawl dedupe classification complete"),
		Data: map[string]any{
			"evaluatedCount":              len(itemsWithHash),
			"taskReuseCount":              taskReuseCount,
			"orgReuseCount":               orgReuseCount,
			"batchDuplicateCount":         batchDuplicateCount,
			"insertedCandidateCount":      len(newItems),
			"orgContentDedupeWindowHours": orgContentDedupeWindowHours,
			"hasOrgContentDedupeWindow":   orgContentDedupeSince != nil,
		},
	})

	createdResultIDs := make([]string, 0, len(newItems))
	for _, entry := range newItems {
		persisted, persistErr := s.persistSingleResult(ctx, task, entry, options.StoreMedia, runID, orgContentDedupeSince, urlQueryParamAllowlist)
		if persistErr != nil {
			return Summary{}, memoryStats{}, persistErr
		}
		createdResultIDs = append(createdResultIDs, persisted.ResultID)
		if !persisted.Inserted {
			skipped++
			if reusedResultFetchedAt == nil || persisted.FetchedAt.After(*reusedResultFetchedAt) {
				fetchedAt := persisted.FetchedAt
				reusedResultFetchedAt = &fetchedAt
				resultID := persisted.ResultID
				reusedResultID = &resultID
			}
			continue
		}
		inserted++
		if latestResultAt == nil || persisted.FetchedAt.After(*latestResultAt) {
			fetchedAt := persisted.FetchedAt
			latestResultAt = &fetchedAt
		}
	}

	if ingestToItems {
		uniqueIDs := make([]string, 0, len(existingItems)+len(createdResultIDs))
		seen := map[string]struct{}{}
		for _, existing := range existingItems {
			if _, ok := seen[existing.ID]; ok {
				continue
			}
			seen[existing.ID] = struct{}{}
			uniqueIDs = append(uniqueIDs, existing.ID)
		}
		for _, resultID := range createdResultIDs {
			if _, ok := seen[resultID]; ok {
				continue
			}
			seen[resultID] = struct{}{}
			uniqueIDs = append(uniqueIDs, resultID)
		}
		if s.items == nil {
			log.Printf("crawlexecution: items service unavailable; skipping crawl result ingest taskId=%s", task.ID)
			itemsQueueFailed += len(uniqueIDs)
		} else {
			for _, resultID := range uniqueIDs {
				if _, ingestErr := s.items.CreateFromCrawlResult(ctx, orgID, task.CreatedByID, resultID); ingestErr != nil {
					itemsQueueFailed++
					log.Printf("crawlexecution: failed to ingest crawl result taskId=%s crawlResultId=%s: %v", task.ID, resultID, ingestErr)
					continue
				}
				itemsQueued++
			}
		}
	}

	summary := Summary{
		Inserted:         inserted,
		Skipped:          skipped,
		RunID:            runID,
		ItemsQueued:      itemsQueued,
		ItemsQueueFailed: itemsQueueFailed,
	}
	if reusedResultID != nil {
		summary.ReusedResultID = *reusedResultID
	}
	if latestResultAt != nil {
		summary.LastFetchedAt = latestResultAt
	} else if reusedResultFetchedAt != nil {
		summary.LastFetchedAt = reusedResultFetchedAt
	}
	return summary, memoryStatsOf(response), nil
}

// findExistingResults loads task-scoped dedupe rows for the hashes.
func (s *Service) findExistingResults(ctx context.Context, condition string, arg any, hashes []string) ([]existingResult, error) {
	placeholders, args := hashPlaceholders(hashes)
	query := "SELECT `id`, `contentHash`, `fetchedAt` FROM `CrawlResult` WHERE " + condition +
		" AND `contentHash` IN (" + placeholders + ")"
	args = append([]any{arg}, args...)
	return s.queryExistingResults(ctx, query, args...)
}

// findExistingOrgResults is the org-content dedupe window query.
func (s *Service) findExistingOrgResults(ctx context.Context, orgID string, hashes []string, since time.Time) ([]existingResult, error) {
	placeholders, hashArgs := hashPlaceholders(hashes)
	query := "SELECT `id`, `contentHash`, `fetchedAt` FROM `CrawlResult` WHERE `orgId` = ? AND `contentHash` IN (" +
		placeholders + ") AND `fetchedAt` >= ? ORDER BY `fetchedAt` DESC"
	args := make([]any, 0, len(hashArgs)+2)
	args = append(args, orgID)
	args = append(args, hashArgs...)
	args = append(args, since)
	return s.queryExistingResults(ctx, query, args...)
}

func (s *Service) queryExistingResults(ctx context.Context, query string, args ...any) ([]existingResult, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: query existing crawl results: %w", err)
	}
	defer func() { _ = rows.Close() }()
	results := make([]existingResult, 0, 8)
	for rows.Next() {
		var record existingResult
		if scanErr := rows.Scan(&record.ID, &record.ContentHash, &record.FetchedAt); scanErr != nil {
			return nil, scanErr
		}
		record.FetchedAt = record.FetchedAt.UTC()
		results = append(results, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

func hashPlaceholders(hashes []string) (string, []any) {
	placeholders := make([]string, 0, len(hashes))
	args := make([]any, 0, len(hashes))
	for _, hash := range hashes {
		placeholders = append(placeholders, "?")
		args = append(args, hash)
	}
	return strings.Join(placeholders, ", "), args
}

// persistSingleResult is persistSingleResult: insert the CrawlResult row, win
// the org-level dedupe race, write the CrawlResultContent document, then update
// markdownRef. Any failure rolls the transient row back and re-throws.
func (s *Service) persistSingleResult(
	ctx context.Context,
	task *taskRow,
	entry hashedItem,
	shouldStoreMedia bool,
	runID string,
	orgContentDedupeSince *time.Time,
	urlQueryParamAllowlist []string,
) (persistedResult, error) {
	fetchedAt := s.now().UTC().Truncate(time.Millisecond)
	metadata := buildResultMetadata(entry, urlQueryParamAllowlist)
	resultID, err := newRowID()
	if err != nil {
		return persistedResult{}, err
	}
	stage := "create_result"
	created := false
	rollback := func() {
		if created {
			s.rollbackPersistedResult(ctx, task, resultID)
		}
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `CrawlResult` (`id`, `taskId`, `orgId`, `sourceUrl`, `sourceUrlFingerprint`, `fetchedAt`, `markdownRef`, `contentHash`, `metadata`, `createdAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)",
		resultID, task.ID, task.OrgID, entry.SourceURL, nullableString(entry.SourceURLFingerprint),
		fetchedAt, entry.Hash, metadata, fetchedAt); err != nil {
		if isUniqueConflict(err) {
			existing, findErr := s.findResultByTaskAndHash(ctx, task.ID, entry.Hash)
			if findErr == nil && existing != nil {
				log.Printf("crawlexecution: detected duplicate crawl result insert race, skipping taskId=%s orgId=%s resultId=%s",
					task.ID, task.OrgID, existing.ID)
				return persistedResult{ResultID: existing.ID, FetchedAt: existing.FetchedAt, Inserted: false}, nil
			}
		}
		return persistedResult{}, fmt.Errorf("crawlexecution: insert crawl result taskId=%s: %w", task.ID, err)
	}
	created = true

	if orgContentDedupeSince != nil {
		stage = "check_org_dedupe_race"
		winner, winnerErr := s.selectOrgDedupeWinner(ctx, task, entry.Hash, resultID, fetchedAt, *orgContentDedupeSince)
		if winnerErr != nil {
			rollback()
			return persistedResult{}, winnerErr
		}
		if winner != nil {
			log.Printf("crawlexecution: detected org-level duplicate crawl result insert race, rolling back taskId=%s orgId=%s transientResultId=%s duplicateResultId=%s",
				task.ID, task.OrgID, resultID, winner.ID)
			s.rollbackPersistedResult(ctx, task, resultID)
			return persistedResult{ResultID: winner.ID, FetchedAt: winner.FetchedAt, Inserted: false}, nil
		}
	}

	stage = "store_content"
	markdownRef, contentErr := s.writeResultContent(ctx, task, resultID, entry, runID, shouldStoreMedia)
	if contentErr != nil {
		log.Printf("crawlexecution: failed to persist crawl result entry taskId=%s orgId=%s sourceUrl=%s contentHash=%s stage=%s: %v",
			task.ID, task.OrgID, entry.SourceURL, entry.Hash, stage, contentErr)
		s.rollbackPersistedResult(ctx, task, resultID)
		return persistedResult{}, contentErr
	}

	stage = "update_markdown_ref"
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `CrawlResult` SET `markdownRef` = ? WHERE `id` = ?", markdownRef, resultID); err != nil {
		log.Printf("crawlexecution: failed to update crawl result markdownRef taskId=%s resultId=%s stage=%s: %v",
			task.ID, resultID, stage, err)
		s.rollbackPersistedResult(ctx, task, resultID)
		return persistedResult{}, fmt.Errorf("crawlexecution: update crawl result markdownRef: %w", err)
	}
	return persistedResult{ResultID: resultID, FetchedAt: fetchedAt, Inserted: true}, nil
}

func (s *Service) findResultByTaskAndHash(ctx context.Context, taskID, contentHash string) (*existingResult, error) {
	var record existingResult
	var fetchedAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `contentHash`, `fetchedAt` FROM `CrawlResult` WHERE `taskId` = ? AND `contentHash` = ? LIMIT 1",
		taskID, contentHash).Scan(&record.ID, &record.ContentHash, &fetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.FetchedAt = fetchedAt.UTC()
	return &record, nil
}

// selectOrgDedupeWinner is the org dedupe race check: the earliest createdAt
// (then id) wins.
func (s *Service) selectOrgDedupeWinner(
	ctx context.Context,
	task *taskRow,
	contentHash, createdID string,
	createdFetchedAt time.Time,
	since time.Time,
) (*existingResult, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `fetchedAt`, `createdAt` FROM `CrawlResult` WHERE `orgId` = ? AND `contentHash` = ? AND `fetchedAt` >= ? AND `id` <> ?",
		task.OrgID, contentHash, since, createdID)
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: check org-level crawl result dedupe: %w", err)
	}
	defer func() { _ = rows.Close() }()
	type candidate struct {
		id        string
		fetchedAt time.Time
		createdAt time.Time
	}
	candidates := []candidate{{id: createdID, fetchedAt: createdFetchedAt, createdAt: createdFetchedAt}}
	for rows.Next() {
		var entry candidate
		if scanErr := rows.Scan(&entry.id, &entry.fetchedAt, &entry.createdAt); scanErr != nil {
			return nil, scanErr
		}
		candidates = append(candidates, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if !candidates[left].createdAt.Equal(candidates[right].createdAt) {
			return candidates[left].createdAt.Before(candidates[right].createdAt)
		}
		return candidates[left].id < candidates[right].id
	})
	winner := candidates[0]
	if winner.id == createdID {
		return nil, nil
	}
	return &existingResult{ID: winner.id, ContentHash: contentHash, FetchedAt: winner.fetchedAt.UTC()}, nil
}

// writeResultContent upserts the CrawlResultContent document and returns its
// Mongo ObjectID hex string (the markdownRef). Media binaries/assets are not
// persisted (see the package gaps); the raw media collection is.
func (s *Service) writeResultContent(
	ctx context.Context,
	task *taskRow,
	resultID string,
	entry hashedItem,
	runID string,
	shouldStoreMedia bool,
) (string, error) {
	if s.mongo == nil {
		return "", errNotConfigured("crawlexecution: mongo is not configured")
	}
	collection := s.mongo.Collection(crawlResultContentsCollection)
	document := bson.D{
		{Key: "taskId", Value: task.ID},
		{Key: "resultId", Value: resultID},
		{Key: "markdown", Value: entry.Markdown},
		{Key: "rawMarkdown", Value: nullableMarkdownValue(entry.MarkdownResult.Raw, entry.Markdown)},
		{Key: "markdownWithCitations", Value: nullableStringValue(entry.MarkdownResult.Citations)},
		{Key: "referencesMarkdown", Value: nullableStringValue(entry.MarkdownResult.References)},
		{Key: "fitMarkdown", Value: nullableStringValue(entry.MarkdownResult.Fit)},
		{Key: "metadata", Value: decodeJSONLeaf(entry.Article.Metadata, bson.M{})},
		{Key: "sourceUrl", Value: entry.SourceURL},
		{Key: "crawlRunId", Value: nullableRunIDValue(runID)},
		{Key: "linkAnalysis", Value: buildLinkAnalysis(entry.Article.Links)},
		{Key: "tables", Value: decodeJSONLeaf(entry.Article.Tables, nil)},
	}
	if shouldStoreMedia {
		document = append(document, bson.E{Key: "media", Value: decodeJSONLeaf(entry.Article.Media, nil)})
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	setOnInsert := bson.D{
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	}
	setOnInsert = append(setOnInsert, document...)
	_, err := collection.UpdateOne(ctx,
		bson.D{{Key: "resultId", Value: resultID}},
		bson.D{{Key: "$setOnInsert", Value: setOnInsert}},
		options.UpdateOne().SetUpsert(true))
	if err != nil {
		return "", fmt.Errorf("crawlexecution: persist crawl result content: %w", err)
	}
	var persisted struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := collection.FindOne(ctx, bson.D{{Key: "resultId", Value: resultID}}).Decode(&persisted); err != nil {
		return "", fmt.Errorf("crawlexecution: read persisted crawl result content: %w", err)
	}
	markdownRef := persisted.ID.Hex()
	if markdownRef == "" {
		return "", errors.New("missing markdownRef after crawl content persistence")
	}
	return markdownRef, nil
}

// rollbackPersistedResult deletes the content document and the transient row.
func (s *Service) rollbackPersistedResult(ctx context.Context, task *taskRow, resultID string) {
	if s.mongo != nil {
		if _, err := s.mongo.Collection(crawlResultContentsCollection).DeleteOne(ctx, bson.D{{Key: "resultId", Value: resultID}}); err != nil {
			log.Printf("crawlexecution: failed to cleanup crawl result content during rollback taskId=%s resultId=%s: %v", task.ID, resultID, err)
		}
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM `CrawlResult` WHERE `id` = ?", resultID); err != nil {
		log.Printf("crawlexecution: failed to cleanup crawl result row during rollback taskId=%s resultId=%s: %v", task.ID, resultID, err)
	}
}

func nullableMarkdownValue(value *string, fallback string) string {
	if value != nil {
		return *value
	}
	return fallback
}

func nullableRunIDValue(runID string) any {
	if runID == "" {
		return nil
	}
	return runID
}

// decodeJSONLeaf decodes an open JSON leaf for Mongo.
func decodeJSONLeaf(raw json.RawMessage, fallback any) any {
	if len(raw) == 0 {
		return fallback
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return fallback
	}
	return decoded
}

// buildResultMetadata merges the article metadata with the canonical URL fields
// and the validation state persisted by attachHTTPValidationMetadata.
func buildResultMetadata(entry hashedItem, urlQueryParamAllowlist []string) json.RawMessage {
	record := map[string]json.RawMessage{}
	if len(entry.Article.Metadata) > 0 {
		_ = json.Unmarshal(entry.Article.Metadata, &record)
	}
	if record == nil {
		record = map[string]json.RawMessage{}
	}
	setRaw := func(key string, value any) {
		encoded, err := json.Marshal(value)
		if err == nil {
			record[key] = encoded
		}
	}
	if entry.CanonicalSourceURL != nil {
		setRaw("canonicalUrl", *entry.CanonicalSourceURL)
	}
	if entry.SourceURLFingerprint != nil {
		setRaw("urlFingerprint", *entry.SourceURLFingerprint)
	}
	if entry.CanonicalSourceURL != nil && *entry.CanonicalSourceURL != entry.SourceURL {
		setRaw("originalUrl", entry.SourceURL)
	}
	if len(urlQueryParamAllowlist) > 0 {
		setRaw("urlQueryParamAllowlist", urlQueryParamAllowlist)
	}
	if entry.Article.PublishedAt != nil {
		if _, exists := record["publishedAt"]; !exists {
			if publishedAt := coerceDate(entry.Article.PublishedAt); publishedAt != nil {
				setRaw("publishedAt", publishedAt.UTC().Format(time.RFC3339Nano))
			}
		}
	}
	merged, err := json.Marshal(record)
	if err != nil {
		return json.RawMessage("{}")
	}
	return merged
}

// coerceDate is coerceDate: new Date(value), only http-date-free strings here.
func coerceDate(raw json.RawMessage) *time.Time {
	if len(raw) == 0 {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		var numeric float64
		if numberErr := json.Unmarshal(raw, &numeric); numberErr != nil {
			return nil
		}
		parsed := time.UnixMilli(int64(numeric)).UTC()
		return &parsed
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

// linkAnalysisLink is one normalized CrawlLinkAnalysisLink.
type linkAnalysisLink struct {
	Href            string   `bson:"href"`
	Text            *string  `bson:"text,omitempty"`
	Title           *string  `bson:"title,omitempty"`
	BaseDomain      *string  `bson:"baseDomain,omitempty"`
	Rel             *string  `bson:"rel,omitempty"`
	Type            string   `bson:"type"`
	IntrinsicScore  *float64 `bson:"intrinsicScore,omitempty"`
	ContextualScore *float64 `bson:"contextualScore,omitempty"`
	TotalScore      *float64 `bson:"totalScore,omitempty"`
}

// linkAnalysisBucket is one CrawlLinkAnalysisBucket.
type linkAnalysisBucket struct {
	Kind  string             `bson:"kind"`
	Links []linkAnalysisLink `bson:"links"`
}

// buildLinkAnalysis ports buildLinkAnalysis from link-analysis.ts.
func buildLinkAnalysis(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var buckets map[string][]map[string]any
	if err := json.Unmarshal(raw, &buckets); err != nil {
		return nil
	}
	allLinks := make([]linkAnalysisLink, 0, 32)
	bucketList := make([]linkAnalysisBucket, 0, 2)
	internalCount := 0
	externalCount := 0
	for kind, entries := range buckets {
		links := make([]linkAnalysisLink, 0, len(entries))
		for _, entry := range entries {
			href := pickMapString(entry, "href", "url")
			if href == "" {
				continue
			}
			links = append(links, linkAnalysisLink{
				Href:            href,
				Text:            pickMapStringPtr(entry, "text", "label", "content"),
				Title:           pickMapStringPtr(entry, "title"),
				BaseDomain:      pickMapStringPtr(entry, "base_domain", "baseDomain"),
				Rel:             pickMapStringPtr(entry, "rel"),
				Type:            kind,
				IntrinsicScore:  pickMapNumber(entry, "intrinsic_score", "intrinsicScore", "score"),
				ContextualScore: pickMapNumber(entry, "contextual_score", "contextualScore"),
				TotalScore:      pickMapNumber(entry, "total_score", "totalScore"),
			})
		}
		if len(links) == 0 {
			continue
		}
		bucketList = append(bucketList, linkAnalysisBucket{Kind: kind, Links: links})
		allLinks = append(allLinks, links...)
		if kind == "internal" {
			internalCount += len(links)
		}
		if kind == "external" {
			externalCount += len(links)
		}
	}
	if len(allLinks) == 0 {
		return nil
	}
	intrinsicScores := make([]float64, 0, len(allLinks))
	highQuality := 0
	lowQuality := 0
	for _, link := range allLinks {
		if link.IntrinsicScore == nil {
			continue
		}
		intrinsicScores = append(intrinsicScores, *link.IntrinsicScore)
		if *link.IntrinsicScore >= 7 {
			highQuality++
		} else if *link.IntrinsicScore > 0 && *link.IntrinsicScore < 3 {
			lowQuality++
		}
	}
	var averageIntrinsic any
	if len(intrinsicScores) > 0 {
		total := 0.0
		for _, score := range intrinsicScores {
			total += score
		}
		averageIntrinsic = math.Round(total/float64(len(intrinsicScores))*100) / 100
	}
	stats := map[string]any{
		"totalLinks":            len(allLinks),
		"internalLinks":         internalCount,
		"externalLinks":         externalCount,
		"averageIntrinsicScore": averageIntrinsic,
		"highQualityLinks":      highQuality,
		"lowQualityLinks":       lowQuality,
	}
	topLinks := append([]linkAnalysisLink(nil), allLinks...)
	sort.SliceStable(topLinks, func(left, right int) bool {
		return compareLinkScoreDesc(topLinks[left], topLinks[right])
	})
	if len(topLinks) > 5 {
		topLinks = topLinks[:5]
	}
	lowQualityLinks := append([]linkAnalysisLink(nil), allLinks...)
	sort.SliceStable(lowQualityLinks, func(left, right int) bool {
		return compareLinkScoreAsc(lowQualityLinks[left], lowQualityLinks[right])
	})
	if len(lowQualityLinks) > 5 {
		lowQualityLinks = lowQualityLinks[:5]
	}
	return map[string]any{
		"stats":           stats,
		"buckets":         bucketList,
		"topLinks":        topLinks,
		"lowQualityLinks": lowQualityLinks,
	}
}

// compareLinkScoreDesc is pickTopLinks' comparator.
func compareLinkScoreDesc(left, right linkAnalysisLink) bool {
	leftScore := math.Inf(-1)
	if left.IntrinsicScore != nil {
		leftScore = *left.IntrinsicScore
	}
	rightScore := math.Inf(-1)
	if right.IntrinsicScore != nil {
		rightScore = *right.IntrinsicScore
	}
	if rightScore != leftScore {
		return rightScore > leftScore
	}
	leftSecondary := secondaryLinkScore(left)
	rightSecondary := secondaryLinkScore(right)
	if rightSecondary != leftSecondary {
		return rightSecondary > leftSecondary
	}
	return left.Href < right.Href
}

// compareLinkScoreAsc is pickLowQualityLinks' comparator.
func compareLinkScoreAsc(left, right linkAnalysisLink) bool {
	leftScore := math.Inf(1)
	if left.IntrinsicScore != nil {
		leftScore = *left.IntrinsicScore
	}
	rightScore := math.Inf(1)
	if right.IntrinsicScore != nil {
		rightScore = *right.IntrinsicScore
	}
	if leftScore != rightScore {
		return leftScore < rightScore
	}
	return left.Href < right.Href
}

func secondaryLinkScore(link linkAnalysisLink) float64 {
	if link.TotalScore != nil {
		return *link.TotalScore
	}
	if link.ContextualScore != nil {
		return *link.ContextualScore
	}
	return math.Inf(-1)
}

// pickMapString returns the first non-empty string value for keys.
func pickMapString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

// pickMapStringPtr is pickMapString returning an optional value.
func pickMapStringPtr(record map[string]any, keys ...string) *string {
	value := pickMapString(record, keys...)
	if value == "" {
		return nil
	}
	return &value
}

// pickMapNumber returns the first finite number value for keys.
func pickMapNumber(record map[string]any, keys ...string) *float64 {
	for _, key := range keys {
		if value, ok := record[key].(float64); ok && !math.IsNaN(value) {
			return &value
		}
	}
	return nil
}

// pickMetadataString decodes an open metadata JSON string field.
func pickMetadataString(raw json.RawMessage, keys ...string) string {
	record := decodeMetadataMap(raw)
	if record == nil {
		return ""
	}
	for _, key := range keys {
		if value := pickRawString(record, key); value != nil {
			return *value
		}
	}
	return ""
}

func pickMetadataBool(raw json.RawMessage, keys ...string) (bool, bool) {
	record := decodeMetadataMap(raw)
	if record == nil {
		return false, false
	}
	for _, key := range keys {
		value, ok := record[key]
		if !ok {
			continue
		}
		var parsed bool
		if err := json.Unmarshal(value, &parsed); err == nil {
			return parsed, true
		}
	}
	return false, false
}

func pickMetadataInt(raw json.RawMessage, keys ...string) *int {
	record := decodeMetadataMap(raw)
	if record == nil {
		return nil
	}
	for _, key := range keys {
		value, ok := record[key]
		if !ok {
			continue
		}
		var numeric float64
		if err := json.Unmarshal(value, &numeric); err == nil {
			parsed := int(math.Round(numeric))
			return &parsed
		}
	}
	return nil
}

func decodeMetadataMap(raw json.RawMessage) map[string]json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil
	}
	return record
}

// newRowID writes a Prisma cuid-shaped column ('c' plus 24 hex characters).
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// isUniqueConflict reports MySQL unique-key 1062 (Prisma P2002).
func isUniqueConflict(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

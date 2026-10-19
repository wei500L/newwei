package itemsingest

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// crawlResultIngestConcurrency is CRAWL_RESULT_INGEST_CONCURRENCY.
const crawlResultIngestConcurrency = 8

type crawlPrepared struct {
	row           CrawlResultRow
	externalID    string
	itemMetaName  string
	payload       NormalizedNewsPayload
	pipelineJobID *string
	priority      *int64
	sourceID      *string
}

type crawlPlan struct {
	createdByThisProcess bool
	meta                 itemsreading.ItemMetaRow
	prepared             crawlPrepared
	rawID                string
	rawDoc               bson.D
}

type settled[T any] struct {
	Value T
	Err   error
}

// runConcurrent applies fn with a bounded worker pool while preserving input
// order in the returned results.
func runConcurrent[T any, R any](ctx context.Context, items []T, limit int, fn func(context.Context, T) (R, error)) []settled[R] {
	results := make([]settled[R], len(items))
	if len(items) == 0 {
		return results
	}
	if limit < 1 {
		limit = 1
	}
	type job struct{ index int }
	jobs := make(chan job)
	var workers = limit
	if workers > len(items) {
		workers = len(items)
	}
	done := make(chan struct{}, workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			for current := range jobs {
				value, err := fn(ctx, items[current.index])
				results[current.index] = settled[R]{Value: value, Err: err}
			}
			done <- struct{}{}
		}()
	}
	for index := range items {
		jobs <- job{index: index}
	}
	close(jobs)
	for worker := 0; worker < workers; worker++ {
		<-done
	}
	return results
}

// createFromCrawlResults ports ItemsIngestService.createFromCrawlResultsBatch.
// Missing references are persisted by a direct unordered Mongo insert and a
// SQL mongoRef CAS; this is deliberately different from the raw_item Outbox
// path used by create/update.
func (s *Service) createFromCrawlResults(
	ctx context.Context,
	orgID, userID string,
	input CreateFromCrawlResultsInput,
) ([]CreateFromCrawlResultOutcome, error) {
	requestedIDs := dedupeTrimmedCrawlResultIDs(input.CrawlResults, input.CrawlResultIDs)
	if len(requestedIDs) == 0 {
		return []CreateFromCrawlResultOutcome{}, nil
	}

	byID := make(map[string]CrawlResultRow, len(requestedIDs))
	if len(input.CrawlResults) > 0 {
		for _, row := range input.CrawlResults {
			if containsString(requestedIDs, row.ID) {
				byID[row.ID] = row
			}
		}
	} else {
		rows, err := s.store.crawlResultsByIDs(ctx, orgID, requestedIDs)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			byID[row.ID] = row
		}
	}

	outcomes := make(map[string]CreateFromCrawlResultOutcome, len(requestedIDs))
	orderedRows := make([]CrawlResultRow, 0, len(requestedIDs))
	for _, id := range requestedIDs {
		row, ok := byID[id]
		if !ok {
			outcomes[id] = CreateFromCrawlResultOutcome{CrawlResultID: id, Err: crawlResultNotFound()}
			continue
		}
		orderedRows = append(orderedRows, row)
	}
	if len(orderedRows) == 0 {
		return orderedOutcomes(requestedIDs, outcomes), nil
	}

	prepared := make([]crawlPrepared, 0, len(orderedRows))
	for _, row := range orderedRows {
		entry, err := s.prepareCrawlResult(row)
		if err != nil {
			// parsePayload runs before the per-item settle block in NestJS, so
			// a payload-schema failure aborts the whole batch.
			return nil, err
		}
		prepared = append(prepared, entry)
	}

	externalIDs := make([]string, 0, len(prepared))
	for _, entry := range prepared {
		externalIDs = append(externalIDs, entry.externalID)
	}
	existing, err := s.store.itemMetasByExternalIDs(ctx, orgID, externalIDs)
	if err != nil {
		return nil, err
	}
	existingByExternalID := make(map[string]itemsreading.ItemMetaRow, len(existing))
	for _, meta := range existing {
		existingByExternalID[meta.ExternalID] = meta
	}

	now := s.now().UTC().Truncate(time.Millisecond)
	plannedIDs := make(map[string]string)
	missingRows := make([]itemsreading.ItemMetaRow, 0)
	for _, entry := range prepared {
		if _, ok := existingByExternalID[entry.externalID]; ok {
			continue
		}
		id := newUUIDv4()
		plannedIDs[entry.externalID] = id
		missingRows = append(missingRows, itemsreading.ItemMetaRow{
			ID:         id,
			OrgID:      orgID,
			ExternalID: entry.externalID,
			Name:       entry.itemMetaName,
			Status:     "pending",
			MongoRef:   "",
			Version:    1,
			SortAt:     itemsreading.NewISOTime(now),
			CreatedAt:  itemsreading.NewISOTime(now),
			UpdatedAt:  itemsreading.NewISOTime(now),
		})
	}
	if len(missingRows) > 0 {
		if err := s.store.insertMissingCrawlResultMetas(ctx, missingRows); err != nil {
			return nil, err
		}
	}
	resolved := existing
	if len(missingRows) > 0 {
		resolved, err = s.store.itemMetasByExternalIDs(ctx, orgID, externalIDs)
		if err != nil {
			return nil, err
		}
	}
	metaByExternalID := make(map[string]itemsreading.ItemMetaRow, len(resolved))
	for _, meta := range resolved {
		metaByExternalID[meta.ExternalID] = meta
	}

	withRef := make([]crawlPrepared, 0)
	withoutRef := make([]crawlPlan, 0)
	for _, entry := range prepared {
		meta, ok := metaByExternalID[entry.externalID]
		if !ok {
			outcomes[entry.row.ID] = CreateFromCrawlResultOutcome{
				CrawlResultID: entry.row.ID,
				Err:           NewFailure(503, "Failed to resolve item meta for crawl result"),
			}
			continue
		}
		if strings.TrimSpace(meta.MongoRef) != "" {
			withRef = append(withRef, entry)
			continue
		}
		withoutRef = append(withoutRef, crawlPlan{
			createdByThisProcess: plannedIDs[entry.externalID] == meta.ID,
			meta:                 meta,
			prepared:             entry,
		})
	}

	existingResults := runConcurrent(ctx, withRef, crawlResultIngestConcurrency, func(ctx context.Context, entry crawlPrepared) (itemsreading.ItemMetaRow, error) {
		meta := metaByExternalID[entry.externalID]
		if err := s.enqueueCrawlResultItem(ctx, orgID, meta, entry); err != nil {
			return meta, err
		}
		return meta, nil
	})
	for index, result := range existingResults {
		entry := withRef[index]
		if result.Err != nil {
			outcomes[entry.row.ID] = CreateFromCrawlResultOutcome{CrawlResultID: entry.row.ID, Err: result.Err}
			continue
		}
		meta := result.Value
		outcomes[entry.row.ID] = CreateFromCrawlResultOutcome{CrawlResultID: entry.row.ID, Meta: &meta}
	}

	cleanup := make(map[string]struct{})
	validated := runConcurrent(ctx, withoutRef, crawlResultIngestConcurrency, func(ctx context.Context, plan crawlPlan) (crawlPlan, error) {
		rawID := bson.NewObjectID().Hex()
		rawDoc, err := newRawItemDocument(plan.meta.ID, rawID, "crawl-task", plan.prepared.payload, s.now())
		if err != nil {
			return plan, err
		}
		plan.rawID = rawID
		plan.rawDoc = rawDoc
		return plan, nil
	})
	plans := make([]crawlPlan, 0, len(validated))
	for index, result := range validated {
		if result.Err != nil {
			if withoutRef[index].createdByThisProcess {
				cleanup[withoutRef[index].meta.ID] = struct{}{}
			}
			outcomes[withoutRef[index].prepared.row.ID] = CreateFromCrawlResultOutcome{
				CrawlResultID: withoutRef[index].prepared.row.ID,
				Err:           result.Err,
			}
			continue
		}
		plans = append(plans, result.Value)
	}

	if len(plans) > 0 {
		docs := make([]bson.D, 0, len(plans))
		for _, plan := range plans {
			docs = append(docs, plan.rawDoc)
		}
		if err := s.insertRawItems(ctx, docs); err != nil {
			// Unordered inserts can partially succeed. The ids are verified
			// below, so the warning is diagnostic only.
			logCrawlInsertFailure(orgID, plans, err)
		}
		rawIDs := make([]string, 0, len(plans))
		for _, plan := range plans {
			rawIDs = append(rawIDs, plan.rawID)
		}
		inserted, err := s.findExistingRawItemIDs(ctx, rawIDs)
		if err != nil {
			return nil, err
		}
		bindResults := runConcurrent(ctx, plans, crawlResultIngestConcurrency, func(ctx context.Context, plan crawlPlan) (itemsreading.ItemMetaRow, error) {
			if _, ok := inserted[plan.rawID]; !ok {
				return plan.meta, NewFailure(503, "Failed to persist raw crawl result item")
			}
			won, err := s.store.bindEmptyRef(ctx, orgID, plan.meta.ID, plan.rawID)
			if err != nil {
				return plan.meta, err
			}
			if !won {
				// The loser removes only the raw document it created and
				// returns the winner's current reference.
				s.deleteRawItem(ctx, plan.rawID)
				latest, err := s.store.findItemMetaByID(ctx, orgID, plan.meta.ID)
				if err != nil {
					return plan.meta, err
				}
				if latest != nil {
					return *latest, nil
				}
				return plan.meta, nil
			}
			meta := plan.meta
			meta.MongoRef = plan.rawID
			if plan.createdByThisProcess {
				metadata := mustJSON(struct {
					CrawlTaskID   string `json:"crawlTaskId"`
					CrawlResultID string `json:"crawlResultId"`
					SourceURL     string `json:"sourceUrl"`
				}{
					CrawlTaskID:   plan.prepared.row.TaskID,
					CrawlResultID: plan.prepared.row.ID,
					SourceURL:     plan.prepared.row.SourceURL,
				})
				if err := s.store.insertAuditLog(ctx, orgID, userID, "item", "createFromCrawlResult", metadata); err != nil {
					log.Printf("itemsingest: createFromCrawlResult audit failed orgId=%s itemMetaId=%s: %v", orgID, meta.ID, err)
				}
			}
			if err := s.enqueueCrawlResultItem(ctx, orgID, meta, plan.prepared); err != nil {
				return meta, err
			}
			if err := s.hydrate(ctx, orgID, meta.ID); err != nil {
				return meta, err
			}
			return meta, nil
		})
		for index, result := range bindResults {
			plan := plans[index]
			if result.Err != nil {
				if plan.createdByThisProcess {
					cleanup[plan.meta.ID] = struct{}{}
				}
				outcomes[plan.prepared.row.ID] = CreateFromCrawlResultOutcome{
					CrawlResultID: plan.prepared.row.ID,
					Err:           result.Err,
				}
				continue
			}
			meta := result.Value
			outcomes[plan.prepared.row.ID] = CreateFromCrawlResultOutcome{CrawlResultID: plan.prepared.row.ID, Meta: &meta}
		}
	}

	if len(cleanup) > 0 {
		ids := make([]string, 0, len(cleanup))
		for id := range cleanup {
			ids = append(ids, id)
		}
		if err := s.store.cleanupEmptyMetas(ctx, orgID, ids); err != nil {
			log.Printf("itemsingest: cleanup of empty crawl-result metas failed orgId=%s ids=%v: %v", orgID, ids, err)
		}
	}
	return orderedOutcomes(requestedIDs, outcomes), nil
}

func logCrawlInsertFailure(orgID string, plans []crawlPlan, err error) {
	ids := make([]string, 0, len(plans))
	for _, plan := range plans {
		ids = append(ids, plan.prepared.row.ID)
	}
	log.Printf("itemsingest: crawl-result raw insert warning orgId=%s crawlResultIds=%v: %v", orgID, ids, err)
}

// prepareCrawlResult ports prepareCrawlResultItemIngestInput.
func (s *Service) prepareCrawlResult(row CrawlResultRow) (crawlPrepared, error) {
	config := jsonObject(row.Task.Config)
	itemPayload := jsonObject(config["itemPayload"])
	itemPayloadMetadata := jsonObject(itemPayload["metadata"])
	resultMetadata := jsonObject(row.Metadata)

	sourceName := ""
	if value := rawString(itemPayload["sourceName"]); value != "" {
		sourceName = value
	} else if row.Task.DisplayName != nil {
		sourceName = strings.TrimSpace(*row.Task.DisplayName)
	}
	language := rawString(itemPayload["language"])
	if language == "" {
		language = rawString(resultMetadata["language"])
	}
	if language == "" {
		language = rawString(resultMetadata["lang"])
	}
	tags := toStringArray(itemPayload["tags"])
	summaryHints := toStringArray(itemPayload["summaryHints"])
	keywords := toStringArray(row.Task.Keywords)

	pipelineJobID := optionalRawString(config["pipelineJobId"])
	sourceID := optionalRawString(itemPayloadMetadata["sourceId"])
	var priority *int64
	if raw, ok := config["pipelinePriority"]; ok {
		var number float64
		if json.Unmarshal(raw, &number) == nil && !math.IsNaN(number) && !math.IsInf(number, 0) {
			rounded := int64(math.Round(number))
			priority = &rounded
		}
	}

	metadata := make(map[string]json.RawMessage, len(itemPayloadMetadata)+len(resultMetadata)+8)
	for key, value := range itemPayloadMetadata {
		metadata[key] = value
	}
	for key, value := range resultMetadata {
		metadata[key] = value
	}
	metadata["crawlTaskId"] = mustJSON(row.TaskID)
	if row.Task.DisplayName != nil && strings.TrimSpace(*row.Task.DisplayName) != "" {
		metadata["crawlTaskDisplayName"] = mustJSON(strings.TrimSpace(*row.Task.DisplayName))
	}
	if row.Task.TargetURL != nil && strings.TrimSpace(*row.Task.TargetURL) != "" {
		metadata["crawlTaskTargetUrl"] = mustJSON(strings.TrimSpace(*row.Task.TargetURL))
	}
	metadata["crawlResultId"] = mustJSON(row.ID)
	metadata["crawlFetchedAt"] = mustJSON(itemsreading.FormatISOTime(row.FetchedAt))
	metadata["crawlContentHash"] = mustJSON(row.ContentHash)
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return crawlPrepared{}, err
	}

	input := struct {
		URL          string          `json:"url"`
		SourceName   string          `json:"sourceName,omitempty"`
		Language     string          `json:"language,omitempty"`
		Keywords     []string        `json:"keywords"`
		Tags         []string        `json:"tags"`
		SummaryHints []string        `json:"summaryHints"`
		Metadata     json.RawMessage `json:"metadata"`
		ForceRefresh bool            `json:"forceRefresh"`
	}{
		URL:          row.SourceURL,
		SourceName:   sourceName,
		Language:     language,
		Keywords:     keywords,
		Tags:         tags,
		SummaryHints: summaryHints,
		Metadata:     metadataJSON,
		ForceRefresh: false,
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return crawlPrepared{}, err
	}
	payload, err := NormalizeNewsPayload(encoded)
	if err != nil {
		return crawlPrepared{}, err
	}

	nameSource := row.SourceURL
	if sourceName != "" {
		nameSource = sourceName + ": " + row.SourceURL
	}
	return crawlPrepared{
		row:           row,
		externalID:    "crawlResult:" + row.ID,
		itemMetaName:  toItemMetaName(nameSource),
		payload:       payload,
		pipelineJobID: pipelineJobID,
		priority:      priority,
		sourceID:      sourceID,
	}, nil
}

// enqueueCrawlResultItem only re-enqueues the statuses the NestJS service
// accepts. completed/duplicate/draft never re-enter the pipeline, and an
// existing failed BullMQ job is never retried here.
func (s *Service) enqueueCrawlResultItem(ctx context.Context, orgID string, meta itemsreading.ItemMetaRow, prepared crawlPrepared) error {
	mongoRef := strings.TrimSpace(meta.MongoRef)
	if mongoRef == "" {
		return nil
	}
	switch meta.Status {
	case "pending", "processing", "failed":
	default:
		return nil
	}
	if s.enqueuer == nil {
		return NewFailure(500, "itemPipeline producer is not configured")
	}
	_, err := s.enqueuer.EnqueueItem(ctx, orgID, meta.ID, mongoRef, EnqueueOptions{
		Priority:      prepared.priority,
		TraceID:       httpx.TraceIDFromContext(ctx),
		PipelineJobID: prepared.pipelineJobID,
		SourceID:      prepared.sourceID,
	})
	return err
}

func toItemMetaName(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(utf16.Encode([]rune(trimmed))) <= 191 {
		return trimmed
	}
	units := utf16.Encode([]rune(trimmed))
	truncated := strings.TrimRightFunc(string(utf16.Decode(units[:190])), unicode.IsSpace)
	return truncated + "…"
}

func dedupeTrimmedCrawlResultIDs(preloaded []CrawlResultRow, ids []string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0)
	if len(preloaded) > 0 {
		for _, row := range preloaded {
			id := strings.TrimSpace(row.ID)
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
		return out
	}
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func orderedOutcomes(requestedIDs []string, outcomes map[string]CreateFromCrawlResultOutcome) []CreateFromCrawlResultOutcome {
	out := make([]CreateFromCrawlResultOutcome, 0, len(requestedIDs))
	for _, id := range requestedIDs {
		outcome, ok := outcomes[id]
		if !ok {
			outcome = CreateFromCrawlResultOutcome{CrawlResultID: id, Err: NewFailure(503, "Failed to ingest crawl result")}
		}
		out = append(out, outcome)
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func jsonObject(raw []byte) map[string]json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return nil
	}
	return object
}

func rawString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func optionalRawString(raw json.RawMessage) *string {
	value := rawString(raw)
	if value == "" {
		return nil
	}
	return &value
}

// toStringArray ports ItemsIngestService.toStringArray: strings are trimmed,
// numbers become their decimal form, everything else is dropped. Tags are not
// deduplicated.
func toStringArray(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var values []any
	if json.Unmarshal(raw, &values) != nil {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		switch typed := value.(type) {
		case string:
			trimmed := strings.TrimSpace(typed)
			if trimmed != "" {
				out = append(out, trimmed)
			}
		case float64:
			text := strings.TrimSpace(formatJSNumber(typed))
			if text != "" {
				out = append(out, text)
			}
		}
	}
	return out
}

func formatJSNumber(value float64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

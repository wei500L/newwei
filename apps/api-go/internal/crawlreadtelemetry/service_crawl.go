package crawlreadtelemetry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// defaultResultLimit mirrors `clampResultLimit(limit, fallback = 20)`: an absent
// detail limit falls back to 20 and an explicit limit is clamped into 1..100.
// The detail DTO already rejects values above 100, so the clamp is defensive.
const defaultResultLimit = 20

// crawlTaskListFilters is the validated GET /api/crawl-tasks query.
type crawlTaskListFilters struct {
	Page     int
	PageSize int
	Status   *CrawlTaskStatus
	Search   *string
}

// crawlTaskDetailFilters is the validated GET /api/crawl-tasks/:id query.
type crawlTaskDetailFilters struct {
	ResultLimit  int
	ResultSearch *string
}

// crawlTaskRow is one MySQL CrawlTask row joined with its result count.
type crawlTaskRow struct {
	ID                   string
	TargetURL            string
	DisplayName          sql.NullString
	Status               string
	KeywordsJSON         []byte
	Concurrency          int
	TimeRangeFrom        sql.NullTime
	TimeRangeTo          sql.NullTime
	LastRunAt            sql.NullTime
	LastSuccessAt        sql.NullTime
	LastResultAt         sql.NullTime
	LastCursor           sql.NullString
	LastError            sql.NullString
	RunCount             int
	CreatedAt            sql.NullTime
	UpdatedAt            sql.NullTime
	ConfigJSON           []byte
	LastServerMemoryMb   sql.NullFloat64
	LastPeakMemoryMb     sql.NullFloat64
	LastMemoryEfficiency sql.NullFloat64
	ResultCount          int
}

// crawlResultRow is one MySQL CrawlResult row.
type crawlResultRow struct {
	ID           string
	SourceURL    string
	FetchedAt    sql.NullTime
	MetadataJSON []byte
}

// crawlResultContentDoc is the Mongo crawlresultcontents document projection.
type crawlResultContentDoc struct {
	ResultID              string                  `bson:"resultId"`
	Markdown              string                  `bson:"markdown"`
	Metadata              RawJSON                 `bson:"metadata"`
	MarkdownWithCitations *string                 `bson:"markdownWithCitations"`
	ReferencesMarkdown    *string                 `bson:"referencesMarkdown"`
	FitMarkdown           *string                 `bson:"fitMarkdown"`
	LinkAnalysis          *CrawlLinkAnalysis      `bson:"linkAnalysis"`
	Media                 CrawlMediaCollection    `bson:"media"`
	MediaAssets           []CrawlStoredMediaAsset `bson:"mediaAssets"`
	Tables                []CrawlResultTable      `bson:"tables"`
}

// latestCompleteLogData is the data block of the newest "complete" task log.
type latestCompleteLogData struct {
	Inserted          *int              `bson:"inserted"`
	ItemsQueued       *int              `bson:"itemsQueued"`
	ItemsQueueFailed  *int              `bson:"itemsQueueFailed"`
	LastFetchedAt     *JSTime           `bson:"lastFetchedAt"`
	Memory            *CrawlMemoryStats `bson:"memory"`
	RetryableFailures *int              `bson:"retryableFailures"`
	ReusedResultID    *string           `bson:"reusedResultId"`
	RunID             *string           `bson:"runId"`
	Skipped           *int              `bson:"skipped"`
}

// latestCompleteLogDoc is the projected tasklogs document.
type latestCompleteLogDoc struct {
	Data *latestCompleteLogData `bson:"data"`
}

// itemMetaEntry is one ItemMeta projection (id and status).
type itemMetaEntry struct {
	id     string
	status string
}

// serveTaskList handles GET /api/crawl-tasks.
func (h *Handler) serveTaskList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	filters, err := parseCrawlTaskListFilters(r)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.listCrawlTasks(r.Context(), identity.OrgID, filters)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	body, marshalErr := json.Marshal(response)
	if marshalErr != nil {
		writeServiceError(w, r, marshalErr)
		return
	}
	writeJSONBody(w, http.StatusOK, body)
}

// serveTaskDetail handles GET /api/crawl-tasks/:id.
func (h *Handler) serveTaskDetail(w http.ResponseWriter, r *http.Request, taskID string) {
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	if taskID == "" {
		writeServiceError(w, r, newStatusError(http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path))
		return
	}
	filters, err := parseCrawlTaskDetailFilters(r)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.getCrawlTask(r.Context(), identity.OrgID, identity.UserID, taskID, filters)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	body, marshalErr := json.Marshal(response)
	if marshalErr != nil {
		writeServiceError(w, r, marshalErr)
		return
	}
	writeJSONBody(w, http.StatusOK, body)
}

// parseCrawlTaskListFilters reproduces the ListCrawlTaskDto ValidationPipe
// behaviour and its class-validator messages.
func parseCrawlTaskListFilters(r *http.Request) (crawlTaskListFilters, error) {
	filters := crawlTaskListFilters{Page: 1, PageSize: 10}
	problems := make([]string, 0, 2)

	if raw, present := querySingle(r, "page"); present {
		page, ok := jsNumber(raw)
		if !ok || page != math.Trunc(page) || math.IsInf(page, 0) {
			problems = append(problems, "page must be an integer number")
		} else if page < 1 {
			problems = append(problems, "page must not be less than 1")
		} else {
			filters.Page = int(page)
		}
	} else if r.URL.Query().Has("page") {
		problems = append(problems, "page must be an integer number")
	}

	if raw, present := querySingle(r, "pageSize"); present {
		pageSize, ok := jsNumber(raw)
		if !ok || pageSize != math.Trunc(pageSize) || math.IsInf(pageSize, 0) {
			problems = append(problems, "pageSize must be an integer number")
		} else if pageSize < 1 {
			problems = append(problems, "pageSize must not be less than 1")
		} else if pageSize > 50 {
			problems = append(problems, "pageSize must not be greater than 50")
		} else {
			filters.PageSize = int(pageSize)
		}
	} else if r.URL.Query().Has("pageSize") {
		problems = append(problems, "pageSize must be an integer number")
	}

	if raw, present := querySingle(r, "status"); present {
		if !isCrawlTaskStatus(raw) {
			problems = append(problems, "status must be a valid enum value")
		} else {
			status := CrawlTaskStatus(raw)
			filters.Status = &status
		}
	} else if r.URL.Query().Has("status") {
		problems = append(problems, "status must be a valid enum value")
	}

	if raw, present := querySingle(r, "search"); present {
		value := raw
		filters.Search = &value
	} else if r.URL.Query().Has("search") {
		problems = append(problems, "search must be a string")
	}

	if len(problems) > 0 {
		return filters, newStatusError(http.StatusBadRequest, strings.Join(problems, "; "))
	}
	return filters, nil
}

// parseCrawlTaskDetailFilters reproduces the CrawlTaskDetailQueryDto
// ValidationPipe behaviour.
func parseCrawlTaskDetailFilters(r *http.Request) (crawlTaskDetailFilters, error) {
	filters := crawlTaskDetailFilters{ResultLimit: defaultResultLimit}
	problems := make([]string, 0, 2)

	if raw, present := querySingle(r, "resultLimit"); present {
		limit, ok := jsNumber(raw)
		if !ok || limit != math.Trunc(limit) || math.IsInf(limit, 0) {
			problems = append(problems, "resultLimit must be an integer number")
		} else if limit < 1 {
			problems = append(problems, "resultLimit must not be less than 1")
		} else if limit > 100 {
			problems = append(problems, "resultLimit must not be greater than 100")
		} else {
			filters.ResultLimit = int(limit)
		}
	} else if r.URL.Query().Has("resultLimit") {
		problems = append(problems, "resultLimit must be an integer number")
	}

	if raw, present := querySingle(r, "resultSearch"); present {
		value := raw
		filters.ResultSearch = &value
	} else if r.URL.Query().Has("resultSearch") {
		problems = append(problems, "resultSearch must be a string")
	}

	if len(problems) > 0 {
		return filters, newStatusError(http.StatusBadRequest, strings.Join(problems, "; "))
	}
	return filters, nil
}

// jsNumber approximates the TypeScript Number(value) coercion used by
// class-transformer for query parameters.
func jsNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// nullableString turns an optional filter value into a SQL NULL parameter. The
// queries use "? IS NULL OR <predicate>" so a nil filter disables the predicate
// without building dynamic argument slices (which would need a weak []any).
func nullableString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

// listCrawlTasks mirrors CrawlTaskService.listTasks.
func (s *Service) listCrawlTasks(ctx context.Context, orgID string, filters crawlTaskListFilters) (CrawlTaskListResponse, error) {
	if s == nil || s.db == nil {
		return CrawlTaskListResponse{}, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	statusArg := sql.NullString{}
	if filters.Status != nil {
		statusArg = sql.NullString{String: string(*filters.Status), Valid: true}
	}
	var searchPattern *string
	if filters.Search != nil {
		pattern := "%" + *filters.Search + "%"
		searchPattern = &pattern
	}
	searchArg := nullableString(searchPattern)

	const whereClause = `t.orgId = ?
  AND (? IS NULL OR t.status = ?)
  AND (? IS NULL OR t.targetUrl LIKE ? OR t.displayName LIKE ?)`

	var total int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlTask t WHERE "+whereClause,
		orgID, statusArg, statusArg, searchArg, searchArg, searchArg,
	).Scan(&total); err != nil {
		return CrawlTaskListResponse{}, fmt.Errorf("%w: %v", errDatabase, err)
	}

	offset := (filters.Page - 1) * filters.PageSize
	rows, err := s.db.QueryContext(ctx, `
SELECT t.id, t.targetUrl, t.displayName, t.status, t.keywords, t.concurrency,
       t.timeRangeFrom, t.timeRangeTo, t.lastRunAt, t.lastSuccessAt, t.lastResultAt,
       t.lastCursor, t.lastError, t.runCount, t.createdAt, t.updatedAt, t.config,
       t.lastServerMemoryMb, t.lastPeakMemoryMb, t.lastMemoryEfficiency,
       (SELECT COUNT(*) FROM CrawlResult r WHERE r.taskId = t.id) AS resultCount
FROM CrawlTask t
WHERE `+whereClause+`
ORDER BY t.createdAt DESC
LIMIT ? OFFSET ?`,
		orgID, statusArg, statusArg, searchArg, searchArg, searchArg, filters.PageSize, offset)
	if err != nil {
		return CrawlTaskListResponse{}, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	tasks := make([]CrawlTaskView, 0, filters.PageSize)
	for rows.Next() {
		row, err := scanCrawlTaskRow(rows)
		if err != nil {
			return CrawlTaskListResponse{}, err
		}
		tasks = append(tasks, crawlTaskViewFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return CrawlTaskListResponse{}, fmt.Errorf("%w: %v", errDatabase, err)
	}

	return CrawlTaskListResponse{
		Tasks:    tasks,
		Total:    total,
		Page:     filters.Page,
		PageSize: filters.PageSize,
	}, nil
}

// scanCrawlTaskRow reads one CrawlTask projection row.
func scanCrawlTaskRow(rows *sql.Rows) (crawlTaskRow, error) {
	var row crawlTaskRow
	if err := rows.Scan(
		&row.ID, &row.TargetURL, &row.DisplayName, &row.Status, &row.KeywordsJSON,
		&row.Concurrency, &row.TimeRangeFrom, &row.TimeRangeTo, &row.LastRunAt,
		&row.LastSuccessAt, &row.LastResultAt, &row.LastCursor, &row.LastError,
		&row.RunCount, &row.CreatedAt, &row.UpdatedAt, &row.ConfigJSON,
		&row.LastServerMemoryMb, &row.LastPeakMemoryMb, &row.LastMemoryEfficiency,
		&row.ResultCount,
	); err != nil {
		return row, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return row, nil
}

// crawlTaskViewFromRow mirrors CrawlTaskService.toView. Memory stats and the
// last-run summary are intentionally absent here: the list controller does not
// populate them and JSON.stringify therefore omits the keys.
func crawlTaskViewFromRow(row crawlTaskRow) CrawlTaskView {
	view := CrawlTaskView{
		ID:                   row.ID,
		TargetURL:            row.TargetURL,
		DisplayName:          stringPtrFromNull(row.DisplayName),
		Status:               CrawlTaskStatus(row.Status),
		Keywords:             stringArrayFromJSON(row.KeywordsJSON),
		Concurrency:          row.Concurrency,
		TimeRangeFrom:        jsTimePtrFromNull(row.TimeRangeFrom),
		TimeRangeTo:          jsTimePtrFromNull(row.TimeRangeTo),
		LastRunAt:            jsTimePtrFromNull(row.LastRunAt),
		LastSuccessAt:        jsTimePtrFromNull(row.LastSuccessAt),
		LastResultAt:         jsTimePtrFromNull(row.LastResultAt),
		LastCursor:           stringPtrFromNull(row.LastCursor),
		LastError:            stringPtrFromNull(row.LastError),
		RunCount:             row.RunCount,
		ResultCount:          row.ResultCount,
		Config:               objectJSONOrNull(row.ConfigJSON),
		LastServerMemoryMb:   floatPtrFromNull(row.LastServerMemoryMb),
		LastPeakMemoryMb:     floatPtrFromNull(row.LastPeakMemoryMb),
		LastMemoryEfficiency: floatPtrFromNull(row.LastMemoryEfficiency),
	}
	if row.CreatedAt.Valid {
		view.CreatedAt = JSTime{Time: row.CreatedAt.Time}
	}
	if row.UpdatedAt.Valid {
		view.UpdatedAt = JSTime{Time: row.UpdatedAt.Time}
	}
	return view
}

// floatPtrFromNull converts a nullable SQL float into a JSON pointer.
func floatPtrFromNull(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	converted := value.Float64
	return &converted
}

// getCrawlTask mirrors CrawlTaskService.getTask.
func (s *Service) getCrawlTask(
	ctx context.Context,
	orgID, userID, taskID string,
	filters crawlTaskDetailFilters,
) (CrawlTaskDetailResponse, error) {
	if s == nil || s.db == nil {
		return CrawlTaskDetailResponse{}, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	var row crawlTaskRow
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.targetUrl, t.displayName, t.status, t.keywords, t.concurrency,
       t.timeRangeFrom, t.timeRangeTo, t.lastRunAt, t.lastSuccessAt, t.lastResultAt,
       t.lastCursor, t.lastError, t.runCount, t.createdAt, t.updatedAt, t.config,
       t.lastServerMemoryMb, t.lastPeakMemoryMb, t.lastMemoryEfficiency,
       (SELECT COUNT(*) FROM CrawlResult r WHERE r.taskId = t.id) AS resultCount
FROM CrawlTask t
WHERE t.id = ? AND t.orgId = ?`, taskID, orgID,
	).Scan(
		&row.ID, &row.TargetURL, &row.DisplayName, &row.Status, &row.KeywordsJSON,
		&row.Concurrency, &row.TimeRangeFrom, &row.TimeRangeTo, &row.LastRunAt,
		&row.LastSuccessAt, &row.LastResultAt, &row.LastCursor, &row.LastError,
		&row.RunCount, &row.CreatedAt, &row.UpdatedAt, &row.ConfigJSON,
		&row.LastServerMemoryMb, &row.LastPeakMemoryMb, &row.LastMemoryEfficiency,
		&row.ResultCount,
	)
	if errors.Is(err, sql.ErrNoRows) {
		// Lowercase message matches NestJS exactly ("crawl task not found").
		return CrawlTaskDetailResponse{}, newStatusError(http.StatusNotFound, "crawl task not found")
	}
	if err != nil {
		return CrawlTaskDetailResponse{}, fmt.Errorf("%w: %v", errDatabase, err)
	}

	results, err := s.listCrawlResults(ctx, taskID, filters)
	if err != nil {
		return CrawlTaskDetailResponse{}, err
	}

	hydrated, err := s.attachResultContent(ctx, orgID, userID, taskID, results)
	if err != nil {
		return CrawlTaskDetailResponse{}, err
	}

	itemMeta, err := s.lookupItemMeta(ctx, orgID, taskID)
	if err != nil {
		return CrawlTaskDetailResponse{}, err
	}
	for index := range hydrated {
		if meta, ok := itemMeta["crawlResult:"+hydrated[index].ID]; ok {
			id, status := meta.id, meta.status
			hydrated[index].ItemID = &id
			hydrated[index].ItemStatus = &status
		}
	}

	memoryStats, lastRunSummary, err := s.latestRunDetails(ctx, orgID, taskID)
	if err != nil {
		return CrawlTaskDetailResponse{}, err
	}

	view := crawlTaskViewFromRow(row)
	view.MemoryStats = memoryStats
	view.LastRunSummary = lastRunSummary
	task := crawlTaskDetailTask{CrawlTaskView: view, Results: hydrated}
	return CrawlTaskDetailResponse{Task: task}, nil
}

// listCrawlResults loads the crawl results of one task, newest first.
func (s *Service) listCrawlResults(ctx context.Context, taskID string, filters crawlTaskDetailFilters) ([]crawlResultRow, error) {
	// Prisma `contains` compiles to LIKE '%value%', so the wildcards are part
	// of the bound parameter.
	var searchPattern *string
	if filters.ResultSearch != nil {
		pattern := "%" + *filters.ResultSearch + "%"
		searchPattern = &pattern
	}
	searchArg := nullableString(searchPattern)
	rows, err := s.db.QueryContext(ctx, `
SELECT id, sourceUrl, fetchedAt, metadata
FROM CrawlResult
WHERE taskId = ? AND (? IS NULL OR sourceUrl LIKE ?)
ORDER BY fetchedAt DESC
LIMIT ?`, taskID, searchArg, searchArg, filters.ResultLimit)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	results := make([]crawlResultRow, 0, filters.ResultLimit)
	for rows.Next() {
		var row crawlResultRow
		if err := rows.Scan(&row.ID, &row.SourceURL, &row.FetchedAt, &row.MetadataJSON); err != nil {
			return nil, fmt.Errorf("%w: %v", errDatabase, err)
		}
		results = append(results, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return results, nil
}

// attachResultContent mirrors CrawlResultService.attachResultContent.
//
// The Mongo query filters crawlresultcontents by orgId as well as resultId.
// Documents written before the orgId field existed stay readable, while
// documents that explicitly belong to another organisation are excluded: this
// closes the cross-tenant content read.
func (s *Service) attachResultContent(
	ctx context.Context,
	orgID, userID, taskID string,
	results []crawlResultRow,
) ([]CrawlTaskResult, error) {
	if len(results) == 0 {
		return []CrawlTaskResult{}, nil
	}
	if s.crawlResultContents == nil {
		return nil, fmt.Errorf("%w: mongo is not configured", errMongo)
	}
	resultIDs := make([]string, 0, len(results))
	for _, result := range results {
		resultIDs = append(resultIDs, result.ID)
	}

	contents := make(map[string]crawlResultContentDoc, len(results))
	// $or keeps legacy documents without an orgId readable while blocking
	// documents that explicitly belong to a different organisation.
	orgMatch := []bson.D{
		{{Key: "orgId", Value: orgID}},
		{{Key: "orgId", Value: bson.D{{Key: "$exists", Value: false}}}},
	}
	filter := bson.D{
		{Key: "resultId", Value: bson.D{{Key: "$in", Value: resultIDs}}},
		{Key: "$or", Value: orgMatch},
	}
	cursor, err := s.crawlResultContents.Find(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	defer cursor.Close(ctx)
	var documents []crawlResultContentDoc
	if err := cursor.All(ctx, &documents); err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	for _, document := range documents {
		contents[document.ResultID] = document
	}

	// One storage configuration snapshot per detail request: the TTL and the S3
	// signing capability are resolved once and reused by every asset, instead of
	// re-reading the nine settings per asset or per mode.
	ttlSeconds, storageClient := s.storageSigningContext(ctx)
	assetsByResult, err := s.listAssetsForTask(ctx, orgID, userID, taskID, resultIDs, ttlSeconds, storageClient)
	if err != nil {
		return nil, err
	}

	hydrated := make([]CrawlTaskResult, 0, len(results))
	for _, result := range results {
		document := contents[result.ID]
		metadata := RawJSON(result.MetadataJSON)
		if metadata.IsEmpty() {
			metadata = document.Metadata
		}
		hydratedResult := CrawlTaskResult{
			ID:                    result.ID,
			SourceURL:             result.SourceURL,
			Markdown:              document.Markdown,
			Metadata:              metadata,
			MarkdownWithCitations: nonEmptyString(document.MarkdownWithCitations),
			ReferencesMarkdown:    nonEmptyString(document.ReferencesMarkdown),
			FitMarkdown:           nonEmptyString(document.FitMarkdown),
			LinkAnalysis:          document.LinkAnalysis,
			Media:                 document.Media,
			Tables:                document.Tables,
		}
		if result.FetchedAt.Valid {
			hydratedResult.FetchedAt = JSTime{Time: result.FetchedAt.Time}
		}
		if assets, ok := assetsByResult[result.ID]; ok {
			hydratedResult.MediaAssets = assets
		} else {
			hydratedResult.MediaAssets = document.MediaAssets
		}
		hydrated = append(hydrated, hydratedResult)
	}
	return hydrated, nil
}

// nonEmptyString mirrors ensureString: only a non-empty string survives, so the
// key is omitted from the JSON when the value is absent or empty.
func nonEmptyString(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

// lookupItemMeta loads the ItemMeta rows linked to the crawl results of a task.
// The join reproduces the externalId IN ("crawlResult:<id>") filter while
// keeping orgId scoping.
func (s *Service) lookupItemMeta(ctx context.Context, orgID, taskID string) (map[string]itemMetaEntry, error) {
	out := make(map[string]itemMetaEntry)
	rows, err := s.db.QueryContext(ctx, `
SELECT m.externalId, m.id, m.status
FROM ItemMeta m
JOIN CrawlResult r ON m.externalId = CONCAT('crawlResult:', r.id)
WHERE m.orgId = ? AND r.taskId = ?`, orgID, taskID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()
	for rows.Next() {
		var externalID string
		var entry itemMetaEntry
		if err := rows.Scan(&externalID, &entry.id, &entry.status); err != nil {
			return nil, fmt.Errorf("%w: %v", errDatabase, err)
		}
		out[externalID] = entry
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return out, nil
}

// latestRunDetails mirrors getLatestRunDetails: the newest "complete" task log
// provides the memory stats and the execution summary.
func (s *Service) latestRunDetails(ctx context.Context, orgID, taskID string) (*CrawlMemoryStats, *CrawlExecutionSummary, error) {
	if s.taskLogs == nil {
		return nil, nil, fmt.Errorf("%w: mongo is not configured", errMongo)
	}
	projection := bson.D{
		{Key: "_id", Value: 0},
		{Key: "data.inserted", Value: 1},
		{Key: "data.itemsQueued", Value: 1},
		{Key: "data.itemsQueueFailed", Value: 1},
		{Key: "data.lastFetchedAt", Value: 1},
		{Key: "data.memory", Value: 1},
		{Key: "data.retryableFailures", Value: 1},
		{Key: "data.reusedResultId", Value: 1},
		{Key: "data.runId", Value: 1},
		{Key: "data.skipped", Value: 1},
	}
	filter := bson.D{
		{Key: "queue", Value: crawlQueueName},
		{Key: "jobId", Value: taskID},
		{Key: "orgId", Value: orgID},
		{Key: "stage", Value: "complete"},
	}
	var document latestCompleteLogDoc
	err := s.taskLogs.FindOne(ctx, filter, options.FindOne().
		SetProjection(projection).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}),
	).Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	data := document.Data
	if data == nil {
		return nil, nil, nil
	}
	return data.Memory, buildExecutionSummary(data), nil
}

// buildExecutionSummary mirrors toLatestExecutionSummary: inserted and skipped
// are mandatory, every other field is optional.
func buildExecutionSummary(data *latestCompleteLogData) *CrawlExecutionSummary {
	if data == nil || data.Inserted == nil || data.Skipped == nil {
		return nil
	}
	summary := &CrawlExecutionSummary{
		Inserted: *data.Inserted,
		Skipped:  *data.Skipped,
	}
	if data.ItemsQueued != nil {
		summary.ItemsQueued = data.ItemsQueued
	}
	if data.ItemsQueueFailed != nil {
		summary.ItemsQueueFailed = data.ItemsQueueFailed
	}
	if data.LastFetchedAt != nil {
		summary.LastFetchedAt = data.LastFetchedAt
	}
	if data.RunID != nil {
		summary.RunID = data.RunID
	}
	if data.ReusedResultID != nil && strings.TrimSpace(*data.ReusedResultID) != "" {
		trimmed := strings.TrimSpace(*data.ReusedResultID)
		summary.ReusedResultID = &trimmed
	}
	if data.RetryableFailures != nil {
		summary.RetryableFailures = data.RetryableFailures
	}
	return summary
}

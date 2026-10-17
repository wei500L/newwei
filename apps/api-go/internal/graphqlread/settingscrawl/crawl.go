package settingscrawl

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// crawlReadTakeLimit is the crawlTasks page-size ceiling: NestJS computes
// take = Math.min(first, 50).
const crawlReadTakeLimit = 50

// crawlReadResultLimitMin is the lower bound of clampResultLimit, the GraphQL
// detail clamp max(1, min(100, resultLimit)).
const crawlReadResultLimitMin = 1

// crawlReadResultLimitMax is the upper bound of clampResultLimit.
const crawlReadResultLimitMax = 100

// crawlTaskNotFoundMessage is the exact NestJS NotFoundException message
// raised when a task id does not resolve inside the caller's organization.
const crawlTaskNotFoundMessage = "crawl task not found"

// crawlTaskFilterClause is the org-scoped filter shared by the crawlTasks COUNT
// and page queries. The nullable parameters mirror the REST list query: a NULL
// status or search argument disables that predicate, so no dynamic argument
// slice is ever built.
const crawlTaskFilterClause = `t.orgId = ?
  AND (? IS NULL OR t.status = ?)
  AND (? IS NULL OR t.targetUrl LIKE ? OR t.displayName LIKE ?)`

// crawlTaskCursorClause is the keyset predicate equivalent to Prisma
// `cursor: { id }, skip: 1`: the anchor row itself is excluded and only rows
// strictly after it in (createdAt DESC, id DESC) order remain eligible.
const crawlTaskCursorClause = " AND (t.createdAt < ? OR (t.createdAt = ? AND t.id < ?))"

// crawlTaskOrderClause is the deterministic order Prisma applies, with id DESC
// as the tie-breaker for rows that share a createdAt, plus the lookahead LIMIT.
const crawlTaskOrderClause = " ORDER BY t.createdAt DESC, t.id DESC LIMIT ?"

// crawlReader serves the crawlTasks and crawlTask roots. svc is the shared
// crawl read service built in register.go; s carries the same MySQL handle for
// the keyset pagination that the REST list endpoint does not implement.
type crawlReader struct {
	s   *store
	svc *crawlreadtelemetry.Service
}

// crawlTaskCursor is the resolved ordering position of an after cursor.
type crawlTaskCursor struct {
	CreatedAt time.Time
	ID        string
}

// encodeCursor renders a task id as a connection cursor: standard base64 of the
// raw id bytes, exactly Buffer.from(value, "utf8").toString("base64").
func encodeCursor(id string) string {
	return base64.StdEncoding.EncodeToString([]byte(id))
}

// decodeCursor mirrors Node's lenient Buffer.from(cursor, "base64").toString():
// surrounding whitespace is stripped, the URL-safe alphabet is accepted,
// padding may be missing or over-long and every non-alphabet byte is dropped.
// An undecodable value returns "" so the caller treats it as a stale cursor
// instead of failing the whole query with a strict decoder error.
func decodeCursor(cursor string) string {
	trimmed := strings.TrimSpace(cursor)
	if trimmed == "" {
		return ""
	}
	decoded := make([]byte, 0, len(trimmed)*3/4)
	var accumulator uint32
	bits := 0
	for _, character := range trimmed {
		if character == '=' {
			// Node stops decoding at the first padding character; the bits
			// accumulated so far can no longer complete a byte.
			break
		}
		value, ok := base64CharacterValue(character)
		if !ok {
			// Invalid characters are ignored, never fatal.
			continue
		}
		accumulator = accumulator<<6 | uint32(value)
		bits += 6
		if bits >= 8 {
			bits -= 8
			decoded = append(decoded, byte(accumulator>>uint(bits)))
		}
	}
	return string(decoded)
}

// base64CharacterValue maps one base64 alphabet character to its six-bit value,
// accepting both the standard and the URL-safe alphabet.
func base64CharacterValue(character rune) (byte, bool) {
	switch {
	case character >= 'A' && character <= 'Z':
		return byte(character - 'A'), true
	case character >= 'a' && character <= 'z':
		return byte(character - 'a' + 26), true
	case character >= '0' && character <= '9':
		return byte(character - '0' + 52), true
	case character == '+', character == '-':
		return 62, true
	case character == '/', character == '_':
		return 63, true
	default:
		return 0, false
	}
}

// crawlTasks implements the crawlTasks root: an org-scoped keyset page of crawl
// tasks ordered by createdAt DESC, id DESC. The registry enforces crawl.read,
// so no permission check happens here.
func (r *crawlReader) crawlTasks(
	ctx context.Context,
	identity contract.Identity,
	first int,
	after *string,
	search *string,
	status *string,
) (CrawlTaskConnection, error) {
	if first < 1 {
		// class-validator @Min(1) rejects first < 1 before the query runs.
		return CrawlTaskConnection{}, badRequest("first must not be less than 1")
	}
	take := first
	if take > crawlReadTakeLimit {
		take = crawlReadTakeLimit
	}
	statusArg, searchArg := crawlTaskFilterArgs(status, search)

	// COUNT(*) over the filtered organization is cursor-independent, so it is
	// computed once and reported on every exit path, including stale cursors.
	total, err := r.countCrawlTasks(ctx, identity.OrgID, statusArg, searchArg)
	if err != nil {
		return CrawlTaskConnection{}, err
	}

	cursorRequested := after != nil && *after != ""
	var cursor *crawlTaskCursor
	if cursorRequested {
		// A cursor that decodes to the empty string is falsy in NestJS, so the
		// query runs as an ordinary first page with no anchor. Only a non-empty
		// decoded id is resolved against the organization.
		if cursorID := decodeCursor(*after); cursorID != "" {
			resolved, locateErr := r.locateCrawlTaskCursor(ctx, identity.OrgID, cursorID)
			if locateErr != nil {
				return CrawlTaskConnection{}, locateErr
			}
			if resolved == nil {
				// DEFECT FIX: Prisma would raise an uncaught P2025 for a
				// deleted, forged or cross-organization cursor id and fail the
				// whole crawlTasks field with a 500. The Go reader instead
				// returns the empty connection envelope with the filtered
				// total, so the client sees edges: [], hasNextPage: false and
				// data.crawlTasks.
				return crawlEmptyConnection(total), nil
			}
			cursor = resolved
		}
	}

	views, err := r.queryCrawlTaskPage(ctx, identity.OrgID, statusArg, searchArg, cursor, take+1)
	if err != nil {
		return CrawlTaskConnection{}, err
	}

	// The extra row fetched above is the lookahead: its presence means a next
	// page exists, and it is sliced back off before the edges are built.
	hasNextPage := len(views) > take
	nodes := views
	if hasNextPage {
		nodes = views[:take]
	}
	edges := make([]CrawlTaskEdge, 0, len(nodes))
	for _, view := range nodes {
		edges = append(edges, CrawlTaskEdge{
			Cursor: encodeCursor(view.ID),
			Node:   crawlTaskModelFromView(view),
		})
	}
	var endCursor *string
	if len(edges) > 0 {
		last := edges[len(edges)-1].Cursor
		endCursor = &last
	}
	return CrawlTaskConnection{
		Edges:      edges,
		PageInfo:   PageInfo{HasNextPage: hasNextPage, EndCursor: endCursor},
		TotalCount: float64(total),
	}, nil
}

// crawlEmptyConnection is the connection envelope returned for an unresolvable
// after cursor: no edges, no next page and the cursor-independent filtered
// total.
func crawlEmptyConnection(total int) CrawlTaskConnection {
	return CrawlTaskConnection{
		Edges:      []CrawlTaskEdge{},
		PageInfo:   PageInfo{HasNextPage: false, EndCursor: nil},
		TotalCount: float64(total),
	}
}

// crawlTaskFilterArgs converts the optional GraphQL status and search arguments
// into nullable SQL parameters. An empty string is falsy in NestJS, so it
// contributes no predicate; search is wrapped in the LIKE wildcards Prisma
// `contains` compiles to.
func crawlTaskFilterArgs(status *string, search *string) (sql.NullString, sql.NullString) {
	statusArg := sql.NullString{}
	if status != nil && *status != "" {
		statusArg = sql.NullString{String: *status, Valid: true}
	}
	searchArg := sql.NullString{}
	if search != nil && *search != "" {
		searchArg = sql.NullString{String: "%" + *search + "%", Valid: true}
	}
	return statusArg, searchArg
}

// countCrawlTasks runs COUNT(*) over the same filter as the page query so that
// totalCount stays cursor-independent.
func (r *crawlReader) countCrawlTasks(ctx context.Context, orgID string, statusArg, searchArg sql.NullString) (int, error) {
	if r == nil || r.s == nil || r.s.db == nil {
		return 0, crawlInternalFailure()
	}
	var total int
	err := r.s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM CrawlTask t WHERE "+crawlTaskFilterClause,
		orgID, statusArg, statusArg, searchArg, searchArg, searchArg,
	).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total, nil
}

// locateCrawlTaskCursor resolves the decoded cursor id to its (createdAt, id)
// ordering key. The lookup is scoped by id and orgId ONLY: status and search
// must not filter the anchor, because Prisma resolves the cursor row
// independently of the page filter. A missing row reports nil so the caller can
// render the empty envelope instead of failing.
func (r *crawlReader) locateCrawlTaskCursor(ctx context.Context, orgID, cursorID string) (*crawlTaskCursor, error) {
	if r == nil || r.s == nil || r.s.db == nil {
		return nil, crawlInternalFailure()
	}
	var createdAt sql.NullTime
	var id string
	err := r.s.db.QueryRowContext(ctx,
		"SELECT t.createdAt, t.id FROM CrawlTask t WHERE t.id = ? AND t.orgId = ? LIMIT 1",
		cursorID, orgID,
	).Scan(&createdAt, &id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cursor := crawlTaskCursor{ID: id}
	if createdAt.Valid {
		cursor.CreatedAt = createdAt.Time
	}
	return &cursor, nil
}

// queryCrawlTaskPage fetches the keyset page; limit is the lookahead size
// (take + 1). The argument combination is passed explicitly in both branches,
// so the query arguments stay strongly typed and no dynamic slice is built.
func (r *crawlReader) queryCrawlTaskPage(
	ctx context.Context,
	orgID string,
	statusArg, searchArg sql.NullString,
	cursor *crawlTaskCursor,
	limit int,
) ([]crawlreadtelemetry.CrawlTaskView, error) {
	if r == nil || r.s == nil || r.s.db == nil {
		return nil, crawlInternalFailure()
	}
	query := crawlreadtelemetry.CrawlTaskViewSelectSQL + " WHERE " + crawlTaskFilterClause
	var rows *sql.Rows
	var err error
	if cursor != nil {
		query += crawlTaskCursorClause + crawlTaskOrderClause
		rows, err = r.s.db.QueryContext(ctx, query,
			orgID, statusArg, statusArg, searchArg, searchArg, searchArg,
			cursor.CreatedAt, cursor.CreatedAt, cursor.ID, limit)
	} else {
		query += crawlTaskOrderClause
		rows, err = r.s.db.QueryContext(ctx, query,
			orgID, statusArg, statusArg, searchArg, searchArg, searchArg, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return crawlreadtelemetry.ScanCrawlTaskViews(rows)
}

// crawlTask implements the crawlTask root. The root is nullable, so a task id
// that is absent from the caller's organization returns the NestJS
// NotFoundException shape: data.crawlTask is null and the field error carries
// NOT_FOUND with HTTP 404. The registry enforces crawl.read.
func (r *crawlReader) crawlTask(
	ctx context.Context,
	identity contract.Identity,
	id string,
	resultLimit int,
	resultSearch *string,
) (*CrawlTaskModel, error) {
	if r == nil || r.svc == nil {
		return nil, crawlInternalFailure()
	}
	found, err := r.crawlTaskExists(ctx, identity.OrgID, id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, crawlTaskNotFoundFailure()
	}
	// GraphQL clamps resultLimit with clampResultLimit — max(1, min(100, n)) —
	// unlike the REST DTO, which rejects a value above 100 at validation.
	limit := resultLimit
	if limit < crawlReadResultLimitMin {
		limit = crawlReadResultLimitMin
	}
	if limit > crawlReadResultLimitMax {
		limit = crawlReadResultLimitMax
	}
	search := ""
	if resultSearch != nil {
		search = *resultSearch
	}
	detail, err := r.svc.CrawlTaskDetailForGraphQL(ctx, identity.OrgID, identity.UserID, id, limit, search)
	if err != nil {
		// A concurrent delete between the existence probe and the detail read
		// still has to produce the same 404 shape, never a 500.
		if err.Error() == crawlTaskNotFoundMessage {
			return nil, crawlTaskNotFoundFailure()
		}
		return nil, err
	}
	model := crawlTaskModelFromDetail(detail)
	return &model, nil
}

// crawlTaskExists reports whether the id resolves to a task of the caller's
// organization. A cross-organization id and a deleted id both report false,
// which the root maps to the NestJS NotFoundException.
func (r *crawlReader) crawlTaskExists(ctx context.Context, orgID, taskID string) (bool, error) {
	if r == nil || r.s == nil || r.s.db == nil {
		return false, crawlInternalFailure()
	}
	var probe int
	err := r.s.db.QueryRowContext(ctx,
		"SELECT 1 FROM CrawlTask t WHERE t.id = ? AND t.orgId = ? LIMIT 1",
		taskID, orgID,
	).Scan(&probe)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// crawlTaskNotFoundFailure is the plain NotFoundException shape: HTTP 404, the
// lowercase NestJS message and no appCode.
func crawlTaskNotFoundFailure() error {
	return &contract.Failure{Message: crawlTaskNotFoundMessage, Status: http.StatusNotFound}
}

// crawlInternalFailure is the GraphQL internal error for a missing database
// handle or an unexpected query failure.
func crawlInternalFailure() error {
	return &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
}

// crawlTaskModelFromView maps the toView projection into the GraphQL task. In
// list mode results, memory stats and the last-run summary are unset, so those
// nullable GraphQL fields project null exactly like toGraphTask on an
// unpopulated view.
func crawlTaskModelFromView(view crawlreadtelemetry.CrawlTaskView) CrawlTaskModel {
	keywords := view.Keywords
	if keywords == nil {
		keywords = []string{}
	}
	return CrawlTaskModel{
		ID:                   view.ID,
		TargetURL:            view.TargetURL,
		DisplayName:          view.DisplayName,
		Status:               crawlStatusConstant(view.Status),
		Keywords:             keywords,
		Concurrency:          float64(view.Concurrency),
		TimeRangeFrom:        crawlTimeFromJS(view.TimeRangeFrom),
		TimeRangeTo:          crawlTimeFromJS(view.TimeRangeTo),
		LastRunAt:            crawlTimeFromJS(view.LastRunAt),
		LastSuccessAt:        crawlTimeFromJS(view.LastSuccessAt),
		LastResultAt:         crawlTimeFromJS(view.LastResultAt),
		LastCursor:           view.LastCursor,
		LastError:            view.LastError,
		RunCount:             float64(view.RunCount),
		CreatedAt:            view.CreatedAt.Time,
		UpdatedAt:            view.UpdatedAt.Time,
		ResultCount:          float64(view.ResultCount),
		Config:               jsonTextFromRaw(view.Config),
		MemoryStats:          crawlMemoryStatsModel(view.MemoryStats),
		LastRunSummary:       crawlExecutionSummaryModel(view.LastRunSummary),
		LastServerMemoryMb:   view.LastServerMemoryMb,
		LastPeakMemoryMb:     view.LastPeakMemoryMb,
		LastMemoryEfficiency: view.LastMemoryEfficiency,
	}
}

// crawlTaskModelFromDetail maps the reused REST detail envelope into the
// GraphQL task: the toView projection plus the hydrated results. The results
// slice is always non-nil here, so a task without result rows projects the
// non-null empty list the NestJS detail resolver returns; only list mode leaves
// the nullable GraphQL list unset, which projects null.
func crawlTaskModelFromDetail(detail crawlreadtelemetry.CrawlTaskDetailResponse) CrawlTaskModel {
	model := crawlTaskModelFromView(detail.Task.CrawlTaskView)
	results := make([]CrawlResultModel, 0, len(detail.Task.Results))
	for _, result := range detail.Task.Results {
		results = append(results, crawlResultModelFromResult(result))
	}
	model.Results = results
	return model
}

// crawlResultModelFromResult maps one hydrated crawl result onto the GraphQL
// model. The schema-less metadata/media/mediaAssets values are rendered as the
// JSON text JSON.stringify produces, and tables becomes the JSON scalar.
func crawlResultModelFromResult(result crawlreadtelemetry.CrawlTaskResult) CrawlResultModel {
	return CrawlResultModel{
		ID:                    result.ID,
		SourceURL:             result.SourceURL,
		FetchedAt:             result.FetchedAt.Time,
		ItemID:                result.ItemID,
		ItemStatus:            result.ItemStatus,
		Markdown:              result.Markdown,
		Metadata:              jsonTextFromRaw(result.Metadata),
		Media:                 jsonTextFromMedia(result.Media),
		MediaAssets:           jsonTextFromMediaAssets(result.MediaAssets),
		MarkdownWithCitations: result.MarkdownWithCitations,
		ReferencesMarkdown:    result.ReferencesMarkdown,
		FitMarkdown:           result.FitMarkdown,
		LinkAnalysis:          crawlLinkAnalysisModel(result.LinkAnalysis),
		Tables:                crawlTablesScalar(result.Tables),
	}
}

// jsonTextFromRaw renders a stored raw JSON value as the compact JSON text
// JSON.stringify would produce for config or metadata. An absent payload and
// the JSON literal null stay nil (GraphQL null), while a present empty object
// renders "{}", never null.
func jsonTextFromRaw(raw []byte) *string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	// JSON.stringify never escapes "&", "<" or ">", so HTML escaping is off.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(json.RawMessage([]byte(trimmed))); err != nil {
		return nil
	}
	text := strings.TrimSuffix(builder.String(), "\n")
	return &text
}

// jsonTextFromMedia renders a present media collection as the compact JSON text
// JSON.stringify produces. A missing collection stays nil (GraphQL null), while
// a present empty collection renders "{}".
func jsonTextFromMedia(media crawlreadtelemetry.CrawlMediaCollection) *string {
	if media == nil {
		return nil
	}
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(media); err != nil {
		return nil
	}
	text := strings.TrimSuffix(builder.String(), "\n")
	return &text
}

// jsonTextFromMediaAssets renders the signed assets of one result as the
// compact JSON text JSON.stringify produces. An absent asset list stays nil
// (GraphQL null), while a present empty list renders "[]".
func jsonTextFromMediaAssets(assets []crawlreadtelemetry.CrawlStoredMediaAsset) *string {
	if assets == nil {
		return nil
	}
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(assets); err != nil {
		return nil
	}
	text := strings.TrimSuffix(builder.String(), "\n")
	return &text
}

// crawlTablesScalar renders the stored tables of one result as the GraphQL JSON
// scalar. An absent table list stays nil, so the scalar projects null.
func crawlTablesScalar(tables []crawlreadtelemetry.CrawlResultTable) *json.RawMessage {
	if tables == nil {
		return nil
	}
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(tables); err != nil {
		return nil
	}
	return jsonScalar([]byte(strings.TrimSuffix(builder.String(), "\n")))
}

// crawlLinkAnalysisModel maps the stored link analysis onto the GraphQL model;
// an absent analysis stays nil so the nullable field projects null.
func crawlLinkAnalysisModel(analysis *crawlreadtelemetry.CrawlLinkAnalysis) *CrawlLinkAnalysisModel {
	if analysis == nil {
		return nil
	}
	return &CrawlLinkAnalysisModel{
		Stats: CrawlLinkStatsModel{
			TotalLinks:            float64(analysis.Stats.TotalLinks),
			InternalLinks:         float64(analysis.Stats.InternalLinks),
			ExternalLinks:         float64(analysis.Stats.ExternalLinks),
			AverageIntrinsicScore: analysis.Stats.AverageIntrinsicScore,
			HighQualityLinks:      crawlFloatFromInt(analysis.Stats.HighQualityLinks),
			LowQualityLinks:       crawlFloatFromInt(analysis.Stats.LowQualityLinks),
		},
		Buckets:         crawlLinkBuckets(analysis.Buckets),
		TopLinks:        crawlLinks(analysis.TopLinks),
		LowQualityLinks: crawlLinks(analysis.LowQualityLinks),
	}
}

// crawlLinkBuckets maps the stored link buckets. The returned slice is never
// nil because the GraphQL list is non-null.
func crawlLinkBuckets(buckets []crawlreadtelemetry.CrawlLinkAnalysisBucket) []CrawlLinkBucketModel {
	out := make([]CrawlLinkBucketModel, 0, len(buckets))
	for _, bucket := range buckets {
		out = append(out, CrawlLinkBucketModel{
			Kind:  bucket.Kind,
			Links: crawlLinks(bucket.Links),
		})
	}
	return out
}

// crawlLinks maps stored analysed links. The returned slice is never nil
// because the GraphQL lists are non-null.
func crawlLinks(links []crawlreadtelemetry.CrawlLinkAnalysisLink) []CrawlLinkModel {
	out := make([]CrawlLinkModel, 0, len(links))
	for _, link := range links {
		out = append(out, CrawlLinkModel{
			Href:            link.Href,
			Text:            link.Text,
			Title:           link.Title,
			BaseDomain:      link.BaseDomain,
			Rel:             link.Rel,
			Type:            link.Type,
			IntrinsicScore:  link.IntrinsicScore,
			ContextualScore: link.ContextualScore,
			TotalScore:      link.TotalScore,
		})
	}
	return out
}

// crawlMemoryStatsModel maps the latest run memory block; an absent block stays
// nil so the nullable field projects null.
func crawlMemoryStatsModel(stats *crawlreadtelemetry.CrawlMemoryStats) *CrawlMemoryStatsModel {
	if stats == nil {
		return nil
	}
	return &CrawlMemoryStatsModel{
		ServerMemoryMb:    stats.ServerMemoryMb,
		PeakMemoryMb:      stats.PeakMemoryMb,
		EfficiencyPercent: stats.EfficiencyPercent,
	}
}

// crawlExecutionSummaryModel maps the latest run summary. reusedResultId and
// memory are intentionally dropped, exactly like toExecutionSummary.
func crawlExecutionSummaryModel(summary *crawlreadtelemetry.CrawlExecutionSummary) *CrawlExecutionSummaryModel {
	if summary == nil {
		return nil
	}
	return &CrawlExecutionSummaryModel{
		Inserted:          float64(summary.Inserted),
		Skipped:           float64(summary.Skipped),
		ItemsQueued:       crawlFloatFromInt(summary.ItemsQueued),
		ItemsQueueFailed:  crawlFloatFromInt(summary.ItemsQueueFailed),
		LastFetchedAt:     crawlTimeFromJS(summary.LastFetchedAt),
		RunID:             summary.RunID,
		RetryableFailures: crawlFloatFromInt(summary.RetryableFailures),
	}
}

// crawlStatusConstant maps a stored status onto the SDL enum. A NULL or unknown
// stored value is defensive: it projects the pending member rather than an
// invalid enum value.
func crawlStatusConstant(status crawlreadtelemetry.CrawlTaskStatus) CrawlTaskStatus {
	switch status {
	case crawlreadtelemetry.CrawlTaskStatusPending:
		return CrawlTaskStatusPending
	case crawlreadtelemetry.CrawlTaskStatusQueued:
		return CrawlTaskStatusQueued
	case crawlreadtelemetry.CrawlTaskStatusRunning:
		return CrawlTaskStatusRunning
	case crawlreadtelemetry.CrawlTaskStatusCompleted:
		return CrawlTaskStatusCompleted
	case crawlreadtelemetry.CrawlTaskStatusFailed:
		return CrawlTaskStatusFailed
	case crawlreadtelemetry.CrawlTaskStatusPaused:
		return CrawlTaskStatusPaused
	default:
		return CrawlTaskStatusPending
	}
}

// crawlTimeFromJS converts an optional JSTime into the GraphQL DateTime
// pointer, keeping nil (GraphQL null) for an absent timestamp.
func crawlTimeFromJS(value *crawlreadtelemetry.JSTime) *time.Time {
	if value == nil {
		return nil
	}
	converted := value.Time
	return &converted
}

// crawlFloatFromInt converts an optional int (an execution counter) into the
// GraphQL Float pointer the SDL uses.
func crawlFloatFromInt(value *int) *float64 {
	if value == nil {
		return nil
	}
	converted := float64(*value)
	return &converted
}

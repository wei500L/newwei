package crawlfrontierruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// Service carries the SQL reads and the cancellation transaction. The handler
// only performs routing, authentication and DTO validation.
type Service struct {
	db *sql.DB
}

// NewService builds a Service around the shared MySQL pool.
func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// errRunMissing is returned for both an absent run and a cross-tenant run so
// the two cases produce the same 404.
var errRunMissing = newStatus(404, "Crawl frontier run not found")

// profileColumns is the CrawlSiteProfile projection in Prisma schema order.
const profileColumns = "id, orgId, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId, workflowBindingMode, version, config, createdById, updatedById, publishedAt, createdAt, updatedAt"

// ListRuns mirrors listRuns: org-scoped SQL filters (search uses Prisma
// contains semantics, i.e. a LIKE pattern where "%" and "_" keep their wildcard
// meaning), newest first, then the in-memory run_role/failure_kind/warning_flag/
// seed_strategy filters.
func (s *Service) ListRuns(ctx context.Context, orgID string, query listQuery) (runListDocument, error) {
	search := query.Search
	var searchPattern *string
	if search != nil {
		trimmed := strings.TrimSpace(*search)
		if trimmed != "" {
			pattern := likeContains(trimmed)
			searchPattern = &pattern
		}
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT `+runColumnsWithAlias("r")+`,
       p.id, p.name, p.matchHost, p.executionMode, p.version
FROM CrawlFrontierRun r
LEFT JOIN CrawlSiteProfile p ON p.id = r.profileId
WHERE r.orgId = ?
  AND (? IS NULL OR (r.seedUrl LIKE ? OR r.nativeRunId LIKE ?))
  AND (? IS NULL OR r.profileId = ?)
  AND (? IS NULL OR r.status = ?)
  AND (? IS NULL OR r.executionMode = ?)
ORDER BY r.createdAt DESC`,
		orgID,
		searchPattern, searchPattern, searchPattern,
		query.ProfileID, query.ProfileID,
		query.Status, query.Status,
		query.ExecutionMode, query.ExecutionMode,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := runListDocument{}
	for rows.Next() {
		item, err := scanRunListRow(rows)
		if err != nil {
			return nil, err
		}
		if !matchesRunQueryFilters(item, query) {
			continue
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// runColumnsWithAlias prefixes the run projection with a table alias.
func runColumnsWithAlias(alias string) string {
	columns := strings.Split(runColumns, ", ")
	for index, column := range columns {
		columns[index] = alias + "." + column
	}
	return strings.Join(columns, ", ")
}

// scanRunListRow scans one joined run/profile list row.
func scanRunListRow(rows *sql.Rows) (runListItem, error) {
	var fields runFields
	var profileID, workflowRunID, crawlTaskID, nativeRunID, lastError sql.NullString
	var keywords, metadata []byte
	var startedAt, finishedAt sql.NullTime
	var createdAt, updatedAt sql.NullTime
	var profileIDJoin, profileName, profileMatchHost, profileExecutionMode sql.NullString
	var profileVersion sql.NullInt64
	err := rows.Scan(
		&fields.ID, &fields.OrgID, &profileID, &workflowRunID, &fields.SeedURL, &crawlTaskID,
		&fields.ExecutionMode, &fields.Status, &fields.MaxDepth, &fields.MaxPages, &keywords,
		&fields.PageCount, &fields.NodeCount, &fields.ArticleCount, &fields.FailedCount,
		&fields.DuplicateCount, &nativeRunID, &lastError, &metadata, &fields.CreatedByID,
		&startedAt, &finishedAt, &createdAt, &updatedAt,
		&profileIDJoin, &profileName, &profileMatchHost, &profileExecutionMode, &profileVersion,
	)
	if err != nil {
		return runListItem{}, err
	}
	fields.ProfileID = nullStringPtr(profileID)
	fields.WorkflowRunID = nullStringPtr(workflowRunID)
	fields.CrawlTaskID = nullStringPtr(crawlTaskID)
	fields.NativeRunID = nullStringPtr(nativeRunID)
	fields.LastError = nullStringPtr(lastError)
	fields.Keywords = rawOrNil(keywords)
	fields.Metadata = objectJSONOrNull(metadata)
	fields.StartedAt = nestFromNullTime(startedAt)
	fields.FinishedAt = nestFromNullTime(finishedAt)
	fields.CreatedAt = nestFromNullTime(createdAt)
	fields.UpdatedAt = nestFromNullTime(updatedAt)

	item := runListItem{runFields: fields}
	if profileIDJoin.Valid {
		item.Profile = &runProfileSummary{
			ID:            profileIDJoin.String,
			Name:          profileName.String,
			MatchHost:     profileMatchHost.String,
			ExecutionMode: ExecutionMode(profileExecutionMode.String),
			Version:       int(profileVersion.Int64),
		}
	}
	return item, nil
}

// matchesRunQueryFilters mirrors the in-memory filter of listRuns. The SQL
// already applies the same executionMode predicate; the remaining four filters
// read run metadata.
func matchesRunQueryFilters(item runListItem, query listQuery) bool {
	if query.ExecutionMode != nil && string(item.ExecutionMode) != *query.ExecutionMode {
		return false
	}
	metadata := decodeRunMetadata(item.Metadata)
	if query.RunRole != nil {
		runRole := metadata.RunRole.Trimmed()
		if runRole == "" {
			runRole = metadata.lifecycle.Role.Trimmed()
		}
		if runRole != *query.RunRole {
			return false
		}
	}
	if query.FailureKind != nil {
		failureKind := metadata.FailureKind.Trimmed()
		if failureKind == "" {
			failureKind = metadata.root.FailureKind.Trimmed()
		}
		if failureKind != *query.FailureKind {
			return false
		}
	}
	if query.WarningFlag != nil {
		flags := collectNodeWarningFlags(&metadata, nil)
		if !containsString(flags, *query.WarningFlag) {
			return false
		}
	}
	if query.SeedStrategy != nil {
		seedStrategy := metadata.SeedStrategy.Trimmed()
		if seedStrategy == "" {
			seedStrategy = metadata.root.SeedStrategy.Trimmed()
		}
		if seedStrategy != *query.SeedStrategy {
			return false
		}
	}
	return true
}

// likeContains mirrors Prisma's contains filter for MySQL: the wildcards are
// part of the bound parameter and are NOT escaped, so a "%" or "_" in the
// search text keeps its LIKE meaning. This is the behavior already verified by
// the crawl read/telemetry smoke (service_crawl.go).
func likeContains(value string) string {
	return "%" + value + "%"
}

// GetRun mirrors getRun: the run is looked up by primary key first and the
// orgId comparison happens afterwards, so an absent run and a cross-tenant run
// both return 404 Crawl frontier run not found.
func (s *Service) GetRun(ctx context.Context, orgID, id string) (runDetail, error) {
	fields, err := s.loadRunFields(ctx, id)
	if err != nil {
		return runDetail{}, err
	}
	if fields.OrgID != orgID {
		return runDetail{}, errRunMissing
	}
	var profile *profileRecord
	if fields.ProfileID != nil {
		record, err := s.loadProfile(ctx, *fields.ProfileID)
		if err != nil {
			if !isStatus(err, 404) {
				return runDetail{}, err
			}
			// A dangling profileId is impossible under the foreign key, but
			// NestJS would render null rather than fail the run response.
			profile = nil
		} else {
			profile = &record
		}
	}
	nodes, err := s.loadRunNodes(ctx, fields.ID)
	if err != nil {
		return runDetail{}, err
	}
	summary, err := s.buildRunSummary(ctx, orgID, fields, nodes)
	if err != nil {
		return runDetail{}, err
	}
	return runDetail{
		runFields: fields,
		Profile:   profile,
		Nodes:     nodes,
		Summary:   summary,
	}, nil
}

// loadRunFields loads one run row by primary key.
func (s *Service) loadRunFields(ctx context.Context, id string) (runFields, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+runColumns+" FROM CrawlFrontierRun WHERE id = ?", id)
	if err != nil {
		return runFields{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return runFields{}, err
		}
		return runFields{}, errRunMissing
	}
	fields, err := scanRunFields(rows)
	if err != nil {
		return runFields{}, err
	}
	return fields, nil
}

// loadProfile loads a CrawlSiteProfile row and normalizes its config through
// the existing crawlprofile normalization (the single source of truth).
func (s *Service) loadProfile(ctx context.Context, id string) (profileRecord, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+profileColumns+" FROM CrawlSiteProfile WHERE id = ?", id)
	if err != nil {
		return profileRecord{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return profileRecord{}, err
		}
		return profileRecord{}, newStatus(404, "Crawl site profile not found")
	}
	var record profileRecord
	var description, workflowID, workflowVersionID, updatedByID sql.NullString
	var active int
	var config []byte
	var publishedAt sql.NullTime
	var createdAt, updatedAt sql.NullTime
	err = rows.Scan(
		&record.ID, &record.OrgID, &record.Name, &description, &record.MatchHost, &active,
		&record.ExecutionMode, &workflowID, &workflowVersionID, &record.WorkflowBindingMode,
		&record.Version, &config, &record.CreatedByID, &updatedByID, &publishedAt,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return profileRecord{}, err
	}
	record.Description = nullStringPtr(description)
	record.WorkflowID = nullStringPtr(workflowID)
	record.WorkflowVersionID = nullStringPtr(workflowVersionID)
	record.UpdatedByID = nullStringPtr(updatedByID)
	record.IsActive = active != 0
	record.PublishedAt = nestFromNullTime(publishedAt)
	record.CreatedAt = nestFromNullTime(createdAt)
	record.UpdatedAt = nestFromNullTime(updatedAt)
	normalized, err := crawlprofile.NormalizeConfigJSON(json.RawMessage(config))
	if err != nil {
		return profileRecord{}, &inputError{Message: err.Error()}
	}
	record.Config = RawJSON(normalized)
	return record, nil
}

// loadRunNodes loads every node of a run in depth/discoveredAt order.
func (s *Service) loadRunNodes(ctx context.Context, runID string) ([]nodeRecord, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+nodeColumns+" FROM CrawlFrontierNode WHERE runId = ? ORDER BY depth ASC, discoveredAt ASC",
		runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]nodeRecord, 0)
	for rows.Next() {
		record, err := scanNodeRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// isStatus reports whether err is a statusError with the given code.
func isStatus(err error, status int) bool {
	var target *statusError
	if errors.As(err, &target) {
		return target.status == status
	}
	return false
}

package crawlfrontierllm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// store.go holds the SQL the judge/learn chains share: the run/node/profile
// reads, the metadata merge-write helpers (updateRunMetadata /
// updateNodeMetadata read-merge-write exactly like the NestJS service) and the
// CrawlFrontierNode insert with the (runId, urlFingerprint) dedupe.

// loadRun reads the CrawlFrontierRun projection the chain uses.
func (s *Service) loadRun(ctx context.Context, runID string) (*RunRecord, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status,
       maxDepth, maxPages, keywords, pageCount, nodeCount, articleCount, failedCount,
       duplicateCount, lastError, metadata, createdById
FROM CrawlFrontierRun WHERE id = ?`, runID)
	return scanRun(row)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRun(row rowScanner) (*RunRecord, error) {
	var (
		record                   RunRecord
		profileID, workflowRunID sql.NullString
		crawlTaskID, lastError   sql.NullString
		keywords, metadata       []byte
	)
	err := row.Scan(
		&record.ID, &record.OrgID, &profileID, &workflowRunID, &record.SeedURL, &crawlTaskID,
		&record.ExecutionMode, &record.Status, &record.MaxDepth, &record.MaxPages, &keywords,
		&record.PageCount, &record.NodeCount, &record.ArticleCount, &record.FailedCount,
		&record.DuplicateCount, &lastError, &metadata, &record.CreatedByID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.ProfileID = nullStringPtr(profileID)
	record.WorkflowRunID = nullStringPtr(workflowRunID)
	record.CrawlTaskID = nullStringPtr(crawlTaskID)
	record.LastError = nullStringPtr(lastError)
	record.Keywords = parseStringList(keywords)
	record.Metadata = parseObjectOrNil(metadata)
	return &record, nil
}

// loadNode reads one CrawlFrontierNode by primary key.
func (s *Service) loadNode(ctx context.Context, nodeID string) (*NodeRecord, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, runId, parentNodeId, orgId, url, canonicalUrl, urlFingerprint, pageType, depth,
       queueClass, status, score, freshnessScore, queuedAt, rejectionReason, lastError,
       metadata, discoveredAt
FROM CrawlFrontierNode WHERE id = ?`, nodeID)
	return scanNode(row)
}

// loadNodeForOrg reads a node and rejects a cross-tenant id, matching the
// `!node || node.orgId !== orgId` check.
func (s *Service) loadNodeForOrg(ctx context.Context, nodeID, orgID string) (*NodeRecord, error) {
	node, err := s.loadNode(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if node == nil || node.OrgID != orgID {
		return nil, notFound("Crawl frontier node not found for LLM judge")
	}
	return node, nil
}

func scanNode(row rowScanner) (*NodeRecord, error) {
	var (
		record                                     NodeRecord
		parentNodeID, canonicalURL, urlFingerprint sql.NullString
		queuedAt, rejectionReason, lastError       sql.NullString
		score, freshnessScore                      sql.NullFloat64
		metadata                                   []byte
		discoveredAt                               time.Time
	)
	err := row.Scan(
		&record.ID, &record.RunID, &parentNodeID, &record.OrgID, &record.URL, &canonicalURL,
		&urlFingerprint, &record.PageType, &record.Depth, &record.QueueClass, &record.Status,
		&score, &freshnessScore, &queuedAt, &rejectionReason, &lastError, &metadata, &discoveredAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.ParentNodeID = nullStringPtr(parentNodeID)
	record.CanonicalURL = nullStringPtr(canonicalURL)
	record.URLFingerprint = nullStringPtr(urlFingerprint)
	record.QueuedAt = nullStringPtr(queuedAt)
	record.RejectionReason = nullStringPtr(rejectionReason)
	record.LastError = nullStringPtr(lastError)
	record.Score = nullFloatPtr(score)
	record.FreshnessScore = nullFloatPtr(freshnessScore)
	record.Metadata = parseObjectOrNil(metadata)
	record.DiscoveredAt = nestISOString(discoveredAt)
	return &record, nil
}

// loadProfile loads a CrawlSiteProfile row and normalizes its config with the
// package the HTTP profile routes already use.
func (s *Service) loadProfile(ctx context.Context, profileID, orgID string) (*ProfileRecord, error) {
	var (
		record                                     ProfileRecord
		description, workflowID, workflowVersionID sql.NullString
		active                                     int
		config                                     []byte
	)
	err := s.db.QueryRowContext(ctx, `
SELECT id, orgId, name, description, matchHost, isActive, executionMode, workflowId,
       workflowVersionId, workflowBindingMode, version, config, createdById
FROM CrawlSiteProfile WHERE id = ?`, profileID).Scan(
		&record.ID, &record.OrgID, &record.Name, &description, &record.MatchHost, &active,
		&record.ExecutionMode, &workflowID, &workflowVersionID, &record.WorkflowBindingMode,
		&record.Version, &config, &record.CreatedByID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if record.OrgID != orgID {
		return nil, nil
	}
	record.Description = nullStringPtr(description)
	record.WorkflowID = nullStringPtr(workflowID)
	record.WorkflowVersionID = nullStringPtr(workflowVersionID)
	record.IsActive = active != 0
	normalized, normalizeErr := crawlprofile.NormalizeConfigJSON(config)
	if normalizeErr != nil {
		record.Config = NewObject()
	} else {
		record.Config = parseObjectOrDefault(normalized)
	}
	return &record, nil
}

// findProfileForURL mirrors findProfileForUrl: active profiles of the org,
// updatedAt desc/createdAt desc, first whose matchHost matches the URL host.
func (s *Service) findProfileForURL(ctx context.Context, orgID, seedURL string) (*ProfileRecord, error) {
	parsed, ok := parseHTTPURL(seedURL)
	if !ok {
		return nil, nil
	}
	host := strings.ToLower(parsed.Hostname())
	rows, err := s.db.QueryContext(ctx, `
SELECT id, name, description, matchHost, isActive, executionMode, workflowId,
       workflowVersionId, workflowBindingMode, version, config, createdById
FROM CrawlSiteProfile WHERE orgId = ? AND isActive = 1
ORDER BY updatedAt DESC, createdAt DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			record                                     ProfileRecord
			description, workflowID, workflowVersionID sql.NullString
			active                                     int
			config                                     []byte
		)
		if err := rows.Scan(
			&record.ID, &record.Name, &description, &record.MatchHost, &active,
			&record.ExecutionMode, &workflowID, &workflowVersionID, &record.WorkflowBindingMode,
			&record.Version, &config, &record.CreatedByID,
		); err != nil {
			return nil, err
		}
		if !matchHostPattern(record.MatchHost, host) {
			continue
		}
		record.OrgID = orgID
		record.Description = nullStringPtr(description)
		record.WorkflowID = nullStringPtr(workflowID)
		record.WorkflowVersionID = nullStringPtr(workflowVersionID)
		record.IsActive = active != 0
		normalized, normalizeErr := crawlprofile.NormalizeConfigJSON(config)
		if normalizeErr != nil {
			record.Config = NewObject()
		} else {
			record.Config = parseObjectOrDefault(normalized)
		}
		return &record, nil
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return nil, nil
}

// listNodesForLifecycle mirrors the include.nodes projection of
// handleTerminalRunLifecycle and processQueuedLlmLearn: depth asc,
// discoveredAt asc, only the listed columns.
func (s *Service) listNodesForLifecycle(ctx context.Context, runID string) ([]NodeRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, url, pageType, status, score, freshnessScore, metadata
FROM CrawlFrontierNode WHERE runId = ? ORDER BY depth ASC, discoveredAt ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]NodeRecord, 0)
	for rows.Next() {
		var (
			record       NodeRecord
			score, fresh sql.NullFloat64
			metadata     []byte
		)
		if err := rows.Scan(&record.ID, &record.URL, &record.PageType, &record.Status, &score, &fresh, &metadata); err != nil {
			return nil, err
		}
		record.RunID = runID
		record.Score = nullFloatPtr(score)
		record.FreshnessScore = nullFloatPtr(fresh)
		record.Metadata = parseObjectOrNil(metadata)
		out = append(out, record)
	}
	return out, rows.Err()
}

// refreshNodeProjection is the refreshRunStatus node projection. O1 keeps the
// JSON scan bounded: only the metadata members refreshRunStatus reads are
// extracted, never the whole document.
type refreshNode struct {
	Status          string
	PageType        string
	Depth           int
	RejectionReason *string
	LastError       *string
	Metadata        *Object
}

const refreshMetadataColumns = `JSON_OBJECT(
  'candidateStats', JSON_EXTRACT(metadata, '$.candidateStats'),
  'rejectionCounts', JSON_EXTRACT(metadata, '$.rejectionCounts'),
  'warningFlags', JSON_EXTRACT(metadata, '$.warningFlags'),
  'failureKind', JSON_EXTRACT(metadata, '$.failureKind'),
  'judgeMethod', JSON_EXTRACT(metadata, '$.judgeMethod'),
  'judgeConfidence', JSON_EXTRACT(metadata, '$.judgeConfidence'),
  'pendingLlmJudgeJobs', JSON_EXTRACT(metadata, '$.pendingLlmJudgeJobs'),
  'llmJudgeEnabled', JSON_EXTRACT(metadata, '$.llmJudgeEnabled'),
  'llmJudgeAttempted', JSON_EXTRACT(metadata, '$.llmJudgeAttempted'),
  'llmJudgeParsed', JSON_EXTRACT(metadata, '$.llmJudgeParsed'),
  'llmJudgeError', JSON_EXTRACT(metadata, '$.llmJudgeError'),
  'llmJudgeBudget', JSON_EXTRACT(metadata, '$.llmJudgeBudget'),
  'retryDemotedToNormal', JSON_EXTRACT(metadata, '$.retryDemotedToNormal'),
  'retryDemotedFromQueue', JSON_EXTRACT(metadata, '$.retryDemotedFromQueue'),
  'retryDemotedAt', JSON_EXTRACT(metadata, '$.retryDemotedAt'),
  'seedStrategy', JSON_EXTRACT(metadata, '$.seedStrategy'),
  'seedOrigin', JSON_EXTRACT(metadata, '$.seedOrigin'),
  'seedMethod', JSON_EXTRACT(metadata, '$.seedMethod'),
  'seedDiscoveryMode', JSON_EXTRACT(metadata, '$.seedDiscoveryMode'),
  'fallbackStage', JSON_EXTRACT(metadata, '$.fallbackStage'),
  'seedYield', JSON_EXTRACT(metadata, '$.seedYield'),
  'seedQuality', JSON_EXTRACT(metadata, '$.seedQuality'),
  'seedDiagnostics', JSON_EXTRACT(metadata, '$.seedDiagnostics'),
  'nativeStrategyType', JSON_EXTRACT(metadata, '$.nativeStrategyType'),
  'nativeStrategyResolvedFrom', JSON_EXTRACT(metadata, '$.nativeStrategyResolvedFrom'),
  'nativeStrategyAutoResolved', JSON_EXTRACT(metadata, '$.nativeStrategyAutoResolved'),
  'nativeFilterChainType', JSON_EXTRACT(metadata, '$.nativeFilterChainType'),
  'nativeUrlScorerType', JSON_EXTRACT(metadata, '$.nativeUrlScorerType'),
  'nativeAdaptiveType', JSON_EXTRACT(metadata, '$.nativeAdaptiveType'),
  'nativeFilterChainSynthesized', JSON_EXTRACT(metadata, '$.nativeFilterChainSynthesized'),
  'nativeUrlScorerSynthesized', JSON_EXTRACT(metadata, '$.nativeUrlScorerSynthesized'),
  'linkPreviewMode', JSON_EXTRACT(metadata, '$.linkPreviewMode'),
  'linkPreviewQuery', JSON_EXTRACT(metadata, '$.linkPreviewQuery'),
  'domScopeMode', JSON_EXTRACT(metadata, '$.domScopeMode'),
  'waitForMode', JSON_EXTRACT(metadata, '$.waitForMode'),
  'markdownFilterMode', JSON_EXTRACT(metadata, '$.markdownFilterMode'),
  'markdownFilterType', JSON_EXTRACT(metadata, '$.markdownFilterType'),
  'localeMode', JSON_EXTRACT(metadata, '$.localeMode'),
  'localeValue', JSON_EXTRACT(metadata, '$.localeValue'),
  'acceptLanguageMode', JSON_EXTRACT(metadata, '$.acceptLanguageMode')
)`

// listRefreshNodes is the O1 refreshRunStatus read. The extracted JSON_OBJECT
// carries only the fields the aggregation reads; the computed counts are proven
// equal to the whole-metadata read by TestRefreshRunStatusMatchesFullMetadata.
func (s *Service) listRefreshNodes(ctx context.Context, runID string) ([]refreshNode, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT status, pageType, depth, rejectionReason, lastError,
       (JSON_TYPE(metadata) = 'OBJECT') AS metadataIsObject, `+refreshMetadataColumns+`
FROM CrawlFrontierNode WHERE runId = ?`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]refreshNode, 0)
	for rows.Next() {
		var (
			record           refreshNode
			rejectionReason  sql.NullString
			lastError        sql.NullString
			metadataIsObject sql.NullInt64
			metadata         []byte
		)
		if err := rows.Scan(&record.Status, &record.PageType, &record.Depth, &rejectionReason, &lastError, &metadataIsObject, &metadata); err != nil {
			return nil, err
		}
		record.RejectionReason = nullStringPtr(rejectionReason)
		record.LastError = nullStringPtr(lastError)
		if metadataIsObject.Valid && metadataIsObject.Int64 == 1 {
			record.Metadata = parseObjectOrNil(metadata)
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

// updateRunMetadata is updateRunMetadata: read, merge, write.
func (s *Service) updateRunMetadata(ctx context.Context, runID string, patch *Object) error {
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT metadata FROM CrawlFrontierRun WHERE id = ?", runID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	existing := parseObjectOrNil(raw)
	merged := mergeObjects(existing, patch)
	if merged == nil {
		merged = NewObject()
	}
	encoded, err := merged.MarshalJSON()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierRun SET metadata = ?, updatedAt = ? WHERE id = ?",
		encoded, truncateMillis(time.Now()), runID)
	return err
}

// updateNodeMetadata is updateNodeMetadata: read, merge, write.
func (s *Service) updateNodeMetadata(ctx context.Context, nodeID string, patch *Object) error {
	return s.updateNodeMetadataFunc(ctx, nodeID, func(*Object) *Object { return patch })
}

// updateNodeMetadataFunc mirrors the NestJS functional patch: the merge and any
// field derived from the existing metadata run against the freshly read
// document, so a concurrent writer's keys are preserved.
func (s *Service) updateNodeMetadataFunc(ctx context.Context, nodeID string, build func(existing *Object) *Object) error {
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT metadata FROM CrawlFrontierNode WHERE id = ?", nodeID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	existing := parseObjectOrNil(raw)
	patch := build(existing)
	merged := mergeObjects(existing, patch)
	if merged == nil {
		merged = NewObject()
	}
	encoded, err := merged.MarshalJSON()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierNode SET metadata = ?, updatedAt = ? WHERE id = ?",
		encoded, truncateMillis(s.now()), nodeID)
	return err
}

// createNode is persistFrontierNode's create branch. The unique key dedupe is
// handled by the caller (existing fingerprint read + duplicate-key fallback).
func (s *Service) createNode(ctx context.Context, node NodeRecord) (string, error) {
	nodeID, err := newRowID()
	if err != nil {
		return "", err
	}
	metadata := json.RawMessage("{}")
	if node.Metadata != nil {
		metadata, err = node.Metadata.MarshalJSON()
		if err != nil {
			return "", err
		}
	}
	now := truncateMillis(time.Now())
	var queuedAt any
	if node.QueuedAt != nil {
		if parsed, ok := parseJSONTime(*node.QueuedAt); ok {
			queuedAt = truncateMillis(parsed)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlFrontierNode
  (id, runId, parentNodeId, orgId, url, canonicalUrl, urlFingerprint, pageType, depth,
   queueClass, status, score, freshnessScore, attempts, queuedAt, crawledAt, crawlResultId,
   rejectionReason, lastError, metadata, discoveredAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
		nodeID, node.RunID, nullableString(node.ParentNodeID), node.OrgID, node.URL,
		nullableString(node.CanonicalURL), nullableString(node.URLFingerprint), node.PageType,
		node.Depth, node.QueueClass, node.Status, nullableFloat(node.Score), nullableFloat(node.FreshnessScore),
		queuedAt, metadata, now, now, now)
	if err != nil {
		return "", err
	}
	return nodeID, nil
}

// findNodeByFingerprint is the (runId, urlFingerprint) unique lookup.
func (s *Service) findNodeByFingerprint(ctx context.Context, runID, fingerprint string) (id, status string, found bool, err error) {
	err = s.db.QueryRowContext(ctx,
		"SELECT id, status FROM CrawlFrontierNode WHERE runId = ? AND urlFingerprint = ? LIMIT 1",
		runID, fingerprint).Scan(&id, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return id, status, true, nil
}

// isDuplicateKeyError reports MySQL error 1062.
func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "Error 1062") || strings.Contains(err.Error(), "Duplicate entry")
}

// listExistingNodeFingerprints is the materialization existing-node read.
type existingNode struct {
	CanonicalURL   *string
	URLFingerprint *string
	PageType       string
}

func (s *Service) listExistingNodes(ctx context.Context, runID string) ([]existingNode, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT canonicalUrl, urlFingerprint, pageType FROM CrawlFrontierNode WHERE runId = ?", runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]existingNode, 0)
	for rows.Next() {
		var (
			canonical, fingerprint sql.NullString
			pageType               string
		)
		if err := rows.Scan(&canonical, &fingerprint, &pageType); err != nil {
			return nil, err
		}
		out = append(out, existingNode{
			CanonicalURL:   nullStringPtr(canonical),
			URLFingerprint: nullStringPtr(fingerprint),
			PageType:       pageType,
		})
	}
	return out, rows.Err()
}

func parseStringList(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	if len(values) == 0 {
		return nil
	}
	return values
}

func parseObjectOrNil(raw []byte) *Object {
	if len(raw) == 0 {
		return nil
	}
	object, ok := ParseObject(raw)
	if !ok {
		return nil
	}
	return object
}

func parseObjectOrDefault(raw []byte) *Object {
	object := parseObjectOrNil(raw)
	if object == nil {
		return NewObject()
	}
	return object
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullFloatPtr(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	out := value.Float64
	return &out
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

// newRowID mints a Prisma cuid-shaped id (c + 24 hex), the same shape every Go
// writer uses.
func newRowID() (string, error) {
	return newCuid()
}

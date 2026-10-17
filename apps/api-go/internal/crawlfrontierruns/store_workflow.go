package crawlfrontierruns

import (
	"context"
	"database/sql"
	"strings"
)

// errWorkflowRunMissing is the 404 for a workflow run that does not exist or
// belongs to another organization.
var errWorkflowRunMissing = newStatus(404, "Workflow run not found")

// errFrontierWorkflowRunMissing is the 404 for a frontier run without a bound
// workflow run.
var errFrontierWorkflowRunMissing = newStatus(404, "Crawl frontier workflow run not found")

// errCandidateMissing is the 404 for a candidate id that is not part of the
// workflow run.
var errCandidateMissing = newStatus(404, "Workflow candidate not found")

// GetRunWorkflowRunView mirrors getRunWorkflowRun: the frontier run is checked
// first (404 Crawl frontier run not found), then its workflowRunId (404 Crawl
// frontier workflow run not found), then the workflow run reader.
func (s *Service) GetRunWorkflowRunView(ctx context.Context, orgID, frontierRunID string) (workflowRunDocument, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT orgId, workflowRunId FROM CrawlFrontierRun WHERE id = ?", frontierRunID)
	if err != nil {
		return workflowRunDocument{}, err
	}
	var runOrgID string
	var workflowRunID sql.NullString
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return workflowRunDocument{}, err
		}
		_ = rows.Close()
		return workflowRunDocument{}, errRunMissing
	}
	err = rows.Scan(&runOrgID, &workflowRunID)
	_ = rows.Close()
	if err != nil {
		return workflowRunDocument{}, err
	}
	if runOrgID != orgID {
		return workflowRunDocument{}, errRunMissing
	}
	if !workflowRunID.Valid || strings.TrimSpace(workflowRunID.String) == "" {
		return workflowRunDocument{}, errFrontierWorkflowRunMissing
	}
	return s.GetWorkflowRun(ctx, orgID, workflowRunID.String)
}

// GetRunWorkflowCandidates mirrors listRunWorkflowCandidates.
func (s *Service) GetRunWorkflowCandidates(ctx context.Context, orgID, frontierRunID string) (workflowCandidatesDocument, error) {
	document, err := s.GetRunWorkflowRunView(ctx, orgID, frontierRunID)
	if err != nil {
		return nil, err
	}
	return workflowCandidatesDocument(document.Candidates), nil
}

// GetRunWorkflowCandidate mirrors getRunWorkflowCandidateExplanation. Candidate
// ids are compared against the mapped id (externalId ?? id).
func (s *Service) GetRunWorkflowCandidate(ctx context.Context, orgID, frontierRunID, candidateID string) (candidateDocument, error) {
	document, err := s.GetRunWorkflowRunView(ctx, orgID, frontierRunID)
	if err != nil {
		return candidateDocument{}, err
	}
	candidate, ok := findCandidate(document.Candidates, candidateID)
	if !ok {
		return candidateDocument{}, errCandidateMissing
	}
	return candidate, nil
}

// GetWorkflowRunCandidates mirrors listRunCandidates.
func (s *Service) GetWorkflowRunCandidates(ctx context.Context, orgID, runID string) (workflowCandidatesDocument, error) {
	document, err := s.GetWorkflowRun(ctx, orgID, runID)
	if err != nil {
		return nil, err
	}
	return workflowCandidatesDocument(document.Candidates), nil
}

// GetWorkflowCandidate mirrors getCandidateExplanation.
func (s *Service) GetWorkflowCandidate(ctx context.Context, orgID, runID, candidateID string) (candidateDocument, error) {
	document, err := s.GetWorkflowRun(ctx, orgID, runID)
	if err != nil {
		return candidateDocument{}, err
	}
	candidate, ok := findCandidate(document.Candidates, candidateID)
	if !ok {
		return candidateDocument{}, errCandidateMissing
	}
	return candidate, nil
}

// findCandidate looks a candidate up by its response id.
func findCandidate(candidates []candidateDocument, candidateID string) (candidateDocument, bool) {
	for _, candidate := range candidates {
		if candidate.ID == candidateID {
			return candidate, true
		}
	}
	return candidateDocument{}, false
}

// GetWorkflowRun mirrors the recorder getRun: the row is loaded by primary key
// and the orgId comparison happens afterwards, so cross-tenant runs return the
// same 404 as absent runs.
func (s *Service) GetWorkflowRun(ctx context.Context, orgID, runID string) (workflowRunDocument, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, orgId, workflowId, workflowVersionId, workflowOrigin, status, runKind, input,
       output, graphSnapshot, parameterSources, error, stepCount, candidateCount,
       selectedCount, startedAt, finishedAt, createdAt, updatedAt
FROM CrawlStrategyWorkflowRun WHERE id = ?`, runID)
	if err != nil {
		return workflowRunDocument{}, err
	}
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return workflowRunDocument{}, err
		}
		_ = rows.Close()
		return workflowRunDocument{}, errWorkflowRunMissing
	}
	row, err := scanWorkflowRunRow(rows)
	_ = rows.Close()
	if err != nil {
		return workflowRunDocument{}, err
	}
	if row.OrgID != orgID {
		return workflowRunDocument{}, errWorkflowRunMissing
	}

	document := workflowRunDocument{
		ID:               row.ID,
		OrgID:            row.OrgID,
		WorkflowOrigin:   row.WorkflowOrigin,
		Status:           row.Status,
		RunKind:          row.RunKind,
		Input:            objectJSONOrNull(row.Input),
		Output:           objectJSONOrNull(row.Output),
		GraphSnapshot:    objectJSONOrNull(row.GraphSnapshot),
		StepResults:      make([]stepDocument, 0),
		Candidates:       make([]candidateDocument, 0),
		ParameterSources: arrayJSONOrEmpty(row.ParameterSources),
		SystemEvents:     make([]eventDocument, 0),
		StepCount:        row.StepCount,
		CandidateCount:   row.CandidateCount,
		SelectedCount:    row.SelectedCount,
		Error:            nullStringPtr(row.Error),
		StartedAt:        nestFromNullTime(row.StartedAt),
		FinishedAt:       nestFromNullTime(row.FinishedAt),
		CreatedAt:        nestFromTime(row.CreatedAt),
		UpdatedAt:        nestFromTime(row.UpdatedAt),
	}

	if row.WorkflowID.Valid {
		workflow, err := s.loadWorkflowRef(ctx, row.WorkflowID.String)
		if err != nil {
			return workflowRunDocument{}, err
		}
		document.Workflow = workflow
	}
	if row.WorkflowVersionID.Valid {
		version, err := s.loadWorkflowVersionRef(ctx, row.WorkflowVersionID.String)
		if err != nil {
			return workflowRunDocument{}, err
		}
		document.WorkflowVersion = version
	}

	frontierRunID, err := s.loadFrontierRunID(ctx, row.ID)
	if err != nil {
		return workflowRunDocument{}, err
	}
	document.FrontierRunID = frontierRunID

	if document.StepResults, err = s.loadSteps(ctx, row.ID); err != nil {
		return workflowRunDocument{}, err
	}
	candidates, candidateIDs, traceGroups, err := s.loadCandidates(ctx, row.ID)
	if err != nil {
		return workflowRunDocument{}, err
	}
	document.Candidates = candidates
	for index := range document.Candidates {
		document.Candidates[index].Trace = candidateTraces(traceGroups, candidateIDs[index])
	}
	if document.SystemEvents, err = s.loadEvents(ctx, row.ID); err != nil {
		return workflowRunDocument{}, err
	}
	return document, nil
}

// loadWorkflowRef loads the {id, name} workflow relation. A dangling id renders
// as null, matching the Prisma include result.
func (s *Service) loadWorkflowRef(ctx context.Context, id string) (*workflowRef, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, name FROM CrawlStrategyWorkflow WHERE id = ?", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	var ref workflowRef
	if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
		return nil, err
	}
	return &ref, nil
}

// loadWorkflowVersionRef loads the {id, version, name} workflow version
// relation.
func (s *Service) loadWorkflowVersionRef(ctx context.Context, id string) (*workflowVersionRef, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, version, name FROM CrawlStrategyWorkflowVersion WHERE id = ?", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	var ref workflowVersionRef
	if err := rows.Scan(&ref.ID, &ref.Version, &ref.Name); err != nil {
		return nil, err
	}
	return &ref, nil
}

// loadFrontierRunID resolves the frontierRun relation (the CrawlFrontierRun row
// whose workflowRunId points at this workflow run).
func (s *Service) loadFrontierRunID(ctx context.Context, workflowRunID string) (*string, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id FROM CrawlFrontierRun WHERE workflowRunId = ? LIMIT 1", workflowRunID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	var id string
	if err := rows.Scan(&id); err != nil {
		return nil, err
	}
	return &id, nil
}

// loadSteps loads the workflow run steps in sequence/createdAt order.
func (s *Service) loadSteps(ctx context.Context, runID string) ([]stepDocument, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT stepKey, workflowNodeId, nodeType, label, status, durationMs, inputCount,
       outputCount, rejectedCount, sampleUrls, metrics, error
FROM CrawlStrategyWorkflowRunStep WHERE runId = ?
ORDER BY sequence ASC, createdAt ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]stepDocument, 0)
	for rows.Next() {
		step, err := scanStepDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, step)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// loadCandidates loads candidates ordered by updatedAt DESC, createdAt ASC, and
// all of their traces grouped by candidate row id. It also returns the raw row
// ids so traces can be attached without losing candidates whose response id is
// an externalId.
func (s *Service) loadCandidates(ctx context.Context, runID string) ([]candidateDocument, []string, []candidateTraceGroup, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, externalId, url, title, description, author, pageType, relevanceScore, score,
       freshnessScore, qualityScore, publishedAt, crawledAt, effectiveAt, status,
       rejectedByNodeId, rejectedReason, sourceNodeId, metadata
FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ?
ORDER BY updatedAt DESC, createdAt ASC`, runID)
	if err != nil {
		return nil, nil, nil, err
	}
	candidates := make([]candidateDocument, 0)
	rowIDs := make([]string, 0)
	for rows.Next() {
		rowID, candidate, err := scanCandidateDocument(rows)
		if err != nil {
			_ = rows.Close()
			return nil, nil, nil, err
		}
		candidates = append(candidates, candidate)
		rowIDs = append(rowIDs, rowID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, nil, nil, err
	}
	_ = rows.Close()

	traceRows, err := s.db.QueryContext(ctx, `
SELECT t.candidateId, t.nodeId, t.nodeType, t.action, t.message, t.accepted,
       t.scoreDelta, t.freshnessDelta, t.ruleHits, t.beforeSnapshot, t.afterSnapshot,
       t.details, t.timestamp
FROM CrawlStrategyWorkflowRunCandidateTrace t
JOIN CrawlStrategyWorkflowRunCandidate c ON c.id = t.candidateId
WHERE c.runId = ?
ORDER BY t.candidateId ASC, t.sequence ASC, t.timestamp ASC`, runID)
	if err != nil {
		return nil, nil, nil, err
	}
	defer traceRows.Close()
	groups := make([]candidateTraceGroup, 0)
	for traceRows.Next() {
		candidateID, trace, err := scanTraceDocument(traceRows)
		if err != nil {
			return nil, nil, nil, err
		}
		groups = appendCandidateTrace(groups, candidateID, trace)
	}
	if err := traceRows.Err(); err != nil {
		return nil, nil, nil, err
	}
	return candidates, rowIDs, groups, nil
}

// candidateTraceGroup collects the traces of one candidate row.
type candidateTraceGroup struct {
	RowID  string
	Traces []traceDocument
}

// appendCandidateTrace appends a trace to its candidate group, creating the
// group on first use.
func appendCandidateTrace(groups []candidateTraceGroup, rowID string, trace traceDocument) []candidateTraceGroup {
	for index := range groups {
		if groups[index].RowID == rowID {
			groups[index].Traces = append(groups[index].Traces, trace)
			return groups
		}
	}
	return append(groups, candidateTraceGroup{RowID: rowID, Traces: []traceDocument{trace}})
}

// candidateTraces returns the traces recorded for one candidate row.
func candidateTraces(groups []candidateTraceGroup, rowID string) []traceDocument {
	for index := range groups {
		if groups[index].RowID == rowID {
			return groups[index].Traces
		}
	}
	return []traceDocument{}
}

// loadEvents loads the system events in sequence/createdAt order.
func (s *Service) loadEvents(ctx context.Context, runID string) ([]eventDocument, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
       beforeCount, afterCount, rescuedCount, details, createdAt
FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?
ORDER BY sequence ASC, createdAt ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]eventDocument, 0)
	for rows.Next() {
		event, err := scanEventDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

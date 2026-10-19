//go:build integration

// Crawl discovery integration tests: they exercise the five
// CrawlStrategyWorkflowRun* tables plus the CrawlFrontierRun link against a real
// MySQL, and read the result back through the existing crawlfrontierruns read
// service (the same code path the run detail API uses). The preview part runs the
// real news-source read + pipeline-job queries with a stubbed outbound HTTP
// transport, so no request leaves the process.
//
// Environment (CI injects it; missing means skip — a local run without MySQL must
// not fail):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
package crawlstrategyruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	integrationOrgID      = "org-crawl-discovery-it"
	integrationOtherOrgID = "org-crawl-discovery-other"
	integrationActorID    = "user-integration"
)

func integrationDatabase(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// integrationDDL is the Prisma-migration-shaped subset the chain touches. Only
// the columns the tests read/write are declared; foreign keys and the columns
// with defaults that are never written are omitted.
var integrationDDL = []string{
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflow (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL," +
		"description TEXT NULL, draftDefinition JSON NOT NULL, publishedVersionId VARCHAR(191) NULL," +
		"createdById VARCHAR(191) NOT NULL, updatedById VARCHAR(191) NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), UNIQUE INDEX CrawlStrategyWorkflow_orgId_name_key (orgId, name))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowVersion (" +
		"id VARCHAR(191) NOT NULL, workflowId VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL," +
		"version INT NOT NULL, name VARCHAR(191) NOT NULL, description TEXT NULL, definition JSON NOT NULL," +
		"createdById VARCHAR(191) NOT NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (id), UNIQUE INDEX CrawlStrategyWorkflowVersion_workflowId_version_key (workflowId, version))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRun (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, workflowId VARCHAR(191) NULL," +
		"workflowVersionId VARCHAR(191) NULL, workflowOrigin VARCHAR(191) NOT NULL DEFAULT 'bound'," +
		"profileId VARCHAR(191) NULL, newsSourceId VARCHAR(191) NULL," +
		"status ENUM('pending','queued','running','completed','failed','canceled') NOT NULL DEFAULT 'pending'," +
		"runKind VARCHAR(191) NOT NULL DEFAULT 'trial', input JSON NULL, output JSON NULL," +
		"graphSnapshot JSON NULL, stepResults JSON NULL, candidates JSON NULL, parameterSources JSON NULL," +
		"error TEXT NULL, stepCount INT NOT NULL DEFAULT 0, candidateCount INT NOT NULL DEFAULT 0," +
		"selectedCount INT NOT NULL DEFAULT 0, createdById VARCHAR(191) NOT NULL," +
		"startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunStep (" +
		"id VARCHAR(191) NOT NULL, runId VARCHAR(191) NOT NULL, stepKey VARCHAR(191) NOT NULL," +
		"sequence INT NOT NULL DEFAULT 0, workflowNodeId VARCHAR(191) NULL, nodeType VARCHAR(191) NOT NULL," +
		"label VARCHAR(191) NOT NULL, status VARCHAR(191) NOT NULL, startedAt DATETIME(3) NULL," +
		"finishedAt DATETIME(3) NULL, durationMs INT NULL, inputCount INT NOT NULL DEFAULT 0," +
		"outputCount INT NOT NULL DEFAULT 0, rejectedCount INT NOT NULL DEFAULT 0, sampleUrls JSON NULL," +
		"metrics JSON NULL, error TEXT NULL, metadata JSON NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (id), UNIQUE INDEX CrawlStrategyWorkflowRunStep_runId_stepKey_key (runId, stepKey))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunCandidate (" +
		"id VARCHAR(191) NOT NULL, runId VARCHAR(191) NOT NULL, candidateKey VARCHAR(191) NOT NULL," +
		"externalId VARCHAR(191) NULL, sourceNodeId VARCHAR(191) NULL, sourceNodeType VARCHAR(191) NULL," +
		"url TEXT NOT NULL, title VARCHAR(191) NULL, description TEXT NULL, author VARCHAR(191) NULL," +
		"pageType VARCHAR(191) NULL, relevanceScore DOUBLE NULL, score DOUBLE NULL, freshnessScore DOUBLE NULL," +
		"qualityScore DOUBLE NULL, publishedAt DATETIME(3) NULL, crawledAt DATETIME(3) NULL," +
		"effectiveAt DATETIME(3) NULL, status VARCHAR(191) NOT NULL, rejectedByNodeId VARCHAR(191) NULL," +
		"rejectedReason VARCHAR(191) NULL, metadata JSON NULL, traceCount INT NOT NULL DEFAULT 0," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), UNIQUE INDEX CrawlStrategyWorkflowRunCandidate_runId_candidateKey_key (runId, candidateKey))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunCandidateTrace (" +
		"id VARCHAR(191) NOT NULL, candidateId VARCHAR(191) NOT NULL, sequence INT NOT NULL DEFAULT 0," +
		"timestamp DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), nodeId VARCHAR(191) NOT NULL," +
		"nodeType VARCHAR(191) NOT NULL, action VARCHAR(191) NOT NULL, message TEXT NOT NULL," +
		"accepted BOOLEAN NULL, scoreDelta DOUBLE NULL, freshnessDelta DOUBLE NULL, ruleHits JSON NULL," +
		"beforeSnapshot JSON NULL, afterSnapshot JSON NULL, details JSON NULL," +
		"PRIMARY KEY (id), INDEX CrawlStrategyWorkflowRunCandidateTrace_candidateId_sequence_idx (candidateId, sequence))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunEvent (" +
		"id VARCHAR(191) NOT NULL, runId VARCHAR(191) NOT NULL, sequence INT NOT NULL DEFAULT 0," +
		"level VARCHAR(191) NOT NULL, eventType VARCHAR(191) NOT NULL, nodeId VARCHAR(191) NULL," +
		"nodeType VARCHAR(191) NULL, message TEXT NOT NULL, triggerReason VARCHAR(191) NULL," +
		"beforeCount INT NULL, afterCount INT NULL, rescuedCount INT NULL, details JSON NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (id), INDEX CrawlStrategyWorkflowRunEvent_runId_sequence_idx (runId, sequence))",
	"CREATE TABLE IF NOT EXISTS CrawlFrontierRun (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, status VARCHAR(191) NOT NULL," +
		"workflowRunId VARCHAR(191) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"updatedAt DATETIME(3) NOT NULL, PRIMARY KEY (id))",
	"CREATE TABLE IF NOT EXISTS NewsSource (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL," +
		"url VARCHAR(512) NOT NULL, config JSON NULL, crawlTemplateId VARCHAR(191) NULL," +
		"workflowId VARCHAR(191) NULL, workflowVersionId VARCHAR(191) NULL," +
		"workflowBindingMode VARCHAR(191) NOT NULL DEFAULT 'published'," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), UNIQUE INDEX NewsSource_orgId_url_key (orgId, url))",
	"CREATE TABLE IF NOT EXISTS CrawlTemplate (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL," +
		"isActive BOOLEAN NOT NULL DEFAULT true, crawlOptions JSON NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id))",
	"CREATE TABLE IF NOT EXISTS PipelineJob (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, sourceId VARCHAR(191) NULL," +
		"url VARCHAR(512) NOT NULL, status VARCHAR(191) NOT NULL DEFAULT 'pending'," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), INDEX PipelineJob_sourceId_createdAt_idx (sourceId, createdAt))",
	"CREATE TABLE IF NOT EXISTS Article (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, url VARCHAR(512) NOT NULL," +
		"crawlAt DATETIME(3) NOT NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (id), INDEX Article_orgId_url_idx (orgId, url))",
}

func ensureIntegrationSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, statement := range integrationDDL {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("ddl: %v\n%s", err, statement)
		}
	}
}

// cleanupIntegrationRows removes only this test's org rows, so the shared CI
// database can host the other integration packages at the same time.
func cleanupIntegrationRows(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, statement := range []string{
		`DELETE t FROM CrawlStrategyWorkflowRunCandidateTrace t
		   JOIN CrawlStrategyWorkflowRunCandidate c ON c.id = t.candidateId
		   JOIN CrawlStrategyWorkflowRun r ON r.id = c.runId
		  WHERE r.orgId IN (?, ?)`,
		`DELETE c FROM CrawlStrategyWorkflowRunCandidate c
		   JOIN CrawlStrategyWorkflowRun r ON r.id = c.runId
		  WHERE r.orgId IN (?, ?)`,
		`DELETE s FROM CrawlStrategyWorkflowRunStep s
		   JOIN CrawlStrategyWorkflowRun r ON r.id = s.runId
		  WHERE r.orgId IN (?, ?)`,
		`DELETE e FROM CrawlStrategyWorkflowRunEvent e
		   JOIN CrawlStrategyWorkflowRun r ON r.id = e.runId
		  WHERE r.orgId IN (?, ?)`,
		"CrawlStrategyWorkflowRun",
		"CrawlFrontierRun",
		"PipelineJob",
		"Article",
		"NewsSource",
		"CrawlTemplate",
		"CrawlStrategyWorkflowVersion",
		"CrawlStrategyWorkflow",
	} {
		if strings.HasPrefix(statement, "DELETE ") && !strings.Contains(statement, " WHERE ") {
			statement += " WHERE orgId IN (?, ?)"
		}
		if _, err := db.Exec(statement, integrationOrgID, integrationOtherOrgID); err != nil {
			t.Fatalf("cleanup %s: %v", statement, err)
		}
	}
}

// seedWorkflow inserts one published workflow + version and returns their ids.
func seedWorkflow(t *testing.T, db *sql.DB, orgID, name string) (string, string) {
	t.Helper()
	workflowID, err := newRowID()
	if err != nil {
		t.Fatal(err)
	}
	versionID, err := newRowID()
	if err != nil {
		t.Fatal(err)
	}
	definition := json.RawMessage(`{
	  "version": 1,
	  "metadata": {"description": "it", "template": "blank", "tags": []},
	  "settings": {"executionMode": "hybrid", "maxDepth": 3, "maxPages": 60, "timeoutMs": 15000, "concurrency": 2, "robotsPolicy": "respect", "domainScope": "registrable_domain"},
	  "nodes": [
	    {"id": "seed-discovery", "type": "seed-discovery", "label": "Seed", "position": {"x": 0, "y": 0}, "config": {"mode": "sitemap", "maxUrls": 10}},
	    {"id": "persist-result", "type": "persist-result", "label": "Persist", "position": {"x": 1, "y": 0}, "config": {"selectTopK": 5}}
	  ],
	  "edges": [{"id": "e1", "source": "seed-discovery", "target": "persist-result"}]
	}`)
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO CrawlStrategyWorkflowVersion (id, workflowId, orgId, version, name, definition, createdById, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		versionID, workflowID, orgID, 1, "v1", []byte(definition), integrationActorID, now); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := db.Exec("INSERT INTO CrawlStrategyWorkflow (id, orgId, name, draftDefinition, publishedVersionId, createdById, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		workflowID, orgID, name, []byte(definition), versionID, integrationActorID, now, now); err != nil {
		t.Fatalf("insert workflow: %v", err)
	}
	return workflowID, versionID
}

func TestCrawlRunRecorderMySQLIntegration(t *testing.T) {
	db := integrationDatabase(t)
	ensureIntegrationSchema(t, db)
	cleanupIntegrationRows(t, db)
	t.Cleanup(func() { cleanupIntegrationRows(t, db) })

	context := context.Background()
	workflowID, versionID := seedWorkflow(t, db, integrationOrgID, "it-workflow")
	service := NewService(Options{DB: db})

	startedAt := time.Now().UTC().Truncate(time.Millisecond)
	externalID := "candidate:1"
	runID, err := service.CreateRun(context, createRunInput{
		OrgID:             integrationOrgID,
		CreatedByID:       integrationActorID,
		WorkflowID:        &workflowID,
		WorkflowVersionID: &versionID,
		WorkflowOrigin:    WorkflowOriginBound,
		Status:            RunStatusRunning,
		RunKind:           RunKindTrial,
		Input:             json.RawMessage(`{"seedUrl":"https://93.184.216.34/","runtimeOverrides":{}}`),
		GraphSnapshot:     json.RawMessage(`{"version":1}`),
		ParameterSources:  []any{},
		StartedAt:         &startedAt,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	reason := "min_score"
	trace := Trace{
		NodeID: "budget-control", NodeType: NodeTypeBudgetControl, Action: TraceActionBudgeted,
		Message: "Rejected by min score threshold", Accepted: boolPointer(false),
		RuleHits: []string{"min_score"}, RejectedReason: &reason,
		Details: json.RawMessage(`{"rank":1}`), Timestamp: isoNow(time.Now().UnixMilli()),
	}
	selected := Candidate{
		ID: externalID, URL: "https://93.184.216.34/2026/10/19/one", Status: CandidateStatusSelected,
		SourceNodeID: "seed-discovery", Metadata: json.RawMessage(`{"prefetchedArticle":null}`),
		Score: floatPointer(0.9), Trace: []Trace{trace},
	}
	rejected := Candidate{
		ID: "candidate:2", URL: "https://93.184.216.34/about", Status: CandidateStatusRejected,
		SourceNodeID: "seed-discovery", Metadata: json.RawMessage(`{}`),
		RejectedByNodeID: stringPointer("budget-control"), RejectedReason: &reason,
		Trace: []Trace{},
	}
	steps := []Step{
		{NodeID: "seed-discovery", NodeType: NodeTypeSeedDiscovery, Label: "Seed", Status: RunStatusCompleted,
			DurationMs: 12, InputCount: 0, OutputCount: 2, RejectedCount: 0, SampleURLs: []string{selected.URL},
			Metrics: json.RawMessage(`{"discoveredCount":2}`)},
		{NodeID: "budget-control", NodeType: NodeTypeBudgetControl, Label: "Budget", Status: RunStatusCompleted,
			DurationMs: 3, InputCount: 2, OutputCount: 1, RejectedCount: 1, SampleURLs: []string{}, Metrics: json.RawMessage(`{}`)},
	}
	eventNode := "budget-control"
	events := []SystemEvent{{
		Level: "info", EventType: "fallback_strategy_activated", NodeID: &eventNode, NodeType: &eventNode,
		Message: "Fallback strategy activated", TriggerReason: stringPointer("empty_input"),
		BeforeCount: intPointer(0), AfterCount: intPointer(2), RescuedCount: intPointer(2),
		Details: json.RawMessage(`{}`), Timestamp: isoNow(time.Now().UnixMilli()),
	}}
	finishedAt := time.Now().UTC().Truncate(time.Millisecond)
	if err := service.FinalizeRun(context, runID, finalizeRunInput{
		Status:     RunStatusCompleted,
		Output:     json.RawMessage(`{"selectedCount":1,"candidateCount":2}`),
		Steps:      steps,
		Candidates: []Candidate{selected, rejected},
		Events:     events,
		FinishedAt: &finishedAt,
	}); err != nil {
		t.Fatalf("FinalizeRun: %v", err)
	}

	// Raw row assertions: counts, per-table rows and trace sequence.
	var (
		status                                   string
		stepCount, candidateCount, selectedCount int
		errorText                                sql.NullString
	)
	if err := db.QueryRow("SELECT status, stepCount, candidateCount, selectedCount, error FROM CrawlStrategyWorkflowRun WHERE id = ?", runID).
		Scan(&status, &stepCount, &candidateCount, &selectedCount, &errorText); err != nil {
		t.Fatalf("run row: %v", err)
	}
	if status != RunStatusCompleted || stepCount != 2 || candidateCount != 2 || selectedCount != 1 {
		t.Fatalf("run row = %s/%d/%d/%d", status, stepCount, candidateCount, selectedCount)
	}
	if errorText.Valid {
		t.Fatalf("completed run must not carry an error: %v", errorText.String)
	}

	var stepRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep WHERE runId = ?", runID).Scan(&stepRows); err != nil {
		t.Fatalf("step rows: %v", err)
	}
	if stepRows != 2 {
		t.Fatalf("step rows = %d", stepRows)
	}
	var traceCount int
	if err := db.QueryRow(`SELECT traceCount FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ? AND externalId = ?`, runID, externalID).Scan(&traceCount); err != nil {
		t.Fatalf("candidate row: %v", err)
	}
	if traceCount != 1 {
		t.Fatalf("traceCount = %d", traceCount)
	}
	var traceSequence int
	var traceRejected string
	if err := db.QueryRow(`SELECT sequence, JSON_UNQUOTE(JSON_EXTRACT(details, '$.rejectedReason'))
	  FROM CrawlStrategyWorkflowRunCandidateTrace t
	  JOIN CrawlStrategyWorkflowRunCandidate c ON c.id = t.candidateId
	  WHERE c.runId = ? AND c.externalId = ?`, runID, externalID).Scan(&traceSequence, &traceRejected); err != nil {
		t.Fatalf("trace row: %v", err)
	}
	if traceSequence != 1 || traceRejected != reason {
		t.Fatalf("trace = %d/%s", traceSequence, traceRejected)
	}
	var eventSequence int
	if err := db.QueryRow("SELECT sequence FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", runID).Scan(&eventSequence); err != nil {
		t.Fatalf("event row: %v", err)
	}
	if eventSequence != 1 {
		t.Fatalf("event sequence = %d", eventSequence)
	}

	// Round-trip through the existing read service (the run detail API path).
	reader := crawlfrontierruns.NewService(db)
	document, err := reader.GetWorkflowRun(context, integrationOrgID, runID)
	if err != nil {
		t.Fatalf("GetWorkflowRun: %v", err)
	}
	if document.Status != RunStatusCompleted || document.StepCount != 2 || document.CandidateCount != 2 || document.SelectedCount != 1 {
		t.Fatalf("read back = %+v", document)
	}
	if len(document.StepResults) != 2 || len(document.Candidates) != 2 || len(document.SystemEvents) != 1 {
		t.Fatalf("read back rows = %d/%d/%d", len(document.StepResults), len(document.Candidates), len(document.SystemEvents))
	}
	if document.StepResults[0].StepKey != "seed-discovery" || document.StepResults[1].StepKey != "budget-control" {
		t.Fatalf("step order = %+v", document.StepResults)
	}
	if document.Workflow == nil || document.Workflow.ID != workflowID {
		t.Fatalf("workflow ref = %+v", document.Workflow)
	}
	if document.WorkflowVersion == nil || document.WorkflowVersion.ID != versionID {
		t.Fatalf("version ref = %+v", document.WorkflowVersion)
	}
	foundSelected := false
	for _, candidate := range document.Candidates {
		if candidate.URL == selected.URL {
			foundSelected = true
			if candidate.Status != CandidateStatusSelected {
				t.Fatalf("candidate status = %s", candidate.Status)
			}
			if len(candidate.Trace) != 1 || candidate.Trace[0].Action != TraceActionBudgeted {
				t.Fatalf("candidate trace = %+v", candidate.Trace)
			}
			if candidate.Trace[0].RejectedReason == nil || *candidate.Trace[0].RejectedReason != reason {
				t.Fatalf("trace rejectedReason = %v", candidate.Trace[0].RejectedReason)
			}
		}
	}
	if !foundSelected {
		t.Fatal("selected candidate missing from the read back")
	}

	// Cross-tenant reads return the same 404 as an absent run.
	if _, err := reader.GetWorkflowRun(context, integrationOtherOrgID, runID); err == nil {
		t.Fatal("a cross-tenant read must fail")
	}
}

func TestCrawlRunRecorderFailureMarksTheRun(t *testing.T) {
	db := integrationDatabase(t)
	ensureIntegrationSchema(t, db)
	cleanupIntegrationRows(t, db)
	t.Cleanup(func() { cleanupIntegrationRows(t, db) })

	context := context.Background()
	workflowID, versionID := seedWorkflow(t, db, integrationOrgID, "it-failure")
	service := NewService(Options{DB: db})
	startedAt := time.Now().UTC()
	runID, err := service.CreateRun(context, createRunInput{
		OrgID: integrationOrgID, CreatedByID: integrationActorID,
		WorkflowID: &workflowID, WorkflowVersionID: &versionID,
		Status: RunStatusRunning, RunKind: RunKindTrial,
		Input: json.RawMessage(`{}`), GraphSnapshot: json.RawMessage(`{}`), StartedAt: &startedAt,
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	message := "[SEED_DEEP_CRAWL4AI_UNAVAILABLE] Deep discovery requires crawl4ai service, but crawl4ai client is unavailable."
	finishedAt := time.Now().UTC()
	if err := service.FinalizeRun(context, runID, finalizeRunInput{
		Status: RunStatusFailed, Error: &message, FinishedAt: &finishedAt,
	}); err != nil {
		t.Fatalf("FinalizeRun: %v", err)
	}
	document, err := crawlfrontierruns.NewService(db).GetWorkflowRun(context, integrationOrgID, runID)
	if err != nil {
		t.Fatalf("GetWorkflowRun: %v", err)
	}
	if document.Status != RunStatusFailed || document.Error == nil || *document.Error != message {
		t.Fatalf("failed run = %+v", document)
	}
	if document.FinishedAt == nil {
		t.Fatal("finishedAt must be set")
	}
}

func TestCrawlRunReplaySourceRunRead(t *testing.T) {
	db := integrationDatabase(t)
	ensureIntegrationSchema(t, db)
	cleanupIntegrationRows(t, db)
	t.Cleanup(func() { cleanupIntegrationRows(t, db) })

	context := context.Background()
	workflowID, versionID := seedWorkflow(t, db, integrationOrgID, "it-replay")
	service := NewService(Options{DB: db})

	// A bound run replays from its own ids and input.
	runID, err := service.CreateRun(context, createRunInput{
		OrgID: integrationOrgID, CreatedByID: integrationActorID,
		WorkflowID: &workflowID, WorkflowVersionID: &versionID,
		Status: RunStatusCompleted, RunKind: RunKindTrial,
		Input:         json.RawMessage(`{"seedUrl":"https://93.184.216.34/","maxCandidates":7,"runtimeOverrides":{}}`),
		GraphSnapshot: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	existing, err := service.loadRunForReplay(context, runID)
	if err != nil {
		t.Fatalf("loadRunForReplay: %v", err)
	}
	if existing.WorkflowID == nil || *existing.WorkflowID != workflowID {
		t.Fatalf("workflowId = %v", existing.WorkflowID)
	}
	if existing.WorkflowVersionID == nil || *existing.WorkflowVersionID != versionID {
		t.Fatalf("workflowVersionId = %v", existing.WorkflowVersionID)
	}
	if seed := inputString(existing.Input, "seedUrl"); seed == nil || *seed != "https://93.184.216.34/" {
		t.Fatalf("seedUrl = %v", seed)
	}
	if max := inputInt(existing.Input, "maxCandidates"); max == nil || *max != 7 {
		t.Fatalf("maxCandidates = %v", max)
	}

	// A legacy-bridge run is not replayable: the origin and the missing
	// workflow id both trigger the same 404 text in Replay.
	legacyRunID, err := service.CreateRun(context, createRunInput{
		OrgID: integrationOrgID, CreatedByID: integrationActorID,
		WorkflowOrigin: WorkflowOriginLegacyBridge, Status: RunStatusCompleted, RunKind: RunKindTrial,
		Input: json.RawMessage(`{}`), GraphSnapshot: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("CreateRun legacy: %v", err)
	}
	legacy, err := service.loadRunForReplay(context, legacyRunID)
	if err != nil {
		t.Fatalf("loadRunForReplay legacy: %v", err)
	}
	if legacy.WorkflowOrigin != WorkflowOriginLegacyBridge {
		t.Fatalf("origin = %q", legacy.WorkflowOrigin)
	}
	if legacy.WorkflowID != nil {
		t.Fatalf("legacy run must not have a workflow id: %v", *legacy.WorkflowID)
	}
}

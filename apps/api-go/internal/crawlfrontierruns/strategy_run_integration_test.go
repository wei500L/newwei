//go:build integration

// Crawl-strategy run record integration test (build tag integration; the normal
// `go test ./...` does not need a database).
//
// It verifies the write contract against a real MySQL:
//   - createRun + finalizeRun (steps, candidates, traces, events) write every
//     table with the NestJS mapping, order and sequence;
//   - the O1 batched writer produces the same rows as the original per-row
//     writer (same values, same order, same sequence) — only the INSERT shape
//     changed;
//   - the existing crawlfrontierruns workflow-run read (GetWorkflowRun) returns
//     the Go-written rows (round trip).
//
// Environment (injected by the CI job; absent locally means skip):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
package crawlfrontierruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func integrationDatabaseURL(t *testing.T) string {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	return url
}

var crawlStrategyRunSchema = []string{
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRun (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, orgId VARCHAR(191) NOT NULL," +
		"workflowId VARCHAR(191) NULL, workflowVersionId VARCHAR(191) NULL," +
		"workflowOrigin VARCHAR(191) NOT NULL DEFAULT 'bound', profileId VARCHAR(191) NULL, newsSourceId VARCHAR(191) NULL," +
		"status VARCHAR(32) NOT NULL DEFAULT 'pending', runKind VARCHAR(64) NOT NULL DEFAULT 'trial'," +
		"input JSON NULL, output JSON NULL, graphSnapshot JSON NULL, stepResults JSON NULL, candidates JSON NULL, parameterSources JSON NULL," +
		"error TEXT NULL, stepCount INT NOT NULL DEFAULT 0, candidateCount INT NOT NULL DEFAULT 0, selectedCount INT NOT NULL DEFAULT 0," +
		"createdById VARCHAR(191) NOT NULL, startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunStep (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, runId VARCHAR(191) NOT NULL," +
		"stepKey VARCHAR(191) NOT NULL, sequence INT NOT NULL DEFAULT 0," +
		"workflowNodeId VARCHAR(191) NULL, nodeType VARCHAR(64) NOT NULL, label VARCHAR(255) NOT NULL, status VARCHAR(32) NOT NULL," +
		"startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL, durationMs INT NULL," +
		"inputCount INT NOT NULL DEFAULT 0, outputCount INT NOT NULL DEFAULT 0, rejectedCount INT NOT NULL DEFAULT 0," +
		"sampleUrls JSON NULL, metrics JSON NULL, error TEXT NULL, metadata JSON NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"UNIQUE KEY run_step (runId, stepKey)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunCandidate (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, runId VARCHAR(191) NOT NULL," +
		"candidateKey VARCHAR(191) NOT NULL, externalId VARCHAR(191) NULL," +
		"sourceNodeId VARCHAR(191) NULL, sourceNodeType VARCHAR(64) NULL," +
		"url TEXT NOT NULL, title VARCHAR(512) NULL, description TEXT NULL, author VARCHAR(255) NULL, pageType VARCHAR(32) NULL," +
		"relevanceScore DOUBLE NULL, score DOUBLE NULL, freshnessScore DOUBLE NULL, qualityScore DOUBLE NULL," +
		"publishedAt DATETIME(3) NULL, crawledAt DATETIME(3) NULL, effectiveAt DATETIME(3) NULL," +
		"status VARCHAR(32) NOT NULL, rejectedByNodeId VARCHAR(191) NULL, rejectedReason VARCHAR(64) NULL," +
		"metadata JSON NULL, traceCount INT NOT NULL DEFAULT 0," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"UNIQUE KEY run_candidate (runId, candidateKey)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunCandidateTrace (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, candidateId VARCHAR(191) NOT NULL," +
		"sequence INT NOT NULL DEFAULT 0, timestamp DATETIME(3) NOT NULL," +
		"nodeId VARCHAR(191) NOT NULL, nodeType VARCHAR(64) NOT NULL, action VARCHAR(32) NOT NULL, message TEXT NOT NULL," +
		"accepted BOOLEAN NULL, scoreDelta DOUBLE NULL, freshnessDelta DOUBLE NULL," +
		"ruleHits JSON NULL, beforeSnapshot JSON NULL, afterSnapshot JSON NULL, details JSON NULL" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunEvent (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, runId VARCHAR(191) NOT NULL," +
		"sequence INT NOT NULL DEFAULT 0, level VARCHAR(16) NOT NULL, eventType VARCHAR(64) NOT NULL," +
		"nodeId VARCHAR(191) NULL, nodeType VARCHAR(64) NULL, message TEXT NOT NULL, triggerReason VARCHAR(64) NULL," +
		"beforeCount INT NULL, afterCount INT NULL, rescuedCount INT NULL, details JSON NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS CrawlFrontierRun (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, workflowRunId VARCHAR(191) NULL" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
}

func setupCrawlStrategyRuns(t *testing.T) (*sql.DB, *Service) {
	t.Helper()
	db, err := usersettings.OpenMySQLFromURL(integrationDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range crawlStrategyRunSchema {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	for _, table := range []string{
		"CrawlStrategyWorkflowRun", "CrawlStrategyWorkflowRunStep", "CrawlStrategyWorkflowRunCandidate",
		"CrawlStrategyWorkflowRunCandidateTrace", "CrawlStrategyWorkflowRunEvent", "CrawlFrontierRun",
	} {
		if _, err := db.Exec("DELETE FROM " + table + " WHERE 1 = 1"); err != nil {
			t.Fatalf("clean %s: %v", table, err)
		}
	}
	return db, NewService(db)
}

func sampleCandidates() []StrategyRunCandidate {
	published := "2026-01-02T03:04:05.000Z"
	title := "First"
	return []StrategyRunCandidate{
		{
			ID: "candidate:1", URL: "https://example.com/a", Title: &title, Status: "selected",
			SourceNodeID: "seed", PublishedAt: &published,
			Metadata: json.RawMessage(`{"prefetchedArticle":null,"metadataStatus":"success"}`),
			Trace: []StrategyRunTrace{
				{NodeID: "seed", NodeType: "seed-discovery", Action: "discovered", Message: "Candidate discovered", Timestamp: "2026-01-02T03:04:05.000Z"},
				{NodeID: "persist", NodeType: "persist-result", Action: "persisted", Message: "Selected for persistence", Timestamp: "2026-01-02T03:04:06.000Z"},
			},
		},
		{
			ID: "candidate:2", URL: "https://example.com/b", Status: "rejected",
			SourceNodeID: "seed", Metadata: json.RawMessage(`{"prefetchedArticle":null}`),
			Trace: []StrategyRunTrace{
				{NodeID: "seed", NodeType: "seed-discovery", Action: "discovered", Message: "Candidate discovered", Timestamp: "2026-01-02T03:04:05.500Z"},
			},
		},
	}
}

func sampleSteps() []StrategyRunStep {
	return []StrategyRunStep{
		{NodeID: "seed", NodeType: "seed-discovery", Label: "Seed", Status: "completed", DurationMs: 12,
			InputCount: 0, OutputCount: 2, RejectedCount: 0, SampleURLs: []string{"https://example.com/a"},
			Metrics: json.RawMessage(`{"discoveredCount":2}`)},
		{NodeID: "persist", NodeType: "persist-result", Label: "Persist", Status: "completed", DurationMs: 1,
			InputCount: 2, OutputCount: 1, RejectedCount: 1, SampleURLs: []string{"https://example.com/a"}},
	}
}

// TestStrategyRunWriteIntegration verifies the written rows and the read round
// trip.
func TestStrategyRunWriteIntegration(t *testing.T) {
	db, service := setupCrawlStrategyRuns(t)
	ctx := context.Background()

	runID, err := service.CreateRun(ctx, StrategyRunCreateInput{
		OrgID: "org-1", CreatedByID: "user-1", RunKind: "trial", Status: "running",
		WorkflowOrigin:   "bound",
		Input:            json.RawMessage(`{"seedUrl":"https://example.com"}`),
		GraphSnapshot:    json.RawMessage(`{"version":1}`),
		ParameterSources: json.RawMessage(`[{"key":"settings.domainScope","value":"registrable_domain","source":"workflow"}]`),
		StartedAt:        timePointerForTest(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}

	finishedAt := time.Now().UTC()
	if err := service.FinalizeRun(ctx, runID, StrategyRunFinalizeInput{
		Status: "completed", Output: json.RawMessage(`{"selectedCount":1,"candidateCount":2}`),
		Steps: sampleSteps(), HasSteps: true,
		Candidates: sampleCandidates(), HasCandidates: true,
		ParameterSources: json.RawMessage(`[{"key":"settings.domainScope","value":"registrable_domain","source":"workflow"}]`),
		Events: []StrategyRunEvent{{
			Level: "info", EventType: "fallback_strategy_activated", Message: "Fallback strategy activated",
			Timestamp: "2026-01-02T03:04:05.000Z",
		}}, HasEvents: true,
		FinishedAt: &finishedAt,
	}); err != nil {
		t.Fatal(err)
	}

	var stepCount, candidateCount, selectedCount int
	var status string
	if err := db.QueryRowContext(ctx, "SELECT status, stepCount, candidateCount, selectedCount FROM CrawlStrategyWorkflowRun WHERE id = ?", runID).
		Scan(&status, &stepCount, &candidateCount, &selectedCount); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || stepCount != 2 || candidateCount != 2 || selectedCount != 1 {
		t.Fatalf("run = %s %d %d %d", status, stepCount, candidateCount, selectedCount)
	}

	assertSequence(t, db, "CrawlStrategyWorkflowRunStep", runID, 1, 2)
	assertSequence(t, db, "CrawlStrategyWorkflowRunEvent", runID, 1)

	// Round trip through the existing read.
	document, err := service.GetWorkflowRun(ctx, "org-1", runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.StepResults) != 2 || len(document.Candidates) != 2 || len(document.SystemEvents) != 1 {
		t.Fatalf("document = %+v", document)
	}
	if document.Candidates[0].URL == "" || len(document.Candidates[0].Trace) == 0 {
		t.Fatalf("candidates = %+v", document.Candidates)
	}
}

// TestStrategyRunBatchWriterMatchesPerRowIntegration is the O1 equivalence
// check: the batched finalizeRun stores the same rows as the original per-row
// writer.
func TestStrategyRunBatchWriterMatchesPerRowIntegration(t *testing.T) {
	db, service := setupCrawlStrategyRuns(t)
	ctx := context.Background()
	finishedAt := time.Now().UTC()

	batchedID, err := service.CreateRun(ctx, StrategyRunCreateInput{OrgID: "org-1", CreatedByID: "user-1", RunKind: "trial"})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.FinalizeRun(ctx, batchedID, StrategyRunFinalizeInput{
		Status: "completed", Steps: sampleSteps(), HasSteps: true,
		Candidates: sampleCandidates(), HasCandidates: true, FinishedAt: &finishedAt,
	}); err != nil {
		t.Fatal(err)
	}

	perRowID, err := service.CreateRun(ctx, StrategyRunCreateInput{OrgID: "org-1", CreatedByID: "user-1", RunKind: "trial"})
	if err != nil {
		t.Fatal(err)
	}
	writePerRowReference(t, db, perRowID, sampleSteps(), sampleCandidates())

	compareRows(t, db, batchedID, perRowID)
}

func writePerRowReference(t *testing.T, db *sql.DB, runID string, steps []StrategyRunStep, candidates []StrategyRunCandidate) {
	t.Helper()
	for index, step := range steps {
		id, _ := newRowID()
		stepKey := step.StepKey
		if strings.TrimSpace(stepKey) == "" {
			stepKey = step.NodeID
		}
		_, err := db.Exec(`INSERT INTO CrawlStrategyWorkflowRunStep
(id, runId, stepKey, sequence, workflowNodeId, nodeType, label, status, durationMs, inputCount, outputCount, rejectedCount, sampleUrls, metrics, error, metadata, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
			id, runID, stepKey, index+1, nullableStringValue(stringPointerOrNil(step.NodeID)), step.NodeType, step.Label, step.Status,
			step.DurationMs, step.InputCount, step.OutputCount, step.RejectedCount,
			[]byte(jsonDefault(marshalStringList(step.SampleURLs), `[]`)), []byte(jsonDefault(step.Metrics, `{}`)),
			nullableStringValue(step.Error), []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, candidate := range candidates {
		id, _ := newRowID()
		sourceNodeType := any(nil)
		if len(candidate.Trace) > 0 {
			sourceNodeType = candidate.Trace[0].NodeType
		}
		_, err := db.Exec(`INSERT INTO CrawlStrategyWorkflowRunCandidate
(id, runId, candidateKey, externalId, sourceNodeId, sourceNodeType, url, title, description, author, pageType, relevanceScore, score, freshnessScore, qualityScore, publishedAt, crawledAt, effectiveAt, status, rejectedByNodeId, rejectedReason, metadata, traceCount, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
			id, runID, candidateKey(candidate), candidate.ID,
			nullableStringValue(stringPointerOrNil(candidate.SourceNodeID)), sourceNodeType, candidate.URL,
			nullableStringValue(candidate.Title), nullableStringValue(candidate.Description), nullableStringValue(candidate.Author),
			nullableStringValue(candidate.PageType), finiteOrNull(candidate.RelevanceScore), finiteOrNull(candidate.Score),
			finiteOrNull(candidate.FreshnessScore), finiteOrNull(candidate.QualityScore),
			dateOrNull(candidate.PublishedAt), dateOrNull(candidate.CrawledAt), dateOrNull(candidate.EffectiveAt),
			candidate.Status, nullableStringValue(candidate.RejectedByNodeID), nullableStringValue(candidate.RejectedReason),
			[]byte(jsonDefault(candidate.Metadata, `{}`)), len(candidate.Trace))
		if err != nil {
			t.Fatal(err)
		}
		for index, trace := range candidate.Trace {
			traceID, _ := newRowID()
			_, err := db.Exec(`INSERT INTO CrawlStrategyWorkflowRunCandidateTrace
(id, candidateId, sequence, timestamp, nodeId, nodeType, action, message, accepted, scoreDelta, freshnessDelta, ruleHits, beforeSnapshot, afterSnapshot, details)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				traceID, id, index+1, eventTime(trace.Timestamp), trace.NodeID, trace.NodeType, trace.Action, trace.Message,
				nullableBoolValue(trace.Accepted), finiteOrNull(trace.ScoreDelta), finiteOrNull(trace.FreshnessDelta),
				[]byte(jsonDefault(marshalStringList(trace.RuleHits), `[]`)),
				[]byte(jsonDefault(trace.BeforeSnapshot, `{}`)), []byte(jsonDefault(trace.AfterSnapshot, `{}`)),
				[]byte(traceDetails(trace)))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
}

func compareRows(t *testing.T, db *sql.DB, batchedID, perRowID string) {
	t.Helper()
	candidateQuery := `SELECT candidateKey, externalId, sourceNodeId, sourceNodeType, url, title, status, traceCount,
	relevanceScore, score, freshnessScore, qualityScore, publishedAt, crawledAt, effectiveAt, metadata
	FROM CrawlStrategyWorkflowRunCandidate WHERE runId = ? ORDER BY candidateKey ASC`
	batched := scanCandidateRows(t, db, candidateQuery, batchedID)
	perRow := scanCandidateRows(t, db, candidateQuery, perRowID)
	if len(batched) != len(perRow) || len(batched) != 2 {
		t.Fatalf("candidate rows: batched=%v perRow=%v", batched, perRow)
	}
	for index := range batched {
		if batched[index] != perRow[index] {
			t.Fatalf("candidate row %d:\nbatched=%s\nperRow =%s", index, batched[index], perRow[index])
		}
	}

	traceQuery := `SELECT t.sequence, t.nodeId, t.action, t.message
	FROM CrawlStrategyWorkflowRunCandidateTrace t
	JOIN CrawlStrategyWorkflowRunCandidate c ON t.candidateId = c.id
	WHERE c.runId = ? ORDER BY c.candidateKey ASC, t.sequence ASC`
	batchedTraces := scanTraceRows(t, db, traceQuery, batchedID)
	perRowTraces := scanTraceRows(t, db, traceQuery, perRowID)
	if len(batchedTraces) != len(perRowTraces) || len(batchedTraces) != 3 {
		t.Fatalf("trace rows: batched=%v perRow=%v", batchedTraces, perRowTraces)
	}
	for index := range batchedTraces {
		if batchedTraces[index] != perRowTraces[index] {
			t.Fatalf("trace row %d: %s vs %s", index, batchedTraces[index], perRowTraces[index])
		}
	}

	stepQuery := `SELECT sequence, stepKey, nodeType, status, durationMs, inputCount, outputCount, rejectedCount
	FROM CrawlStrategyWorkflowRunStep WHERE runId = ? ORDER BY sequence ASC`
	batchedSteps := scanStepRows(t, db, stepQuery, batchedID)
	perRowSteps := scanStepRows(t, db, stepQuery, perRowID)
	if len(batchedSteps) != len(perRowSteps) || len(batchedSteps) != 2 {
		t.Fatalf("step rows: batched=%v perRow=%v", batchedSteps, perRowSteps)
	}
	for index := range batchedSteps {
		if batchedSteps[index] != perRowSteps[index] {
			t.Fatalf("step row %d: %s vs %s", index, batchedSteps[index], perRowSteps[index])
		}
	}
}

func scanCandidateRows(t *testing.T, db *sql.DB, query, runID string) []string {
	t.Helper()
	rows, err := db.Query(query, runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var candidateKey, externalID, sourceNodeID, sourceNodeType, url, title, status, metadata sql.NullString
		var traceCount int
		var relevance, score, freshness, quality sql.NullFloat64
		var publishedAt, crawledAt, effectiveAt sql.NullTime
		if err := rows.Scan(&candidateKey, &externalID, &sourceNodeID, &sourceNodeType, &url, &title, &status,
			&traceCount, &relevance, &score, &freshness, &quality, &publishedAt, &crawledAt, &effectiveAt, &metadata); err != nil {
			t.Fatal(err)
		}
		out = append(out, strings.Join([]string{candidateKey.String, externalID.String, sourceNodeID.String,
			sourceNodeType.String, url.String, title.String, status.String, itoaForTest(traceCount),
			nullableFloat(relevance), nullableFloat(score), nullableFloat(freshness), nullableFloat(quality),
			nullableDate(publishedAt), nullableDate(crawledAt), nullableDate(effectiveAt), metadata.String}, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func scanTraceRows(t *testing.T, db *sql.DB, query, runID string) []string {
	t.Helper()
	rows, err := db.Query(query, runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var sequence int
		var nodeID, action, message string
		if err := rows.Scan(&sequence, &nodeID, &action, &message); err != nil {
			t.Fatal(err)
		}
		out = append(out, itoaForTest(sequence)+"|"+nodeID+"|"+action+"|"+message)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func scanStepRows(t *testing.T, db *sql.DB, query, runID string) []string {
	t.Helper()
	rows, err := db.Query(query, runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var sequence, duration, inputCount, outputCount, rejectedCount int
		var stepKey, nodeType, status string
		if err := rows.Scan(&sequence, &stepKey, &nodeType, &status, &duration, &inputCount, &outputCount, &rejectedCount); err != nil {
			t.Fatal(err)
		}
		out = append(out, strings.Join([]string{itoaForTest(sequence), stepKey, nodeType, status,
			itoaForTest(duration), itoaForTest(inputCount), itoaForTest(outputCount), itoaForTest(rejectedCount)}, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func assertSequence(t *testing.T, db *sql.DB, table, runID string, want ...int) {
	t.Helper()
	rows, err := db.Query("SELECT sequence FROM "+table+" WHERE runId = ? ORDER BY sequence ASC", runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := []int{}
	for rows.Next() {
		var sequence int
		if err := rows.Scan(&sequence); err != nil {
			t.Fatal(err)
		}
		got = append(got, sequence)
	}
	if len(got) != len(want) {
		t.Fatalf("%s sequences = %v", table, got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("%s sequences = %v", table, got)
		}
	}
}

func timePointerForTest(value time.Time) *time.Time { return &value }

func itoaForTest(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func nullableFloat(value sql.NullFloat64) string {
	if !value.Valid {
		return ""
	}
	encoded, _ := json.Marshal(value.Float64)
	return string(encoded)
}

func nullableDate(value sql.NullTime) string {
	if !value.Valid {
		return ""
	}
	return value.Time.UTC().Format("2006-01-02T15:04:05.000Z")
}

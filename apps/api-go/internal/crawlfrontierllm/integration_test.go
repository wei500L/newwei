//go:build integration

package crawlfrontierllm

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// These tests run against the real MySQL 8.4 and Redis 7.2 services of the
// api-go-user-settings-integration job. They rebuild only the tables this
// chain touches and never start a NestJS worker.

type llmHarness struct {
	t       *testing.T
	db      *sql.DB
	redis   *redis.Client
	service *Service
	server  *httptest.Server
}

func newLLMHarness(t *testing.T) *llmHarness {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	addr := os.Getenv("API_GO_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	redisClient := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	h := &llmHarness{t: t, db: db, redis: redisClient}
	h.reset()
	t.Cleanup(func() {
		if h.server != nil {
			h.server.Close()
		}
		_ = redisClient.Close()
		_ = db.Close()
	})
	return h
}

func (h *llmHarness) reset() {
	h.t.Helper()
	// Only the Frontier-specific tables are recreated. CrawlTask and
	// SystemSetting are shared with earlier integration steps, so they are
	// created when missing and their rows are cleared/left alone.
	for _, table := range []string{
		"CrawlStrategyWorkflowRunCandidateTrace", "CrawlStrategyWorkflowRunCandidate",
		"CrawlStrategyWorkflowRunEvent", "CrawlStrategyWorkflowRunStep", "CrawlStrategyWorkflowRun",
		"CrawlFrontierNode", "CrawlFrontierRun", "CrawlSiteProfileVersion", "CrawlSiteProfile",
	} {
		if _, err := h.db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			h.t.Fatalf("drop %s: %v", table, err)
		}
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS CrawlTask (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, createdById VARCHAR(191) NOT NULL,
			newsSourceId VARCHAR(191) NULL, targetUrl VARCHAR(1024) NOT NULL, displayName VARCHAR(191) NULL,
			status VARCHAR(32) NOT NULL, timeRangeFrom DATETIME(3) NULL, timeRangeTo DATETIME(3) NULL,
			concurrency INT NOT NULL DEFAULT 1, keywords JSON NULL, config JSON NULL,
			lastRunAt DATETIME(3) NULL, lastSuccessAt DATETIME(3) NULL, lastResultAt DATETIME(3) NULL,
			lastCursor VARCHAR(191) NULL, lastError TEXT NULL, runCount INT NOT NULL DEFAULT 0,
			lastServerMemoryMb DOUBLE NULL, lastPeakMemoryMb DOUBLE NULL, lastMemoryEfficiency DOUBLE NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS SystemSetting (
			` + "`key`" + ` VARCHAR(191) PRIMARY KEY, value JSON NULL, isPublic TINYINT NOT NULL DEFAULT 0,
			description TEXT NULL, createdAt DATETIME(3) NULL, updatedAt DATETIME(3) NULL,
			updatedById VARCHAR(191) NULL)`,
		`CREATE TABLE CrawlSiteProfile (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL,
			description TEXT NULL, matchHost VARCHAR(191) NOT NULL, isActive TINYINT NOT NULL,
			executionMode VARCHAR(32) NOT NULL, workflowId VARCHAR(191) NULL,
			workflowVersionId VARCHAR(191) NULL, workflowBindingMode VARCHAR(32) NOT NULL,
			version INT NOT NULL, config JSON NOT NULL, createdById VARCHAR(191) NOT NULL,
			updatedById VARCHAR(191) NULL, publishedAt DATETIME(3) NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlSiteProfileVersion (
			id VARCHAR(191) PRIMARY KEY, profileId VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL,
			version INT NOT NULL, name VARCHAR(191) NOT NULL, description TEXT NULL,
			matchHost VARCHAR(191) NOT NULL, isActive TINYINT NOT NULL, executionMode VARCHAR(32) NOT NULL,
			workflowId VARCHAR(191) NULL, workflowVersionId VARCHAR(191) NULL,
			workflowBindingMode VARCHAR(32) NOT NULL, config JSON NOT NULL,
			createdById VARCHAR(191) NOT NULL, createdAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlFrontierRun (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, profileId VARCHAR(191) NULL,
			workflowRunId VARCHAR(191) NULL, seedUrl TEXT NOT NULL, crawlTaskId VARCHAR(191) NULL,
			executionMode VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, maxDepth INT NOT NULL,
			maxPages INT NOT NULL, keywords JSON NULL, pageCount INT NOT NULL, nodeCount INT NOT NULL,
			articleCount INT NOT NULL, failedCount INT NOT NULL, duplicateCount INT NOT NULL,
			nativeRunId VARCHAR(191) NULL, lastError TEXT NULL, metadata JSON NULL,
			createdById VARCHAR(191) NOT NULL, startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlFrontierNode (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, parentNodeId VARCHAR(191) NULL,
			orgId VARCHAR(191) NOT NULL, url TEXT NOT NULL, canonicalUrl TEXT NULL,
			urlFingerprint VARCHAR(64) NULL, pageType VARCHAR(32) NOT NULL, depth INT NOT NULL,
			queueClass VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, score DOUBLE NULL,
			freshnessScore DOUBLE NULL, attempts INT NOT NULL DEFAULT 0, queuedAt DATETIME(3) NULL,
			crawledAt DATETIME(3) NULL, crawlResultId VARCHAR(191) NULL, rejectionReason VARCHAR(191) NULL,
			lastError TEXT NULL, metadata JSON NULL, discoveredAt DATETIME(3) NOT NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
			UNIQUE KEY run_fingerprint (runId, urlFingerprint))`,
		`CREATE TABLE CrawlStrategyWorkflowRun (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, workflowId VARCHAR(191) NULL,
			workflowVersionId VARCHAR(191) NULL, workflowOrigin VARCHAR(32) NOT NULL,
			profileId VARCHAR(191) NULL, newsSourceId VARCHAR(191) NULL, status VARCHAR(32) NOT NULL,
			runKind VARCHAR(32) NOT NULL, input JSON NULL, output JSON NULL, graphSnapshot JSON NULL,
			stepResults JSON NULL, candidates JSON NULL, parameterSources JSON NULL, error TEXT NULL,
			stepCount INT NOT NULL, candidateCount INT NOT NULL, selectedCount INT NOT NULL,
			createdById VARCHAR(191) NOT NULL, startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlStrategyWorkflowRunStep (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, stepKey VARCHAR(191) NOT NULL,
			sequence INT NOT NULL, workflowNodeId VARCHAR(191) NULL, nodeType VARCHAR(64) NOT NULL,
			label VARCHAR(191) NOT NULL, status VARCHAR(32) NOT NULL, startedAt DATETIME(3) NULL,
			finishedAt DATETIME(3) NULL, durationMs INT NULL, inputCount INT NOT NULL,
			outputCount INT NOT NULL, rejectedCount INT NOT NULL, sampleUrls JSON NULL,
			metrics JSON NULL, error TEXT NULL, metadata JSON NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
			UNIQUE KEY run_step (runId, stepKey))`,
		`CREATE TABLE CrawlStrategyWorkflowRunEvent (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, sequence INT NOT NULL,
			level VARCHAR(32) NOT NULL, eventType VARCHAR(64) NOT NULL, nodeId VARCHAR(191) NULL,
			nodeType VARCHAR(64) NULL, message TEXT NOT NULL, triggerReason VARCHAR(191) NULL,
			beforeCount INT NULL, afterCount INT NULL, rescuedCount INT NULL, details JSON NULL,
			createdAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlStrategyWorkflowRunCandidate (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, candidateKey VARCHAR(191) NOT NULL,
			externalId VARCHAR(191) NULL, sourceNodeId VARCHAR(191) NULL, sourceNodeType VARCHAR(64) NULL,
			url TEXT NOT NULL, title VARCHAR(191) NULL, description TEXT NULL, author VARCHAR(191) NULL,
			pageType VARCHAR(32) NULL, relevanceScore DOUBLE NULL, score DOUBLE NULL,
			freshnessScore DOUBLE NULL, qualityScore DOUBLE NULL, publishedAt DATETIME(3) NULL,
			crawledAt DATETIME(3) NULL, effectiveAt DATETIME(3) NULL, status VARCHAR(32) NOT NULL,
			rejectedByNodeId VARCHAR(191) NULL, rejectedReason VARCHAR(191) NULL, metadata JSON NULL,
			traceCount INT NOT NULL, createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
			UNIQUE KEY run_candidate (runId, candidateKey))`,
		`CREATE TABLE CrawlStrategyWorkflowRunCandidateTrace (
			id VARCHAR(191) PRIMARY KEY, candidateId VARCHAR(191) NOT NULL, sequence INT NOT NULL,
			timestamp DATETIME(3) NOT NULL, nodeId VARCHAR(191) NOT NULL, nodeType VARCHAR(64) NOT NULL,
			action VARCHAR(32) NOT NULL, message TEXT NOT NULL, accepted TINYINT NULL,
			scoreDelta DOUBLE NULL, freshnessDelta DOUBLE NULL, ruleHits JSON NULL,
			beforeSnapshot JSON NULL, afterSnapshot JSON NULL, details JSON NULL)`,
	}
	for _, statement := range statements {
		if _, err := h.db.Exec(statement); err != nil {
			h.t.Fatalf("create table: %v\n%s", err, statement)
		}
	}
	if _, err := h.db.Exec("DELETE FROM CrawlTask"); err != nil {
		h.t.Fatalf("clear CrawlTask: %v", err)
	}
	if _, err := h.redis.FlushDB(context.Background()).Result(); err != nil {
		h.t.Fatalf("flush redis: %v", err)
	}
}

func (h *llmHarness) insertProfile(id, orgID, name, config, workflowRunID string) {
	h.t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := h.db.Exec(`INSERT INTO CrawlSiteProfile
		(id, orgId, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId,
		 workflowBindingMode, version, config, createdById, updatedById, publishedAt, createdAt, updatedAt)
		VALUES (?, ?, ?, NULL, 'example.com', 1, 'layered', NULL, NULL, 'published', 1, ?, 'actor-1', 'actor-1', ?, ?, ?)`,
		id, orgID, name, []byte(config), now, now, now)
	if err != nil {
		h.t.Fatalf("insert profile: %v", err)
	}
}

func (h *llmHarness) startLLM(content string, status int) {
	h.t.Helper()
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		if status != http.StatusOK {
			http.Error(w, "upstream failed", status)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "primary",
			"choices": []any{map[string]any{"message": map[string]any{
				"role": "assistant", "content": content,
			}}},
		})
	}))
}

func (h *llmHarness) buildService() {
	h.t.Helper()
	server := h.server
	profile := gatewayProfile{
		ID: "profile-1", APIBase: server.URL, Model: "primary",
		Timeout: 5 * time.Second, MaxRetries: 1, SendMetadata: true,
		ResponseFormatMode: "json_schema", APISurface: "chat_completions", TopP: 0.9,
	}
	llm := NewLLMClient(LLMClientOptions{
		DB: h.db, Sink: nil,
		ResolveProfile: func(ctx context.Context, kind string) (gatewayProfile, error) {
			if kind == "rerank" {
				return gatewayProfile{}, fmt.Errorf("rerank not configured")
			}
			return profile, nil
		},
	})
	producer := crawlqueue.NewProducer(crawlqueue.Options{Redis: h.redis, DB: h.db})
	h.service = New(Options{DB: h.db, Redis: h.redis, Enqueuer: producer, LLM: llm})
}

func (h *llmHarness) insertJudgeRun(orgID, runID, workflowRunID, profileID string) {
	h.t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := h.db.Exec(`INSERT INTO CrawlFrontierRun
		(id, orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status, maxDepth, maxPages,
		 keywords, pageCount, nodeCount, articleCount, failedCount, duplicateCount, nativeRunId, lastError,
		 metadata, createdById, startedAt, finishedAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, 'https://example.com', 'task-1', 'layered', 'running', 3, 10, '[]', 0, 1, 0, 0, 0,
		        NULL, NULL, '{}', 'actor-1', NULL, NULL, ?, ?)`,
		runID, orgID, nullableID(profileID), nullableID(workflowRunID), now, now)
	if err != nil {
		h.t.Fatalf("insert run: %v", err)
	}
	if workflowRunID != "" {
		_, err = h.db.Exec(`INSERT INTO CrawlStrategyWorkflowRun
			(id, orgId, workflowId, workflowVersionId, workflowOrigin, profileId, newsSourceId, status,
			 runKind, input, output, graphSnapshot, stepResults, candidates, parameterSources, error,
			 stepCount, candidateCount, selectedCount, createdById, startedAt, finishedAt, createdAt, updatedAt)
			VALUES (?, ?, NULL, NULL, 'bound', ?, NULL, 'running', 'frontier_run', '{}', NULL, '{}',
			        NULL, NULL, '[]', NULL, 0, 0, 0, 'actor-1', NULL, NULL, ?, ?)`,
			workflowRunID, orgID, nullableID(profileID), now, now)
		if err != nil {
			h.t.Fatalf("insert workflow run: %v", err)
		}
	}
	metadata := fmt.Sprintf(`{"pendingLlmJudgeJobs":1}`)
	if profileID == "" {
		metadata = `{"pendingLlmJudgeJobs":1}`
	}
	_, err = h.db.Exec(`INSERT INTO CrawlFrontierNode
		(id, runId, parentNodeId, orgId, url, canonicalUrl, urlFingerprint, pageType, depth, queueClass,
		 status, score, freshnessScore, attempts, queuedAt, crawledAt, crawlResultId, rejectionReason,
		 lastError, metadata, discoveredAt, createdAt, updatedAt)
		VALUES ('node-root', ?, NULL, ?, 'https://example.com', NULL, NULL, 'home', 0, 'hot', 'queued',
		        NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
		runID, orgID, []byte(metadata), now, now, now)
	if err != nil {
		h.t.Fatalf("insert node: %v", err)
	}
}

func (h *llmHarness) nodeMetadata(nodeID string) *Object {
	h.t.Helper()
	var raw []byte
	if err := h.db.QueryRow("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", nodeID).Scan(&raw); err != nil {
		h.t.Fatalf("read node metadata: %v", err)
	}
	object, _ := ParseObject(raw)
	if object == nil {
		h.t.Fatalf("node metadata is not an object: %s", raw)
	}
	return object
}

func (h *llmHarness) scalar(query string, args ...any) string {
	h.t.Helper()
	var value sql.NullString
	if err := h.db.QueryRow(query, args...).Scan(&value); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	return value.String
}

func TestFrontierLlmJudgeIntegration(t *testing.T) {
	h := newLLMHarness(t)
	config := `{"llmAssist":{"enabled":true},"layeredOptions":{"maxDepth":3,"maxPages":10}}`
	h.insertProfile("profile-1", "org-1", "Example", config, "")
	h.insertJudgeRun("org-1", "run-1", "wf-1", "profile-1")
	h.startLLM(`{"decisions":[{"url":"https://example.com/a","action":"fetch","pageType":"article","confidence":0.9}]}`, http.StatusOK)
	h.buildService()

	_, err := h.service.ProcessQueuedLlmJudge(context.Background(), "org-1", LlmJudgePayload{
		Mode: JudgeModeSeed, RunID: "run-1", NodeID: "node-root", TaskID: "task-1", MaxDepth: 3, MaxPages: 10,
		Candidates: []Candidate{{URL: "https://example.com/a", PageType: "article", Score: 0.5,
			FreshnessScore: 1, Metadata: json.RawMessage(`{}`)}},
		SeedContext: &SeedContext{DiscoveredCount: 1},
	})
	if err != nil {
		t.Fatalf("judge: %v", err)
	}
	// The new node exists exactly once, is queued and belongs to the run.
	var nodeCount int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM CrawlFrontierNode WHERE runId = 'run-1' AND url = 'https://example.com/a'").Scan(&nodeCount); err != nil {
		t.Fatal(err)
	}
	if nodeCount != 1 {
		t.Fatalf("materialized nodes = %d", nodeCount)
	}
	metadata := h.nodeMetadata("node-root")
	if pending := ResolvePendingLlmJudgeJobs(metadata); pending != 0 {
		t.Fatalf("pendingLlmJudgeJobs = %d", pending)
	}
	flags, _ := metadata.Strings("warningFlags")
	for _, flag := range flags {
		if flag == "llm_judge_deferred" || flag == "llm_judge_failed" {
			t.Fatalf("warningFlags = %v", flags)
		}
	}
	// The workflow recorded the started/resolved events and the judge step.
	if got := h.scalar("SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = 'wf-1' AND eventType = 'llm_judge_started'"); got != "1" {
		t.Fatalf("llm_judge_started = %s", got)
	}
	if got := h.scalar("SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = 'wf-1' AND eventType = 'llm_judge_resolved'"); got != "1" {
		t.Fatalf("llm_judge_resolved = %s", got)
	}
	if got := h.scalar("SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep WHERE runId = 'wf-1' AND stepKey = 'frontier:node-root:llm-judge:seed'"); got != "1" {
		t.Fatalf("judge step = %s", got)
	}
	// The article child node is enqueued to the normal crawl4ai queue with the
	// NodeJS job id shape.
	waiting, err := h.redis.LRange(context.Background(), "bull:crawl4ai-normal:wait", 0, -1).Result()
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 1 {
		t.Fatalf("hot wait = %v", waiting)
	}
	if !strings.Contains(waiting[0], "-normal") {
		t.Fatalf("job id = %q", waiting[0])
	}
	if got := h.scalar("SELECT nodeCount FROM CrawlFrontierRun WHERE id = 'run-1'"); got != "2" {
		t.Fatalf("run nodeCount = %s", got)
	}
}

func TestFrontierLlmJudgeB1CleanupIntegration(t *testing.T) {
	h := newLLMHarness(t)
	// No profile row and no profileId: resolveEffectiveProfileForUrl returns
	// null, so the judge fails after the node was loaded.
	h.insertJudgeRun("org-1", "run-1", "", "")
	// The root node completed and deferred its candidates to the judge queue.
	if _, err := h.db.Exec("UPDATE CrawlFrontierNode SET status = 'completed' WHERE id = 'node-root'"); err != nil {
		t.Fatal(err)
	}
	h.startLLM(`{}`, http.StatusOK)
	h.buildService()

	_, err := h.service.ProcessQueuedLlmJudge(context.Background(), "org-1", LlmJudgePayload{
		Mode: JudgeModeSeed, RunID: "run-1", NodeID: "node-root", TaskID: "task-1", MaxDepth: 3, MaxPages: 10,
		Candidates: []Candidate{{URL: "https://example.com/a", PageType: "article", Metadata: json.RawMessage(`{}`)}},
	})
	if err == nil {
		t.Fatal("judge must fail without a site profile")
	}
	metadata := h.nodeMetadata("node-root")
	if pending := ResolvePendingLlmJudgeJobs(metadata); pending != 0 {
		t.Fatalf("pendingLlmJudgeJobs = %d after cleanup", pending)
	}
	flags, _ := metadata.Strings("warningFlags")
	if !containsString(flags, "llm_judge_job_failed") {
		t.Fatalf("warningFlags = %v", flags)
	}
	// The run can now reach a terminal status instead of staying active.
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = 'run-1'"); got != "failed" {
		t.Fatalf("run status = %s", got)
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierRun WHERE id = 'run-1'"); got != "no_frontier_candidates_discovered" {
		t.Fatalf("lastError = %s", got)
	}
}

func TestFrontierLlmLearnIntegration(t *testing.T) {
	h := newLLMHarness(t)
	config := `{"llmAssist":{"enabled":true}}`
	h.insertProfile("profile-1", "org-1", "Example", config, "")
	h.insertJudgeRun("org-1", "run-1", "wf-1", "profile-1")
	if _, err := h.db.Exec("UPDATE CrawlFrontierRun SET status = 'completed', pageCount = 1, articleCount = 1 WHERE id = 'run-1'"); err != nil {
		t.Fatal(err)
	}
	h.startLLM(`{"confidence":0.5,"rationale":"steady"}`, http.StatusOK)
	h.buildService()

	if _, err := h.service.ProcessQueuedLlmLearn(context.Background(), "org-1", LlmLearnPayload{RunID: "run-1"}); err != nil {
		t.Fatalf("learn: %v", err)
	}
	var raw []byte
	if err := h.db.QueryRow("SELECT metadata FROM CrawlFrontierRun WHERE id = 'run-1'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	metadata, _ := ParseObject(raw)
	lifecycle, ok := metadata.Object("llmLifecycle")
	if !ok {
		t.Fatalf("llmLifecycle missing: %s", raw)
	}
	if got, _ := lifecycle.String("learnHandledKey"); got != "completed:1:1:0:0" {
		t.Fatalf("learnHandledKey = %q", got)
	}
	if _, ok := lifecycle.String("learnHandledAt"); !ok {
		t.Fatal("learnHandledAt missing")
	}
}

func TestFrontierLlmLearnFailureRetriesOnceIntegration(t *testing.T) {
	h := newLLMHarness(t)
	config := `{"llmAssist":{"enabled":true}}`
	h.insertProfile("profile-1", "org-1", "Example", config, "")
	h.insertJudgeRun("org-1", "run-1", "wf-1", "profile-1")
	h.startLLM(`{}`, http.StatusInternalServerError)
	h.buildService()

	if _, err := h.service.ProcessQueuedLlmLearn(context.Background(), "org-1", LlmLearnPayload{RunID: "run-1"}); err != nil {
		t.Fatalf("learn failure must be absorbed: %v", err)
	}
	var raw []byte
	if err := h.db.QueryRow("SELECT metadata FROM CrawlFrontierRun WHERE id = 'run-1'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	metadata, _ := ParseObject(raw)
	lifecycle, _ := metadata.Object("llmLifecycle")
	if count, _ := lifecycle.Number("learnRetryCount"); count != 1 {
		t.Fatalf("learnRetryCount = %v", count)
	}
	if errorText, _ := lifecycle.String("learnError"); errorText == "" {
		t.Fatal("learnError missing")
	}
	if !lifecycle.Has("learnQueuedKey") {
		t.Fatal("learnQueuedKey must be cleared (present as null)")
	}
	if raw, ok := lifecycle.Raw("learnQueuedKey"); !ok || string(raw) != "null" {
		t.Fatalf("learnQueuedKey = %s", raw)
	}
	learnWait, err := h.redis.LLen(context.Background(), "bull:frontier-llm-learn:wait").Result()
	if err != nil {
		t.Fatal(err)
	}
	if learnWait != 1 {
		t.Fatalf("learn retry jobs = %d, want 1", learnWait)
	}
	// The second failure observes learnRetryCount=1 and must not enqueue again.
	if _, err := h.service.ProcessQueuedLlmLearn(context.Background(), "org-1", LlmLearnPayload{RunID: "run-1"}); err != nil {
		t.Fatalf("second learn failure: %v", err)
	}
	learnWait, err = h.redis.LLen(context.Background(), "bull:frontier-llm-learn:wait").Result()
	if err != nil {
		t.Fatal(err)
	}
	if learnWait != 1 {
		t.Fatalf("learn retry jobs after second failure = %d, want 1", learnWait)
	}
}

func TestFrontierLlmTenantIsolationIntegration(t *testing.T) {
	h := newLLMHarness(t)
	config := `{"llmAssist":{"enabled":true}}`
	h.insertProfile("profile-1", "org-1", "Example", config, "")
	h.insertJudgeRun("org-1", "run-1", "", "profile-1")
	h.startLLM(`{}`, http.StatusOK)
	h.buildService()
	before := h.scalar("SELECT metadata FROM CrawlFrontierNode WHERE id = 'node-root'")
	_, err := h.service.ProcessQueuedLlmJudge(context.Background(), "org-2", LlmJudgePayload{
		Mode: JudgeModeSeed, RunID: "run-1", NodeID: "node-root", TaskID: "task-1", MaxDepth: 3, MaxPages: 10,
		Candidates: []Candidate{{URL: "https://example.com/a", PageType: "article", Metadata: json.RawMessage(`{}`)}},
	})
	if err == nil {
		t.Fatal("cross-tenant judge must fail")
	}
	after := h.scalar("SELECT metadata FROM CrawlFrontierNode WHERE id = 'node-root'")
	if before != after {
		t.Fatalf("cross-tenant write: before=%s after=%s", before, after)
	}
	if got := h.scalar("SELECT COUNT(*) FROM CrawlFrontierNode WHERE runId = 'run-1'"); got != "1" {
		t.Fatalf("nodes = %s", got)
	}
}

func TestFrontierLlmLimiterIntegration(t *testing.T) {
	h := newLLMHarness(t)
	producer := crawlqueue.NewProducer(crawlqueue.Options{Redis: h.redis, DB: h.db})
	for index := 0; index < 3; index++ {
		if err := producer.EnqueueFrontierLlmLearn(context.Background(), crawlqueue.EnqueueFrontierLlmLearnOptions{
			OrgID: "org-1", TaskID: "task-1", RunID: fmt.Sprintf("run-%d", index),
		}); err != nil {
			t.Fatalf("enqueue %d: %v", index, err)
		}
	}
	blockingAddr := os.Getenv("API_GO_TEST_REDIS_ADDR")
	blocking := redis.NewClient(&redis.Options{Addr: blockingAddr, Protocol: 2})
	defer blocking.Close()
	var mu sync.Mutex
	started := make([]time.Time, 0, 3)
	processor := func(ctx context.Context, data JobData) (any, error) {
		mu.Lock()
		started = append(started, time.Now())
		mu.Unlock()
		return CrawlExecutionSummary{}, nil
	}
	worker, err := newWorker(LearnQueueName, h.redis, blocking, processor)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		mu.Lock()
		count := len(started)
		mu.Unlock()
		if count >= 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = worker.Close(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if len(started) != 3 {
		t.Fatalf("processed = %d, want 3", len(started))
	}
	for index := 1; index < len(started); index++ {
		gap := started[index].Sub(started[index-1])
		if gap < 900*time.Millisecond {
			t.Fatalf("job %d started after %s, limiter must leave >=1s", index, gap)
		}
	}
}

func nullableID(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

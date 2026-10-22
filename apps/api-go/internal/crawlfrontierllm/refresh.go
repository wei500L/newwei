package crawlfrontierllm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// refresh.go ports CrawlFrontierService.refreshRunStatus and
// handleTerminalRunLifecycle. refreshRunStatus is the shared write both NestJS
// crawl workers and the Go judge worker call; like NestJS it is a plain
// read-compute-write with no new lock (Q2: the same race already exists between
// two NestJS workers).

// refreshRunStatus recomputes the run counters and triggers the lifecycle.
func (s *Service) refreshRunStatus(ctx context.Context, runID string) error {
	run, err := s.loadRun(ctx, runID)
	if err != nil {
		return err
	}
	if run == nil {
		return nil
	}
	nodes, err := s.listRefreshNodes(ctx, runID)
	if err != nil {
		return err
	}
	aggregate := aggregateRefreshNodes(nodes)
	nodeCount := aggregate.NodeCount
	pageCount := aggregate.PageCount
	articleCount := aggregate.ArticleCount
	failedCount := aggregate.FailedCount
	duplicateCount := aggregate.DuplicateCount
	activeNodeCount := aggregate.ActiveNodeCount
	pendingLlmJudgeJobs := aggregate.PendingLlmJudgeJobs
	activeCount := activeNodeCount + pendingLlmJudgeJobs
	rootOnlyNoExpansion := activeCount == 0 && nodeCount <= 1 && pageCount <= 1 &&
		articleCount == 0 && failedCount == 0
	coverageByPageType := aggregate.CoverageByPageType
	coverageByDepth := aggregate.CoverageByDepth
	candidateStats := aggregate.CandidateStats
	rejectionCounts := aggregate.RejectionCounts
	warningFlags := aggregate.WarningFlags
	warningFlagSet := aggregate.warningFlagSet()
	failureKindCounts := aggregate.FailureKindCounts
	judgeMethodCounts := aggregate.JudgeMethodCounts
	judgeConfidenceTotal := aggregate.JudgeConfidenceTotal
	judgeConfidenceCount := aggregate.JudgeConfidenceCount
	rootDiagnosis := aggregate.RootDiagnosis

	status := run.Status
	lastError := ""
	if run.LastError != nil {
		lastError = *run.LastError
	}
	failureKind := topCountKey(failureKindCounts)
	if run.Status != "canceled" && activeCount == 0 {
		if rootOnlyNoExpansion {
			status = "failed"
			resolved := ""
			if rootDiagnosis != nil {
				resolved, _ = rootDiagnosis.String("failureKind")
			}
			if resolved == "" {
				if _, ok := warningFlagSet["challenge_detected"]; ok {
					resolved = "challenge_detected"
				} else {
					resolved = "no_frontier_candidates"
				}
			}
			failureKind = resolved
			if resolved == "challenge_detected" {
				lastError = "challenge_detected"
			} else {
				lastError = "no_frontier_candidates_discovered"
			}
		} else {
			switch {
			case pageCount > 0:
				status = "completed"
			case failedCount > 0:
				status = "failed"
			}
			if status == "completed" && failedCount == 0 {
				lastError = ""
			} else if lastError == "" && failureKind != "" {
				lastError = failureKind
			}
		}
	}
	if status == "completed" && failedCount == 0 {
		failureKind = ""
	}

	flags := warningFlags
	mergedWarningFlags := uniqueStringList(metadataStrings(run.Metadata, "warningFlags"), flags)
	if mergedWarningFlags == nil {
		mergedWarningFlags = []string{}
	}
	patch := NewObject()
	patch.SetRaw("candidateStats", mustJSON(candidateStats))
	patch.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
	patch.Set("warningFlags", mergedWarningFlags)
	if failureKind != "" {
		patch.SetString("failureKind", failureKind)
	} else {
		patch.SetNull("failureKind")
	}
	copyRootDiagnosisSeed(patch, rootDiagnosis)
	judgeSummary := NewObject()
	judgeSummary.SetRaw("methods", mustJSON(judgeMethodCounts))
	if judgeConfidenceCount > 0 {
		judgeSummary.SetNumber("averageConfidence", roundToFixed(judgeConfidenceTotal/float64(judgeConfidenceCount), 4))
	} else {
		judgeSummary.SetNull("averageConfidence")
	}
	judgeSummary.SetNumber("count", float64(judgeConfidenceCount))
	patch.SetRaw("judgeSummary", mustJSON(judgeSummary))
	coverage := NewObject()
	coverage.SetRaw("byPageType", mustJSON(coverageByPageType))
	coverage.SetRaw("byDepth", mustJSON(coverageByDepth))
	patch.SetRaw("coverage", mustJSON(coverage))
	patch.SetNumber("llmPendingJudgeJobs", float64(pendingLlmJudgeJobs))
	if rootDiagnosis != nil {
		patch.SetRaw("rootDiagnosis", mustJSON(rootDiagnosis))
	} else {
		patch.SetNull("rootDiagnosis")
	}
	var finishedAt *time.Time
	if activeCount == 0 && status != "running" && status != "queued" {
		value := truncateMillis(s.now())
		finishedAt = &value
	}
	var lastErrorValue sql.NullString
	if lastError != "" {
		lastErrorValue = sql.NullString{String: lastError, Valid: true}
	}
	var finishedAtValue sql.NullTime
	if finishedAt != nil {
		finishedAtValue = sql.NullTime{Time: *finishedAt, Valid: true}
	}
	mergedMetadata, err := s.writeRunRefreshLocked(ctx, runID, runRefreshUpdate{
		Status: status, LastError: lastErrorValue, NodeCount: nodeCount, PageCount: pageCount,
		ArticleCount: articleCount, FailedCount: failedCount, DuplicateCount: duplicateCount,
		FinishedAt: finishedAtValue, MetadataPatch: patch,
	})
	if err != nil {
		return err
	}

	if run.WorkflowRunID != nil {
		countsPatch := NewObject()
		countsPatch.SetString("frontierRunId", runID)
		countsPatch.SetString("frontierStatus", status)
		countsPatch.SetNumber("nodeCount", float64(nodeCount))
		countsPatch.SetNumber("pageCount", float64(pageCount))
		countsPatch.SetNumber("articleCount", float64(articleCount))
		countsPatch.SetNumber("failedCount", float64(failedCount))
		countsPatch.SetNumber("duplicateCount", float64(duplicateCount))
		countsPatch.SetNumber("activeCount", float64(activeCount))
		countsPatch.SetNumber("pendingLlmJudgeJobs", float64(pendingLlmJudgeJobs))
		countsPatch.SetRaw("candidateStats", mustJSON(candidateStats))
		countsPatch.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
		countsPatch.Set("warningFlags", flags)
		if failureKind != "" {
			countsPatch.SetString("failureKind", failureKind)
		} else {
			countsPatch.SetNull("failureKind")
		}
		if err := s.UpdateRunCounts(ctx, *run.WorkflowRunID, countsPatch); err != nil {
			return err
		}
		workflowStatus := "queued"
		switch status {
		case "completed", "failed", "canceled":
			workflowStatus = status
		default:
			if activeCount > 0 {
				workflowStatus = "running"
			}
		}
		var errorValue *string
		if lastError != "" {
			errorValue = &lastError
		}
		if err := s.MarkRunStatus(ctx, *run.WorkflowRunID, workflowStatus, errorValue, finishedAt); err != nil {
			return err
		}
		if status != run.Status && (status == "completed" || status == "failed" || status == "canceled") {
			level := "info"
			if status == "failed" {
				level = "error"
			} else if status == "canceled" {
				level = "warn"
			}
			details := NewObject()
			details.SetString("frontierRunId", runID)
			details.SetRaw("candidateStats", mustJSON(candidateStats))
			details.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
			eventTime := s.nowISO()
			if finishedAt != nil {
				eventTime = nestISOString(*finishedAt)
			}
			if err := s.AppendEvent(ctx, *run.WorkflowRunID, WorkflowEvent{
				Level: level, EventType: "frontier_run_terminal",
				NodeType: stringPointer("legacy.frontier_run"),
				Message:  "Frontier run " + status, TriggerReason: stringOrNil(failureKind),
				BeforeCount: intPointer(nodeCount), AfterCount: intPointer(pageCount),
				RescuedCount: intPointer(articleCount), Details: details, Timestamp: eventTime,
			}); err != nil {
				return err
			}
		}
	}

	if activeCount == 0 && status != "running" && status != "queued" {
		return s.handleTerminalRunLifecycle(ctx, runID, terminalSummary{
			Status: status, Metadata: mergedMetadata, ArticleCount: articleCount,
			PageCount: pageCount, FailedCount: failedCount, DuplicateCount: duplicateCount,
		})
	}
	return nil
}

// runRefreshUpdate is the CrawlFrontierRun projection refreshRunStatus writes.
// The metadata patch is applied under the row lock by writeRunRefreshLocked, so
// it is kept apart from the derived counter columns.
type runRefreshUpdate struct {
	Status         string
	LastError      sql.NullString
	NodeCount      int
	PageCount      int
	ArticleCount   int
	FailedCount    int
	DuplicateCount int
	FinishedAt     sql.NullTime
	MetadataPatch  *Object
}

// writeRunRefreshLocked writes the run projection and merges the metadata patch
// in one transaction whose first statement locks the run row (B1).
//
// NestJS reads the metadata document at the start of refreshRunStatus and writes
// the merged result at the end, so every metadata key another writer added in
// between (the learn chain's llmLifecycle/shadowRunId/shadowEvaluationTriggeredAt,
// the judge cleanup, a concurrent refresh) is silently dropped. Dropping
// shadowEvaluationTriggeredAt in particular makes the next terminal lifecycle
// start a second shadow run. Merging against the locked document closes that
// window while keeping the same merge semantics and the same single UPDATE for
// the derived counter columns.
//
// The merged document is returned because handleTerminalRunLifecycle evaluates
// its handledKey/learnQueuedKey guards on it.
func (s *Service) writeRunRefreshLocked(ctx context.Context, runID string, update runRefreshUpdate) (*Object, error) {
	if s.db == nil {
		return nil, errNoDB()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var raw []byte
	scanErr := tx.QueryRowContext(ctx,
		"SELECT metadata FROM CrawlFrontierRun WHERE id = ? FOR UPDATE", runID).Scan(&raw)
	if scanErr != nil && !errors.Is(scanErr, sql.ErrNoRows) {
		return nil, scanErr
	}
	merged := mergeObjects(parseObjectOrNil(raw), update.MetadataPatch)
	if merged == nil {
		merged = NewObject()
	}
	encoded, err := merged.MarshalJSON()
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE CrawlFrontierRun
SET status = ?, lastError = ?, metadata = ?, nodeCount = ?, pageCount = ?, articleCount = ?,
    failedCount = ?, duplicateCount = ?, finishedAt = ?, updatedAt = ?
WHERE id = ?`,
		update.Status, update.LastError, encoded, update.NodeCount, update.PageCount,
		update.ArticleCount, update.FailedCount, update.DuplicateCount, update.FinishedAt,
		truncateMillis(s.now()), runID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return merged, nil
}

type terminalSummary struct {
	Status         string
	Metadata       *Object
	ArticleCount   int
	PageCount      int
	FailedCount    int
	DuplicateCount int
}

// handleTerminalRunLifecycle ports handleTerminalRunLifecycle.
func (s *Service) handleTerminalRunLifecycle(ctx context.Context, runID string, summary terminalSummary) error {
	if s.llm == nil {
		return nil
	}
	run, err := s.loadRun(ctx, runID)
	if err != nil {
		return err
	}
	if run == nil || run.ProfileID == nil {
		return nil
	}
	profile, err := s.loadProfile(ctx, *run.ProfileID, run.OrgID)
	if err != nil {
		return err
	}
	if profile == nil {
		return nil
	}
	nodes, err := s.listNodesForLifecycle(ctx, runID)
	if err != nil {
		return err
	}
	// The re-read document is the one the lock-protected write just produced, so
	// the handledKey/learnQueuedKey guards below evaluate the committed metadata
	// (the NestJS terminal lifecycle reads run.metadata from its own re-read too).
	runMetadata := objectOrEmpty(run.Metadata)
	lifecycle := NewObject()
	if value, ok := runMetadata.Object("llmLifecycle"); ok {
		lifecycle = value
	}
	handledKey := terminalHandledKey(summary)
	if value, ok := lifecycle.String("handledKey"); ok && value == handledKey {
		return nil
	}
	learningAssist := ResolveEffectiveLlmAssistConfig(profile.Config, LlmPurposeLearn)
	runRole := "active"
	if value, ok := runMetadata.String("runRole"); ok {
		runRole = value
	} else if profile.Config != nil {
		if assist, ok := profile.Config.Object("llmAssist"); ok {
			if shadow, ok := assist.Object("shadow"); ok {
				if role, ok := shadow.String("role"); ok && role == "shadow" {
					runRole = "shadow"
				}
			}
		}
	}
	if learningAssist == nil {
		patch := NewObject()
		patch.SetRaw("llmLifecycle", mustJSON(NewObjectFromPairs(
			"handledAt", s.nowISO(), "handledKey", handledKey, "role", runRole,
		)))
		return s.updateRunMetadata(ctx, runID, patch)
	}
	learnInput := LearnInput{
		OrgID: run.OrgID,
		Run: LearnRun{
			ID: run.ID, SeedURL: run.SeedURL, Status: summary.Status,
			MaxDepth: run.MaxDepth, MaxPages: run.MaxPages,
			ArticleCount: summary.ArticleCount, PageCount: summary.PageCount,
			FailedCount: summary.FailedCount, DuplicateCount: summary.DuplicateCount,
			Metadata: summary.Metadata,
		},
		Profile: *profile,
		Nodes:   nodes,
	}
	if runRole == "shadow" {
		if err := s.handleShadowRunCompletion(ctx, learnInput, *profile, learnInput.Run); err != nil {
			return err
		}
		patch := NewObject()
		patch.SetRaw("llmLifecycle", mustJSON(NewObjectFromPairs(
			"handledAt", s.nowISO(), "handledKey", handledKey, "role", runRole,
		)))
		return s.updateRunMetadata(ctx, runID, patch)
	}
	if value, ok := lifecycle.String("learnQueuedKey"); ok && value == handledKey {
		return nil
	}
	taskID := run.ID
	if run.CrawlTaskID != nil && *run.CrawlTaskID != "" {
		taskID = *run.CrawlTaskID
	}
	if s.enqueuer != nil {
		if err := s.enqueuer.EnqueueFrontierLlmLearn(ctx, crawlqueue.EnqueueFrontierLlmLearnOptions{
			OrgID: run.OrgID, TaskID: taskID, RunID: runID,
		}); err != nil {
			return err
		}
	}
	next := lifecycle.Clone()
	next.SetString("learnQueuedAt", s.nowISO())
	next.SetString("learnQueuedKey", handledKey)
	next.SetString("role", runRole)
	patch := NewObject()
	patch.SetRaw("llmLifecycle", mustJSON(next))
	return s.updateRunMetadata(ctx, runID, patch)
}

func terminalHandledKey(summary terminalSummary) string {
	return summary.Status + ":" + itoaInt(summary.ArticleCount) + ":" + itoaInt(summary.PageCount) +
		":" + itoaInt(summary.FailedCount) + ":" + itoaInt(summary.DuplicateCount)
}

// buildRootDiagnosis ports the rootDiagnosis object literal.
func buildRootDiagnosis(metadata *Object, node refreshNode) *Object {
	out := NewObject()
	var failureKind *string
	if value, ok := metadata.String("failureKind"); ok {
		failureKind = &value
	} else if classified := ClassifyFrontierFailureKind(node.LastError); classified != nil {
		failureKind = classified
	}
	out.SetRaw("failureKind", nullableRawString(failureKind))
	out.Set("warningFlags", CollectNodeWarningFlags(metadata, node.LastError))
	candidateStats, _ := metadata.Object("candidateStats")
	out.SetRaw("candidateStats", nullableObject(candidateStats))
	rejectionCounts, _ := metadata.Object("rejectionCounts")
	out.SetRaw("rejectionCounts", nullableObject(rejectionCounts))
	if node.LastError != nil {
		out.SetString("lastError", *node.LastError)
	} else {
		out.SetNull("lastError")
	}
	out.SetRaw("llmJudgeEnabled", boolLeafOrNull(metadata, "llmJudgeEnabled"))
	out.SetRaw("llmJudgeAttempted", boolLeafOrNull(metadata, "llmJudgeAttempted"))
	out.SetRaw("llmJudgeParsed", boolLeafOrNull(metadata, "llmJudgeParsed"))
	out.SetRaw("llmJudgeError", stringLeafOrNull(metadata, "llmJudgeError"))
	out.SetRaw("llmJudgeBudget", numberLeafOrNull(metadata, "llmJudgeBudget"))
	out.SetNumber("pendingLlmJudgeJobs", float64(ResolvePendingLlmJudgeJobs(metadata)))
	out.SetRaw("retryDemotedToNormal", boolLeafOrNull(metadata, "retryDemotedToNormal"))
	out.SetRaw("retryDemotedFromQueue", stringLeafOrNull(metadata, "retryDemotedFromQueue"))
	out.SetRaw("retryDemotedAt", stringLeafOrNull(metadata, "retryDemotedAt"))
	out.SetRaw("seedStrategy", stringLeafOrNull(metadata, "seedStrategy"))
	out.SetRaw("seedOrigin", stringLeafOrNull(metadata, "seedOrigin"))
	out.SetRaw("seedMethod", stringLeafOrNull(metadata, "seedMethod"))
	out.SetRaw("seedDiscoveryMode", stringLeafOrNull(metadata, "seedDiscoveryMode"))
	out.SetRaw("fallbackStage", stringLeafOrNull(metadata, "fallbackStage"))
	for _, key := range []string{"seedYield", "seedQuality", "seedDiagnostics"} {
		if value, ok := metadata.Object(key); ok {
			out.SetRaw(key, mustJSON(value))
		} else {
			out.SetNull(key)
		}
	}
	out.SetRaw("nativeStrategyType", stringLeafOrNull(metadata, "nativeStrategyType"))
	out.SetRaw("nativeStrategyResolvedFrom", stringLeafOrNull(metadata, "nativeStrategyResolvedFrom"))
	out.SetRaw("nativeStrategyAutoResolved", boolLeafOrNull(metadata, "nativeStrategyAutoResolved"))
	out.SetRaw("nativeFilterChainType", stringLeafOrNull(metadata, "nativeFilterChainType"))
	out.SetRaw("nativeUrlScorerType", stringLeafOrNull(metadata, "nativeUrlScorerType"))
	out.SetRaw("nativeAdaptiveType", stringLeafOrNull(metadata, "nativeAdaptiveType"))
	out.SetRaw("nativeFilterChainSynthesized", boolLeafOrNull(metadata, "nativeFilterChainSynthesized"))
	out.SetRaw("nativeUrlScorerSynthesized", boolLeafOrNull(metadata, "nativeUrlScorerSynthesized"))
	out.SetRaw("linkPreviewMode", stringLeafOrNull(metadata, "linkPreviewMode"))
	out.SetRaw("linkPreviewQuery", stringLeafOrNull(metadata, "linkPreviewQuery"))
	out.SetRaw("domScopeMode", stringLeafOrNull(metadata, "domScopeMode"))
	out.SetRaw("waitForMode", stringLeafOrNull(metadata, "waitForMode"))
	out.SetRaw("markdownFilterMode", stringLeafOrNull(metadata, "markdownFilterMode"))
	out.SetRaw("markdownFilterType", stringLeafOrNull(metadata, "markdownFilterType"))
	out.SetRaw("localeMode", stringLeafOrNull(metadata, "localeMode"))
	out.SetRaw("localeValue", stringLeafOrNull(metadata, "localeValue"))
	out.SetRaw("acceptLanguageMode", stringLeafOrNull(metadata, "acceptLanguageMode"))
	return out
}

// copyRootDiagnosisSeed copies the root seed fields refreshRunStatus hoists onto
// the run metadata.
func copyRootDiagnosisSeed(patch *Object, root *Object) {
	if root == nil {
		return
	}
	for _, key := range []string{"seedStrategy", "seedOrigin", "seedMethod", "seedDiscoveryMode", "fallbackStage"} {
		if value, ok := root.String(key); ok {
			patch.SetString(key, value)
		}
	}
	for _, key := range []string{"seedYield", "seedQuality", "seedDiagnostics"} {
		if value, ok := root.Object(key); ok {
			patch.SetRaw(key, mustJSON(value))
		}
	}
}

func topCountKey(counts *Object) string {
	if counts == nil || counts.Len() == 0 {
		return ""
	}
	type entry struct {
		key   string
		count float64
	}
	entries := make([]entry, 0, counts.Len())
	for _, key := range counts.Keys() {
		value, _ := counts.Number(key)
		entries = append(entries, entry{key: key, count: value})
	}
	// right-left desc, then localeCompare asc (the NestJS sort).
	best := entries[0]
	for _, candidate := range entries[1:] {
		if candidate.count > best.count || (candidate.count == best.count && candidate.key < best.key) {
			best = candidate
		}
	}
	return best.key
}

func boolLeafOrNull(metadata *Object, key string) json.RawMessage {
	if value, ok := metadata.Bool(key); ok {
		return mustJSON(value)
	}
	return json.RawMessage("null")
}

func stringLeafOrNull(metadata *Object, key string) json.RawMessage {
	if value, ok := metadata.String(key); ok {
		return mustJSON(value)
	}
	return json.RawMessage("null")
}

func numberLeafOrNull(metadata *Object, key string) json.RawMessage {
	if value, ok := metadata.Number(key); ok {
		return numberJSON(value)
	}
	return json.RawMessage("null")
}

// refreshAggregate is the pure aggregation refreshRunStatus performs on the
// node projection. Keeping it separate makes the counts, coverage, warning
// flags and root diagnosis testable without a database.
type refreshAggregate struct {
	NodeCount            int
	PageCount            int
	ArticleCount         int
	FailedCount          int
	DuplicateCount       int
	ActiveNodeCount      int
	PendingLlmJudgeJobs  int
	CoverageByPageType   *Object
	CoverageByDepth      *Object
	CandidateStats       *Object
	RejectionCounts      *Object
	WarningFlags         []string
	FailureKindCounts    *Object
	JudgeMethodCounts    *Object
	JudgeConfidenceTotal float64
	JudgeConfidenceCount int
	RootDiagnosis        *Object
}

func (a refreshAggregate) warningFlagSet() map[string]struct{} {
	set := make(map[string]struct{}, len(a.WarningFlags))
	for _, flag := range a.WarningFlags {
		set[flag] = struct{}{}
	}
	return set
}

func aggregateRefreshNodes(nodes []refreshNode) refreshAggregate {
	aggregate := refreshAggregate{
		CoverageByPageType: newPageTypeCountObject(),
		CoverageByDepth:    NewObject(),
		CandidateStats: NewObjectFromPairs(
			"scanned", 0, "unique", 0, "accepted", 0, "selected", 0, "rejected", 0, "trimmed", 0,
		),
		RejectionCounts:   NewObject(),
		WarningFlags:      make([]string, 0, 8),
		FailureKindCounts: NewObject(),
		JudgeMethodCounts: NewObject(),
	}
	warningFlagSet := map[string]struct{}{}
	for _, node := range nodes {
		aggregate.NodeCount++
		switch node.Status {
		case "completed":
			aggregate.PageCount++
			if node.PageType == "article" {
				aggregate.ArticleCount++
			}
		case "failed":
			aggregate.FailedCount++
		}
		if node.RejectionReason != nil && *node.RejectionReason == "duplicate" {
			aggregate.DuplicateCount++
		}
		if node.Status == "pending" || node.Status == "queued" || node.Status == "running" {
			aggregate.ActiveNodeCount++
		}
		aggregate.PendingLlmJudgeJobs += ResolvePendingLlmJudgeJobs(node.Metadata)

		bumpObjectCount(aggregate.CoverageByPageType, node.PageType)
		depthKey := itoaInt(node.Depth)
		if value, ok := aggregate.CoverageByDepth.Number(depthKey); ok {
			aggregate.CoverageByDepth.SetNumber(depthKey, value+1)
		} else {
			aggregate.CoverageByDepth.SetNumber(depthKey, 1)
		}
		if node.RejectionReason != nil && *node.RejectionReason != "" {
			bumpObjectCount(aggregate.RejectionCounts, *node.RejectionReason)
		}
		metadata := node.Metadata
		if metadata == nil {
			continue
		}
		if nodeStats, ok := metadata.Object("candidateStats"); ok {
			for _, key := range aggregate.CandidateStats.Keys() {
				if value, ok := nodeStats.Number(key); ok {
					current, _ := aggregate.CandidateStats.Number(key)
					aggregate.CandidateStats.SetNumber(key, current+value)
				}
			}
		}
		if nodeRejections, ok := metadata.Object("rejectionCounts"); ok {
			for _, key := range nodeRejections.Keys() {
				if value, ok := nodeRejections.Number(key); ok {
					current, _ := aggregate.RejectionCounts.Number(key)
					aggregate.RejectionCounts.SetNumber(key, current+value)
				}
			}
		}
		for _, flag := range CollectNodeWarningFlags(metadata, node.LastError) {
			if _, exists := warningFlagSet[flag]; exists {
				continue
			}
			warningFlagSet[flag] = struct{}{}
			aggregate.WarningFlags = append(aggregate.WarningFlags, flag)
		}
		failureKind := ""
		if value, ok := metadata.String("failureKind"); ok {
			failureKind = value
		} else if classified := ClassifyFrontierFailureKind(node.LastError); classified != nil {
			failureKind = *classified
		}
		if judgeMethod, ok := metadata.String("judgeMethod"); ok {
			bumpObjectCount(aggregate.JudgeMethodCounts, judgeMethod)
		}
		if confidence, ok := metadata.Number("judgeConfidence"); ok && isFinite(confidence) {
			aggregate.JudgeConfidenceTotal += confidence
			aggregate.JudgeConfidenceCount++
		}
		if failureKind != "" {
			bumpObjectCount(aggregate.FailureKindCounts, failureKind)
		}
		if node.Depth == 0 {
			aggregate.RootDiagnosis = buildRootDiagnosis(metadata, node)
		}
	}
	return aggregate
}

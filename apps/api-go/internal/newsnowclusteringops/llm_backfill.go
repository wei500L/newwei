package newsnowclusteringops

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// This file implements the news-event clustering failure LLM backfill chain:
// the manual enqueue, the five-minute automatic scan (including the new
// stale-processing recovery rule R1), and the BullMQ worker body.
//
// It is enabled only when API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE=go (manual
// enqueue) and/or API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE=go (scan, worker
// and R1). While both are legacy nothing in this file runs. The two switches
// are independent: a deployment may accept manual jobs before it consumes
// them.

// HTTPStatusOf reports the NestJS HTTP status and message carried by a typed
// failure of this package. It is the narrow export the new HTTP handler of the
// LLM backfill route needs; internal callers keep using httpStatusOf.
func HTTPStatusOf(err error) (int, string, bool) {
	return httpStatusOf(err)
}

// llmBackfillReady reports whether an active LLM gateway completion profile is
// usable and returns its model (assistantModel ?? model). A missing profile is
// (false, nil, nil), not an error.
func (s *Service) llmBackfillReady(ctx context.Context) (bool, *string, error) {
	readiness, err := s.llmBackfillReadiness(ctx)
	if err != nil {
		return false, nil, err
	}
	if !readiness.Ready || readiness.Model == nil {
		return false, nil, nil
	}
	model := strings.TrimSpace(*readiness.Model)
	if model == "" {
		return false, nil, nil
	}
	return true, &model, nil
}

// EnqueueLlmBackfill is the manual entry point used by the HTTP handler. It
// returns the exact NestJS status/message pair for every rejection.
func (s *Service) EnqueueLlmBackfill(ctx context.Context, orgID, actorID, groupID string, producer LlmBackfillProducer) (LlmBackfillAccepted, error) {
	return s.enqueueLlmBackfill(ctx, orgID, actorID, groupID, "manual", producer)
}

// enqueueLlmBackfill mirrors
// NewsEventClusteringRecoveryService.enqueueLlmBackfillWithReadiness.
func (s *Service) enqueueLlmBackfill(ctx context.Context, orgID, actorID, groupID, trigger string, producer LlmBackfillProducer) (LlmBackfillAccepted, error) {
	ready, model, err := s.llmBackfillReady(ctx)
	if err != nil {
		return LlmBackfillAccepted{}, err
	}
	if !ready || model == nil {
		return LlmBackfillAccepted{}, newHTTPError(400, msgLlmBackfillNotReady)
	}
	failure, err := s.clustering.findFailureGroup(ctx, orgID, groupID)
	if err != nil {
		return LlmBackfillAccepted{}, err
	}
	if failure == nil {
		return LlmBackfillAccepted{}, newHTTPError(404, msgFailureGroupNotFound)
	}
	if failure.Status == ClusteringFailureStatusProcessing {
		return LlmBackfillAccepted{}, newHTTPError(400, msgFailureGroupProcessing)
	}
	if failure.Status == ClusteringFailureStatusResolved || failure.Status == ClusteringFailureStatusIgnored {
		return LlmBackfillAccepted{}, newHTTPError(400, msgFailureGroupUnrecoverable)
	}
	if producer == nil {
		return LlmBackfillAccepted{}, errors.New("newsnowclusteringops: LLM backfill producer is not configured")
	}

	traceID := httpx.EnsureTraceID(httpx.TraceIDFromContext(ctx))
	jobID, err := newLlmBackfillJobID(groupID)
	if err != nil {
		return LlmBackfillAccepted{}, err
	}
	startedAt := time.Now().UTC().Truncate(time.Millisecond)
	claimed, err := s.clustering.markLlmBackfillQueued(ctx, orgID, groupID, jobID, model, startedAt)
	if err != nil {
		return LlmBackfillAccepted{}, err
	}
	if claimed == nil {
		current, readErr := s.clustering.findFailureGroup(ctx, orgID, groupID)
		if readErr != nil {
			return LlmBackfillAccepted{}, readErr
		}
		if current == nil {
			return LlmBackfillAccepted{}, newHTTPError(404, msgFailureGroupNotFound)
		}
		switch current.Status {
		case ClusteringFailureStatusProcessing:
			return LlmBackfillAccepted{}, newHTTPError(400, msgFailureGroupProcessing)
		case ClusteringFailureStatusResolved, ClusteringFailureStatusIgnored:
			return LlmBackfillAccepted{}, newHTTPError(400, msgFailureGroupUnrecoverable)
		default:
			return LlmBackfillAccepted{}, newHTTPError(400, msgLlmBackfillNotReadyForRecovery)
		}
	}

	job := LlmBackfillJob{
		JobType: LlmBackfillJobType,
		OrgID:   orgID,
		ActorID: actorID,
		GroupID: groupID,
		TraceID: traceID,
		Trigger: trigger,
	}
	if err := producer.AddLlmBackfill(ctx, jobID, job); err != nil {
		message := err.Error()
		if strings.TrimSpace(message) == "" {
			message = "Failed to enqueue LLM backfill job"
		}
		_ = s.clustering.markLlmBackfillFailed(ctx, orgID, groupID, 0, claimed.ProgressTotalCount, message, model)
		return LlmBackfillAccepted{}, err
	}

	s.clustering.insertLlmBackfillTaskLog(ctx, jobID, orgID, llmBackfillStageQueue, "pending", "",
		llmBackfillQueueLogData{
			GroupID:   groupID,
			Model:     model,
			ItemCount: claimed.ProgressTotalCount,
			Trigger:   trigger,
		},
		time.Now().UTC().Truncate(time.Millisecond))

	return LlmBackfillAccepted{
		GroupID:                groupID,
		Status:                 string(ClusteringFailureStatusProcessing),
		ActiveJobID:            jobID,
		ProgressProcessedCount: 0,
		ProgressTotalCount:     claimed.ProgressTotalCount,
		LastRecoveryModel:      model,
		AttemptCount:           maxInt(claimed.AttemptCount, 0),
	}, nil
}

// ScanPendingLlmBackfills mirrors enqueuePendingLlmBackfills and runs the R1
// recovery before the candidate scan. R1 failures are logged and never abort
// the scan: a lost job of one organization must not block another
// organization's retry.
func (s *Service) ScanPendingLlmBackfills(ctx context.Context, deps LlmBackfillDeps) (LlmBackfillScanResult, error) {
	ready, _, err := s.llmBackfillReady(ctx)
	if err != nil {
		return LlmBackfillScanResult{}, err
	}
	if !ready {
		return LlmBackfillScanResult{SkippedNotReady: true}, nil
	}

	result := LlmBackfillScanResult{Recovered: s.recoverStaleLlmBackfillGroups(ctx, deps)}
	candidates, err := s.clustering.listPendingAutoRetryCandidates(ctx, LlmBackfillBatchSize, LlmBackfillRetryAfter, deps.now())
	if err != nil {
		return result, err
	}
	result.Scanned = len(candidates)
	for _, candidate := range candidates {
		_, enqueueErr := s.enqueueLlmBackfill(ctx, candidate.OrgID, LlmBackfillActorID, candidate.GroupID, "auto", deps.Producer)
		if enqueueErr == nil {
			result.Queued++
			continue
		}
		var httpErr *httpError
		if errors.As(enqueueErr, &httpErr) && httpErr.Status == 400 {
			result.Skipped++
			continue
		}
		result.Failed++
		deps.logf("newsnowclusteringops: auto enqueue failed orgId=%s groupId=%s: %v", candidate.OrgID, candidate.GroupID, enqueueErr)
	}
	return result, nil
}

// recoverStaleLlmBackfillGroups is R1. It returns the number of groups moved
// back to pending.
//
// Rationale: a group enters processing only in markLlmBackfillQueued (and in
// the synchronous vector-backfill claim). A normal finish resolves it and a
// handled failure returns it to pending. If the worker process is killed, the
// BullMQ job is marked failed after its single attempt, the job is removed, or
// the vector-backfill request process exits, none of those handlers run and the
// group stays processing forever: the auto scan only selects pending groups
// and the manual route rejects processing groups. There was no recovery path.
//
// Rule (new, Go-owned while the worker switch is go): a group is recovered when
// status=processing, lastAttemptAt is at or before now-15m (the existing
// AUTO_BACKFILL_RETRY_AFTER_MS window), and either activeJobId is empty or that
// job is in none of the BullMQ wait/active/delayed/prioritized/paused/
// waiting-children states. The conditional update repeats status=processing and
// the exact activeJobId, so a group that changed owner in between is never
// stolen. The update writes lastError
// "LLM backfill job was lost before completion", clears activeJobId and adds a
// llm_backfill_recovery task log.
func (s *Service) recoverStaleLlmBackfillGroups(ctx context.Context, deps LlmBackfillDeps) int {
	now := deps.now()
	olderThan := now.Add(-LlmBackfillRetryAfter)
	rows, err := s.clustering.listStaleProcessingGroups(ctx, olderThan, LlmBackfillStaleBatchSize)
	if err != nil {
		deps.logf("newsnowclusteringops: stale recovery scan failed: %v", err)
		return 0
	}
	recovered := 0
	for i := range rows {
		row := rows[i]
		if !staleGroupEligible(row, olderThan) {
			continue
		}
		if row.ActiveJobID != nil && strings.TrimSpace(*row.ActiveJobID) != "" {
			if deps.Liveness == nil {
				deps.logf("newsnowclusteringops: stale recovery cannot verify job orgId=%s groupId=%s", row.OrgID, row.GroupID)
				continue
			}
			active, probeErr := deps.Liveness.LlmBackfillJobActive(ctx, strings.TrimSpace(*row.ActiveJobID))
			if probeErr != nil {
				deps.logf("newsnowclusteringops: stale recovery probe failed orgId=%s groupId=%s: %v", row.OrgID, row.GroupID, probeErr)
				continue
			}
			if active {
				continue
			}
		}
		updated, updateErr := s.clustering.recoverStaleProcessingGroup(ctx, row.OrgID, row.GroupID, row.ActiveJobID)
		if updateErr != nil {
			deps.logf("newsnowclusteringops: stale recovery update failed orgId=%s groupId=%s: %v", row.OrgID, row.GroupID, updateErr)
			continue
		}
		if !updated {
			continue
		}
		recovered++
		jobID := row.GroupID
		if row.ActiveJobID != nil && strings.TrimSpace(*row.ActiveJobID) != "" {
			jobID = strings.TrimSpace(*row.ActiveJobID)
		}
		s.clustering.insertLlmBackfillTaskLog(ctx, jobID, row.OrgID, llmBackfillStageRecovery, "pending", msgLlmBackfillLostJob,
			llmBackfillRecoveryLogData{
				GroupID:       row.GroupID,
				PreviousJobID: row.ActiveJobID,
			},
			now)
	}
	if recovered > 0 {
		deps.logf("newsnowclusteringops: recovered %d stale LLM backfill group(s)", recovered)
	}
	return recovered
}

// staleGroupEligible is the age/status half of the R1 rule: only a processing
// group whose last attempt is strictly older than the retry window qualifies.
// The liveness half is evaluated by the caller because it needs Redis.
func staleGroupEligible(row clusteringFailureDoc, olderThan time.Time) bool {
	if row.Status != ClusteringFailureStatusProcessing {
		return false
	}
	return row.LastAttemptAt != nil && row.LastAttemptAt.Before(olderThan)
}

// ProcessLlmBackfillJob is the BullMQ worker body.
func (s *Service) ProcessLlmBackfillJob(ctx context.Context, job LlmBackfillJob, deps LlmBackfillDeps) error {
	if job.JobType != LlmBackfillJobType {
		return nil
	}
	ready, model, err := s.llmBackfillReady(ctx)
	if err != nil {
		return err
	}
	if !ready || model == nil {
		return errors.New(msgLlmBackfillWorkerNotReady)
	}
	failure, err := s.clustering.findFailureGroup(ctx, job.OrgID, job.GroupID)
	if err != nil {
		return err
	}
	if failure == nil {
		return newHTTPError(404, msgFailureGroupNotFound)
	}
	if failure.Status == ClusteringFailureStatusResolved || failure.Status == ClusteringFailureStatusIgnored {
		return nil
	}

	settings := s.clustering.readOrgNewsEventSettings(ctx, job.OrgID)
	totalCount := len(failure.Items)
	processedCount := 0
	assignedCount := 0
	skippedCount := 0
	resolvedEventIDs := make([]string, 0, len(failure.Items))
	seenEventIDs := make(map[string]struct{}, len(failure.Items))

	jobLogID := failure.ActiveJobID
	if jobLogID == nil || strings.TrimSpace(*jobLogID) == "" {
		fallback := job.GroupID
		jobLogID = &fallback
	}
	trigger := job.Trigger
	if trigger == "" {
		trigger = "manual"
	}

	s.clustering.insertLlmBackfillTaskLog(ctx, *jobLogID, job.OrgID, llmBackfillStageProcess, "processing", "",
		llmBackfillStartLogData{
			GroupID:   job.GroupID,
			ItemCount: totalCount,
			Model:     model,
			Trigger:   trigger,
		},
		time.Now().UTC().Truncate(time.Millisecond))

	fail := func(cause error) error {
		message := cause.Error()
		if strings.TrimSpace(message) == "" {
			message = "LLM backfill failed"
		}
		_ = s.clustering.markLlmBackfillFailed(ctx, job.OrgID, job.GroupID, processedCount, totalCount, message, model)
		s.clustering.insertLlmBackfillTaskLog(ctx, *jobLogID, job.OrgID, llmBackfillStageProcess, "failed", message,
			llmBackfillFailedLogData{
				GroupID:        job.GroupID,
				ProcessedCount: processedCount,
				TotalCount:     totalCount,
				Model:          model,
				Trigger:        trigger,
			},
			time.Now().UTC().Truncate(time.Millisecond))
		return cause
	}

	for i := range failure.Items {
		result, recoverErr := s.recoverLlmBackfillItem(ctx, job.OrgID, failure.Items[i], settings, *model, deps)
		if recoverErr != nil {
			return fail(recoverErr)
		}
		processedCount++
		if result.EventID != "" {
			if _, ok := seenEventIDs[result.EventID]; !ok {
				seenEventIDs[result.EventID] = struct{}{}
				resolvedEventIDs = append(resolvedEventIDs, result.EventID)
			}
		}
		if result.Created {
			assignedCount++
		} else {
			skippedCount++
		}
		if err := s.clustering.updateLlmBackfillProgress(ctx, job.OrgID, job.GroupID, processedCount, totalCount, jobLogID, model); err != nil {
			return fail(err)
		}
	}

	resolvedAt, err := s.clustering.markLlmBackfillResolved(ctx, job.OrgID, job.GroupID, job.ActorID, processedCount, totalCount, model, resolvedEventIDs)
	if err != nil {
		return fail(err)
	}
	sortStrings(resolvedEventIDs)
	s.clustering.insertLlmBackfillTaskLog(ctx, *jobLogID, job.OrgID, llmBackfillStageProcess, "completed", "",
		llmBackfillCompletedLogData{
			GroupID:          job.GroupID,
			AssignedCount:    assignedCount,
			SkippedCount:     skippedCount,
			ProcessedCount:   processedCount,
			TotalCount:       totalCount,
			Model:            model,
			Trigger:          trigger,
			ResolvedEventIDs: resolvedEventIDs,
			ResolvedAt:       isoMillis(resolvedAt),
		},
		time.Now().UTC().Truncate(time.Millisecond))
	return nil
}

// recoverLlmBackfillItem mirrors recoverFailureItem. O1: before listing
// candidates it checks whether the article already has a NewsEventItem and, if
// so, records that event without a candidate query or a model call. NestJS
// discovers the same condition only inside the assignment transaction, after
// the model call; the result is identical and the optimization removes a
// duplicated model call on retries.
func (s *Service) recoverLlmBackfillItem(ctx context.Context, orgID string, item clusteringFailureItemDoc, settings newsEventSettings, model string, deps LlmBackfillDeps) (assignResult, error) {
	if existingEventID, found, err := s.clustering.findNewsEventItemEventID(ctx, orgID, item.ProcessedArticleID); err != nil {
		return assignResult{}, err
	} else if found && strings.TrimSpace(existingEventID) != "" {
		return assignResult{EventID: strings.TrimSpace(existingEventID), Created: false}, nil
	}

	signal := signalFromFailureItem(item, deps.now())
	candidates, err := s.listAssignmentCandidates(ctx, orgID, signal, settings, llmBackfillCandidateLimit, deps.Vectors)
	if err != nil {
		return assignResult{}, err
	}
	if len(candidates) == 0 {
		return s.assignSignalToNewEvent(ctx, orgID, signal)
	}

	decision, err := s.chooseEventWithLlm(ctx, orgID, signal, candidates, model, deps)
	if err != nil {
		return assignResult{}, err
	}
	if decision.Action == "create_new" {
		return s.assignSignalToNewEvent(ctx, orgID, signal)
	}

	targetEventID := ""
	if decision.EventID != nil {
		targetEventID = strings.TrimSpace(*decision.EventID)
	}
	if targetEventID == "" {
		return assignResult{}, errors.New(msgLlmBackfillMissingEventID)
	}
	var target *AssignmentCandidate
	for i := range candidates {
		if candidates[i].EventID == targetEventID {
			target = &candidates[i]
			break
		}
	}
	if target == nil {
		return assignResult{}, errors.New(msgLlmBackfillUnknownEventID)
	}
	similarity := target.Score
	return s.assignSignalToSpecificEvent(ctx, orgID, target.EventID, signal, &similarity)
}

// chooseEventWithLlm calls the model with the verbatim NestJS prompts and
// validates the decision.
func (s *Service) chooseEventWithLlm(ctx context.Context, orgID string, signal newsSignal, candidates []AssignmentCandidate, model string, deps LlmBackfillDeps) (LlmBackfillDecision, error) {
	if deps.Completer == nil {
		return LlmBackfillDecision{}, errors.New("newsnowclusteringops: LLM backfill completer is not configured")
	}
	system := strings.Join([]string{
		"You are reviewing a failed news event clustering group.",
		"Choose exactly one action.",
		"Use assign_existing only when one candidate event clearly matches the article.",
		"Use create_new when none of the candidates are strong enough.",
		"Return JSON only.",
	}, " ")
	user := buildLlmBackfillUserPrompt(signal, candidates)
	fingerprint := buildSignalFingerprint(signal)
	response, err := deps.Completer.CompleteLlmBackfillDecision(ctx, LlmBackfillModelRequest{
		OrgID:              orgID,
		Model:              model,
		System:             system,
		User:               user,
		CandidateCount:     len(candidates),
		ArticleFingerprint: fingerprint,
	})
	if err != nil {
		return LlmBackfillDecision{}, err
	}
	if response.Content == "" {
		return LlmBackfillDecision{}, errors.New(msgLlmBackfillEmptyContent)
	}
	parsed, ok := safeJSONParseFromText(response.Content)
	if !ok {
		return LlmBackfillDecision{}, errors.New(msgLlmBackfillInvalidJSON)
	}
	decision, ok := validateLlmBackfillDecision(parsed)
	if !ok {
		return LlmBackfillDecision{}, errors.New(msgLlmBackfillInvalidDecision)
	}
	return decision, nil
}

// buildLlmBackfillUserPrompt is a verbatim port of buildUserPrompt.
func buildLlmBackfillUserPrompt(signal newsSignal, candidates []AssignmentCandidate) string {
	lines := []string{
		"Article:",
		"- Title: " + valueOrDash(signal.Title),
		"- Summary: " + valueOrDash(signal.Summary),
		"- Language: " + valueOrDash(signal.Language),
		"- Timestamp: " + isoMillis(signal.Timestamp),
		"- Topics: " + valueOrDashList(signal.Topics),
		"- Entities: " + formatLlmBackfillEntities(signal.Entities),
		"",
		"Candidate events:",
	}
	for index, candidate := range candidates {
		lines = append(lines,
			fmt.Sprintf("%d. Event %s", index+1, candidate.EventID),
			fmt.Sprintf("   - Score: %s (%s)", formatFixed3(candidate.Score), candidate.MatchOrigin),
			"   - Title: "+valueOrDash(candidate.Title),
			"   - Summary: "+valueOrDash(candidate.Summary),
			"   - Language: "+valueOrDash(candidate.Language),
			"   - Primary topic: "+valueOrDash(candidate.PrimaryTopic),
			"   - Primary entity: "+valueOrDash(candidate.PrimaryEntity),
			"   - Last seen: "+isoMillis(candidate.LastAt),
			fmt.Sprintf("   - Items: %d", candidate.ItemCount),
		)
	}
	lines = append(lines,
		"",
		"Return JSON using this shape:",
		`{"action":"assign_existing"|"create_new","eventId":"<candidate event id or null>","confidence":0.0-1.0,"reasoning":"short explanation"}`,
	)
	return strings.Join(lines, "\n")
}

// formatLlmBackfillEntities is a verbatim port of formatEntities.
func formatLlmBackfillEntities(entities []clusteringFailureEntityDoc) string {
	if len(entities) == 0 {
		return "-"
	}
	limit := len(entities)
	if limit > 8 {
		limit = 8
	}
	parts := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		name := strings.TrimSpace(entities[i].Name)
		if name == "" {
			name = "unknown"
		}
		entityType := "unknown"
		if entities[i].Type != nil {
			if trimmed := strings.TrimSpace(*entities[i].Type); trimmed != "" {
				entityType = trimmed
			}
		}
		parts = append(parts, name+" ("+entityType+")")
	}
	return strings.Join(parts, ", ")
}

// buildSignalFingerprint is sha1(processedArticleId|title|summary) truncated to
// 16 hex characters.
func buildSignalFingerprint(signal newsSignal) string {
	hash := sha1.New()
	_, _ = hash.Write([]byte(signal.ProcessedArticleID))
	_, _ = hash.Write([]byte("|"))
	_, _ = hash.Write([]byte(stringOrEmpty(signal.Title)))
	_, _ = hash.Write([]byte("|"))
	_, _ = hash.Write([]byte(stringOrEmpty(signal.Summary)))
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

// validateLlmBackfillDecision mirrors LLM_BACKFILL_DECISION_SCHEMA.parse. The
// second result is false for every schema violation.
func validateLlmBackfillDecision(raw []byte) (LlmBackfillDecision, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed[0] != '{' {
		return LlmBackfillDecision{}, false
	}
	var payload struct {
		Action     json.RawMessage `json:"action"`
		EventID    json.RawMessage `json:"eventId"`
		Confidence json.RawMessage `json:"confidence"`
		Reasoning  json.RawMessage `json:"reasoning"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return LlmBackfillDecision{}, false
	}

	var action string
	if len(payload.Action) == 0 || jsonNull(payload.Action) {
		return LlmBackfillDecision{}, false
	}
	if err := json.Unmarshal(payload.Action, &action); err != nil {
		return LlmBackfillDecision{}, false
	}
	if action != "assign_existing" && action != "create_new" {
		return LlmBackfillDecision{}, false
	}
	decision := LlmBackfillDecision{Action: action}

	if len(payload.EventID) > 0 && !jsonNull(payload.EventID) {
		var eventID string
		if err := json.Unmarshal(payload.EventID, &eventID); err != nil {
			return LlmBackfillDecision{}, false
		}
		eventID = strings.TrimSpace(eventID)
		length := jsStringLength(eventID)
		if length < 1 || length > 64 {
			return LlmBackfillDecision{}, false
		}
		decision.EventID = &eventID
	}
	if len(payload.Confidence) > 0 && !jsonNull(payload.Confidence) {
		var confidence float64
		if err := json.Unmarshal(payload.Confidence, &confidence); err != nil {
			return LlmBackfillDecision{}, false
		}
		if math.IsNaN(confidence) || math.IsInf(confidence, 0) || confidence < 0 || confidence > 1 {
			return LlmBackfillDecision{}, false
		}
		decision.Confidence = &confidence
	}
	if len(payload.Reasoning) > 0 && !jsonNull(payload.Reasoning) {
		var reasoning string
		if err := json.Unmarshal(payload.Reasoning, &reasoning); err != nil {
			return LlmBackfillDecision{}, false
		}
		reasoning = strings.TrimSpace(reasoning)
		if jsStringLength(reasoning) > 500 {
			return LlmBackfillDecision{}, false
		}
		decision.Reasoning = &reasoning
	}
	return decision, true
}

// jsonNull reports whether a raw JSON value is the literal null.
func jsonNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// jsStringLength counts UTF-16 code units, matching JavaScript's String.length
// that the zod max checks use.
func jsStringLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// stripMarkdownCodeFence mirrors stripMarkdownCodeFence.
func stripMarkdownCodeFence(text string) string {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "```") {
		return trimmed
	}
	firstNewline := strings.Index(trimmed, "\n")
	if firstNewline < 0 {
		return trimmed
	}
	afterFence := trimmed[firstNewline+1:]
	closingFence := strings.LastIndex(afterFence, "```")
	if closingFence < 0 {
		return trimmed
	}
	return strings.TrimSpace(afterFence[:closingFence])
}

// extractFirstJSON mirrors extractFirstJSON: it strips an optional markdown
// fence, then returns the first balanced object or array.
func extractFirstJSON(text string) (string, bool) {
	cleaned := stripMarkdownCodeFence(text)
	startObject := strings.Index(cleaned, "{")
	startArray := strings.Index(cleaned, "[")
	start := startObject
	switch {
	case startObject < 0:
		start = startArray
	case startArray >= 0 && startArray < startObject:
		start = startArray
	}
	if start < 0 {
		return "", false
	}
	stack := make([]byte, 0, 8)
	inString := false
	escaped := false
	for index := start; index < len(cleaned); index++ {
		char := cleaned[index]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) == 0 {
				return "", false
			}
			expected := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if expected != char {
				return "", false
			}
			if len(stack) == 0 {
				return strings.TrimSpace(cleaned[start : index+1]), true
			}
		}
	}
	return "", false
}

// safeJSONParseFromText mirrors safeJsonParseFromText.
func safeJSONParseFromText(text string) ([]byte, bool) {
	extracted, ok := extractFirstJSON(text)
	if !ok {
		return nil, false
	}
	if !json.Valid([]byte(extracted)) {
		return nil, false
	}
	return []byte(extracted), true
}

// newLlmBackfillJobID builds `news-event-llm-backfill:<groupId>:<uuid>`.
func newLlmBackfillJobID(groupID string) (string, error) {
	uuid, err := newUUIDv4()
	if err != nil {
		return "", err
	}
	return "news-event-llm-backfill:" + groupID + ":" + uuid, nil
}

// newUUIDv4 produces the RFC 4122 version-4 UUID shape crypto.randomUUID
// returns.
func newUUIDv4() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// valueOrDash renders a nullable string the way `value ?? "-"` does.
func valueOrDash(value *string) string {
	if value == nil {
		return "-"
	}
	return *value
}

// valueOrDashList renders `list.join(", ") || "-"`.
func valueOrDashList(values []string) string {
	joined := strings.Join(values, ", ")
	if joined == "" {
		return "-"
	}
	return joined
}

// stringOrEmpty maps a nullable string to "" for hashing.
func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// formatFixed3 mirrors Number.prototype.toFixed(3).
func formatFixed3(value float64) string {
	return strconv.FormatFloat(value, 'f', 3, 64)
}

// logf is the optional logger of the deps. It keeps the package free of a
// global logger while still surfacing per-organization scan failures.
func (d LlmBackfillDeps) logf(format string, args ...any) {
	if d.Logger == nil {
		return
	}
	d.Logger(format, args...)
}

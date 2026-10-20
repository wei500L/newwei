package crawlfrontierllm

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// judge.go ports CrawlFrontierService.processQueuedLlmJudge, including the
// B1 terminal-failure cleanup. B1 is a deliberate Go-only behaviour change:
// the judge job has attempts=1, so a failure before updateNodeMetadata leaves
// pendingLlmJudgeJobs above zero and refreshRunStatus counts the run as active
// forever. The cleanup decrements the counter once, records the failure and
// refreshes the run so it can reach a terminal state (the dropped candidates
// are not materialized).

// CrawlExecutionSummary is CrawlExecutionSummary.
type CrawlExecutionSummary struct {
	Inserted int `json:"inserted"`
	Skipped  int `json:"skipped"`
}

// ProcessQueuedLlmJudge is the judge queue entry point.
func (s *Service) ProcessQueuedLlmJudge(ctx context.Context, orgID string, payload LlmJudgePayload) (CrawlExecutionSummary, error) {
	node, err := s.loadNodeForOrg(ctx, payload.NodeID, orgID)
	if err != nil {
		// A missing or cross-tenant node is not recoverable and must not be
		// cleaned up: there is no node whose counter could be decremented.
		return CrawlExecutionSummary{}, err
	}
	decremented, runErr := s.runQueuedLlmJudge(ctx, node, payload)
	if runErr != nil {
		if decremented {
			// The pending counter was already reconciled; only refresh the run
			// so a late workflow-record failure cannot leave it active.
			if refreshErr := s.refreshRunStatus(ctx, payload.RunID); refreshErr != nil {
				log.Printf("crawlfrontierllm: judge post-finalize refresh for run %s failed: %v", payload.RunID, refreshErr)
			}
		} else {
			s.cleanupFailedJudge(ctx, node, payload, runErr)
		}
		return CrawlExecutionSummary{}, runErr
	}
	return CrawlExecutionSummary{}, nil
}

// runQueuedLlmJudge returns whether the terminal pendingLlmJudgeJobs decrement
// was written. The B1 cleanup runs only when it was not: decrementing twice
// would steal a slot from another queued judge job.
func (s *Service) runQueuedLlmJudge(ctx context.Context, node *NodeRecord, payload LlmJudgePayload) (bool, error) {
	startedAt := s.now()
	run, err := s.loadRun(ctx, node.RunID)
	if err != nil {
		return false, err
	}
	if run == nil {
		return false, notFound("Crawl frontier node not found for LLM judge")
	}
	profile, err := s.resolveEffectiveProfile(ctx, run.OrgID, run.ProfileID, run.SeedURL)
	if err != nil {
		return false, err
	}
	if profile == nil {
		return false, badRequest("Crawl frontier run cannot resolve site profile")
	}
	if run.WorkflowRunID != nil {
		details := NewObject()
		details.SetString("mode", string(payload.Mode))
		details.SetNumber("candidateCount", float64(len(payload.Candidates)))
		if err := s.AppendEvent(ctx, *run.WorkflowRunID, WorkflowEvent{
			Level: "info", EventType: "llm_judge_started", NodeID: &node.ID,
			NodeType: stringPointer("branch"), Message: "Deferred LLM judge started",
			Details: details, Timestamp: s.nowISO(),
		}); err != nil {
			return false, err
		}
	}

	candidates := make([]Candidate, 0, len(payload.Candidates))
	for _, candidate := range payload.Candidates {
		if _, ok := ParseObject(candidate.Metadata); !ok {
			candidate.Metadata = json.RawMessage("{}")
		}
		candidates = append(candidates, candidate)
	}

	var llmDiagnostics *Object
	judgedCandidates := candidates
	assisted, assistErr := s.applyLlmCandidateAssistance(ctx, node, run, profile, candidates)
	if assistErr != nil {
		llmDiagnostics = NewObjectFromPairs(
			"llmJudgeEnabled", true,
			"llmJudgeAttempted", true,
			"llmJudgeParsed", false,
			"llmJudgeError", assistErr.Error(),
			"warningFlags", []string{"llm_judge_failed"},
		)
	} else {
		judgedCandidates = assisted.candidates
		llmDiagnostics = assisted.diagnostics
	}

	if run.WorkflowRunID != nil {
		if err := s.recordResolvedLlmCandidateDecisions(ctx, *run.WorkflowRunID, node, payload.Mode, candidates, judgedCandidates, llmDiagnostics); err != nil {
			return false, err
		}
	}

	var resultMetadata *Object
	var created int
	var resultStats *Object
	if payload.Mode == JudgeModeSeed {
		seedContext := payload.SeedContext
		discoveredCount := len(payload.Candidates)
		diagnostics := NewObject()
		var qualityThresholds qualityThresholds
		if seedContext != nil {
			if seedContext.DiscoveredCount > discoveredCount {
				discoveredCount = seedContext.DiscoveredCount
			}
			diagnostics = parseObjectOrDefault(mustJSON(seedContext.seedDiagnosticsObject()))
			qualityThresholds = parseQualityThresholds(seedContext.QualityThresholds)
		} else {
			qualityThresholds = parseQualityThresholds(nil)
		}
		outcome, materializeErr := s.materializeSeedCandidates(ctx, SeedMaterializeOptions{
			WorkflowRunID:      derefString(run.WorkflowRunID),
			Node:               node,
			Run:                SeedRun{ID: payload.RunID, SeedURL: run.SeedURL, MaxDepth: payload.MaxDepth, MaxPages: payload.MaxPages},
			TaskID:             payload.TaskID,
			Profile:            profile,
			Candidates:         judgedCandidates,
			SitemapDiagnostics: diagnostics,
			QualityThresholds:  qualityThresholds,
			DiscoveredCount:    discoveredCount,
			LlmDiagnostics:     llmDiagnostics,
		})
		if materializeErr != nil {
			return false, materializeErr
		}
		created = outcome.Created
		resultMetadata = objectOrEmpty(outcome.Diagnostics)
	} else {
		extraction, ok := ParseObject(payload.Diagnostics)
		if !ok {
			extraction = NewObject()
		}
		metadataPatch, _ := ParseObject(payload.MetadataPatch)
		result, materializeErr := s.materializeDiscoveredCandidates(ctx, DiscoverMaterializeOptions{
			WorkflowRunID:         derefString(run.WorkflowRunID),
			Node:                  node,
			RunID:                 payload.RunID,
			TaskID:                payload.TaskID,
			MaxDepth:              payload.MaxDepth,
			MaxPages:              payload.MaxPages,
			Profile:               profile,
			Candidates:            judgedCandidates,
			ExtractionDiagnostics: extraction,
			LlmDiagnostics:        llmDiagnostics,
			MaxDepthOverride:      payload.MaxDepthOverride,
			MaxNewNodes:           payload.MaxNewNodes,
			MetadataPatch:         metadataPatch,
		})
		if materializeErr != nil {
			return false, materializeErr
		}
		resultMetadata = objectOrEmpty(result)
	}
	resultStats, _ = resultMetadata.Object("candidateStats")

	if err := s.updateNodeMetadataFunc(ctx, node.ID, func(existing *Object) *Object {
		patch := NewObject()
		patch.SetNumber("pendingLlmJudgeJobs", float64(maxInt(0, ResolvePendingLlmJudgeJobs(existing)-1)))
		patch.SetString("llmJudgeDeferredResolvedAt", s.nowISO())
		warningFlags := uniqueStringList(
			CollectNodeWarningFlags(existing, node.LastError),
			objectStrings(resultMetadata, "warningFlags"),
			objectStrings(llmDiagnostics, "warningFlags"),
		)
		if warningFlags == nil {
			warningFlags = []string{}
		}
		patch.Set("warningFlags", warningFlags)
		return mergeObjects(resultMetadata, patch)
	}); err != nil {
		return false, err
	}

	if run.WorkflowRunID != nil {
		llmJudgeError := ""
		if llmDiagnostics != nil {
			llmJudgeError, _ = llmDiagnostics.String("llmJudgeError")
		}
		outputCount := 0
		if payload.Mode == JudgeModeSeed {
			outputCount = created
		} else if resultStats != nil {
			if selected, ok := resultStats.Number("selected"); ok {
				outputCount = int(selected)
			}
		}
		rejectedCount := 0
		if resultStats != nil {
			if rejected, ok := resultStats.Number("rejected"); ok {
				rejectedCount = int(rejected)
			}
		}
		metrics := NewObject()
		metrics.SetString("mode", string(payload.Mode))
		metrics.SetRaw("llmDiagnostics", nullableObject(llmDiagnostics))
		metrics.SetRaw("resultMetadata", mustJSON(resultMetadata))
		step := WorkflowStep{
			StepKey:  "frontier:" + node.ID + ":llm-judge:" + string(payload.Mode),
			NodeID:   "legacy::llm-judge:" + node.ID + ":" + string(payload.Mode),
			NodeType: "branch",
			Label:    "Deferred discovery LLM judge",
			Status:   "completed", DurationMs: int(s.now().Sub(startedAt).Milliseconds()),
			InputCount: len(candidates), OutputCount: outputCount, RejectedCount: rejectedCount,
			SampleURLs: firstURLs(candidates, 5), Metrics: metrics,
		}
		if payload.Mode == JudgeModeSeed {
			step.Label = "Deferred seed LLM judge"
		}
		if llmJudgeError != "" {
			step.Status = "failed"
			step.Error = &llmJudgeError
		}
		if err := s.UpsertStep(ctx, *run.WorkflowRunID, step); err != nil {
			return true, err
		}
		details := NewObject()
		details.SetString("mode", string(payload.Mode))
		details.SetRaw("llmDiagnostics", nullableObject(llmDiagnostics))
		event := WorkflowEvent{
			Level: "info", EventType: "llm_judge_resolved", NodeID: &node.ID,
			NodeType: stringPointer("branch"), Message: "Deferred LLM judge completed",
			BeforeCount: intPointer(len(candidates)), AfterCount: intPointer(outputCount),
			RescuedCount: intPointer(outputCount), Details: details, Timestamp: s.nowISO(),
		}
		if llmJudgeError != "" {
			event.Level = "warn"
			event.Message = "Deferred LLM judge completed with fallback diagnostics"
			event.TriggerReason = stringPointer("llm_judge_failed")
		}
		if err := s.AppendEvent(ctx, *run.WorkflowRunID, event); err != nil {
			return true, err
		}
	}
	return true, s.refreshRunStatus(ctx, payload.RunID)
}

type assistedCandidates struct {
	candidates  []Candidate
	diagnostics *Object
}

// applyLlmCandidateAssistance ports applyLlmCandidateAssistance.
func (s *Service) applyLlmCandidateAssistance(ctx context.Context, node *NodeRecord, run *RunRecord, profile *ProfileRecord, candidates []Candidate) (assistedCandidates, error) {
	assist := ResolveEffectiveLlmAssistConfig(profile.Config, LlmPurposeJudge)
	if s.llm == nil || assist == nil || node.PageType == "article" {
		return assistedCandidates{candidates: candidates}, nil
	}
	config := profile.Config.Clone()
	if config == nil {
		config = NewObject()
	}
	config.SetRaw("llmAssist", mustJSON(assistObject(assist)))
	result, err := s.llm.JudgeCandidates(ctx, JudgeInput{
		OrgID: node.OrgID, RunID: run.ID, NodeID: node.ID, ProfileID: &profile.ID,
		SeedURL: node.URL, ParentURL: node.URL, ParentPageType: node.PageType,
		Config: config, Candidates: candidates,
	})
	if err != nil {
		diagnostics := NewObjectFromPairs(
			"llmJudgeEnabled", true, "llmJudgeAttempted", true,
			"llmJudgeError", err.Error(), "warningFlags", []string{"llm_judge_failed"},
		)
		return assistedCandidates{candidates: candidates, diagnostics: diagnostics}, nil
	}
	withPaths, synthetic := s.applyCandidateDiscoveryMetadata(node, profile.Config, result.Candidates)
	if result.Diagnostics != nil {
		result.Diagnostics.SetBool("syntheticListActivated", synthetic)
	}
	return assistedCandidates{candidates: withPaths, diagnostics: result.Diagnostics}, nil
}

func assistObject(assist *LlmAssist) *Object {
	out := NewObject()
	out.SetBool("enabled", true)
	out.SetString("recallMode", assist.RecallMode)
	if assist.JudgeModel != nil {
		out.SetString("judgeModel", *assist.JudgeModel)
	}
	if assist.SiteLearnerModel != nil {
		out.SetString("siteLearnerModel", *assist.SiteLearnerModel)
	}
	out.SetRaw("candidateBudgetByPageType", mustJSON(assist.CandidateBudgetByPageType))
	out.SetNumber("minJudgeConfidence", assist.MinJudgeConfidence)
	out.SetNumber("shadowEvaluationRuns", float64(assist.ShadowEvaluationRuns))
	out.SetRaw("autoPublishThresholds", mustJSON(assist.AutoPublishThresholds))
	if assist.Shadow != nil {
		out.SetRaw("shadow", mustJSON(assist.Shadow))
	}
	return out
}

// recordResolvedLlmCandidateDecisions ports the root executor method.
func (s *Service) recordResolvedLlmCandidateDecisions(ctx context.Context, workflowRunID string, node *NodeRecord, mode JudgeMode, input, resolved []Candidate, diagnostics *Object) error {
	resolvedByURL := map[string]Candidate{}
	for _, candidate := range resolved {
		resolvedByURL[candidate.URL] = candidate
	}
	decisionByURL := map[string]*Object{}
	if diagnostics != nil {
		if raw, ok := diagnostics.Raw("llmJudgeDecisions"); ok && !isEmptyJSON(raw) {
			var decisions []json.RawMessage
			if err := json.Unmarshal(raw, &decisions); err == nil {
				for _, entry := range decisions {
					record, ok := ParseObject(entry)
					if !ok {
						continue
					}
					url, ok := record.String("url")
					if !ok {
						continue
					}
					decisionByURL[url] = record
				}
			}
		}
	}
	llmError := ""
	if diagnostics != nil {
		llmError, _ = diagnostics.String("llmJudgeError")
	}
	llmParsed := false
	if diagnostics != nil {
		llmParsed, _ = diagnostics.Bool("llmJudgeParsed")
	}
	for _, candidate := range input {
		resolvedCandidate, hasResolved := resolvedByURL[candidate.URL]
		decision := decisionByURL[candidate.URL]
		before := buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType, Status: "active"})
		if !hasResolved {
			dropReason := "llm_candidate_removed"
			if decision != nil {
				if applied, ok := decision.Bool("appliedDrop"); ok && applied {
					dropReason = "llm_judge_drop"
				}
			}
			details := NewObject()
			details.SetString("mode", string(mode))
			action := "drop"
			if decision != nil {
				if value, ok := decision.String("action"); ok {
					action = value
				}
			}
			details.SetString("action", action)
			details.SetRaw("confidence", decisionNullableNumber(decision, "confidence"))
			details.SetRaw("reason", decisionNullableString(decision, "reason"))
			if err := s.recordCandidateDecision(ctx, candidateDecision{
				WorkflowRunID: workflowRunID, SourceNodeID: node.ID, Candidate: candidate,
				NodeID: node.ID, NodeType: "branch", Action: "branched",
				Message: "LLM judge dropped candidate from the branch",
				Status:  "rejected", Accepted: boolPointer(false), RejectedReason: &dropReason,
				RuleHits: []string{"llm_judge_resolved", dropReason}, BeforeSnapshot: before,
				AfterSnapshot: buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: &dropReason}),
				Details: details,
			}); err != nil {
				return err
			}
			continue
		}
		after := buildCandidateSnapshot(CandidateSnapshot{URL: resolvedCandidate.URL, PageType: resolvedCandidate.PageType, Status: "active"})
		ruleHits := []string{"llm_judge_resolved"}
		decisionAction := ""
		if decision != nil {
			decisionAction, _ = decision.String("action")
		}
		if llmError != "" {
			ruleHits = append(ruleHits, "llm_judge_failed")
		} else if decisionAction != "" {
			ruleHits = append(ruleHits, "llm_action:"+decisionAction)
		} else if llmParsed {
			ruleHits = append(ruleHits, "llm_judge_kept")
		} else {
			ruleHits = append(ruleHits, "llm_judge_passthrough")
		}
		if resolvedCandidate.PageType != candidate.PageType {
			ruleHits = append(ruleHits, "llm_judge_retyped")
		}
		message := "LLM judge kept candidate in the branch"
		if llmError != "" {
			message = "LLM judge fell back to rule-ranked candidate"
		} else if resolvedCandidate.PageType != candidate.PageType {
			message = "LLM judge kept candidate and retyped it as " + resolvedCandidate.PageType
		}
		var scoreDelta, freshnessDelta *float64
		if resolvedCandidate.PageType != "" {
			value := roundToFixed(resolvedCandidate.Score-candidate.Score, 4)
			scoreDelta = &value
			freshness := roundToFixed(resolvedCandidate.FreshnessScore-candidate.FreshnessScore, 4)
			freshnessDelta = &freshness
		}
		details := NewObject()
		details.SetString("mode", string(mode))
		details.SetRaw("action", nullableRawString(stringPointer(decisionAction)))
		details.SetRaw("confidence", decisionNullableNumber(decision, "confidence"))
		details.SetRaw("reason", decisionNullableString(decision, "reason"))
		judgeMethod := ""
		if resolvedCandidate.Metadata != nil {
			judgeMethod, _ = resolvedCandidate.metadataObject().String("judgeMethod")
		}
		details.SetRaw("judgeMethod", nullableRawString(stringPointer(judgeMethod)))
		if err := s.recordCandidateDecision(ctx, candidateDecision{
			WorkflowRunID: workflowRunID, SourceNodeID: node.ID, Candidate: resolvedCandidate,
			NodeID: node.ID, NodeType: "branch", Action: "branched", Message: message,
			Status: "active", Accepted: boolPointer(true), ScoreDelta: scoreDelta,
			FreshnessDelta: freshnessDelta, RuleHits: ruleHits, BeforeSnapshot: before,
			AfterSnapshot: after, Details: details,
		}); err != nil {
			return err
		}
	}
	return nil
}

// resolveEffectiveProfile ports resolveEffectiveProfileForUrl.
func (s *Service) resolveEffectiveProfile(ctx context.Context, orgID string, profileID *string, seedURL string) (*ProfileRecord, error) {
	var base *ProfileRecord
	var err error
	if profileID != nil {
		base, err = s.loadProfile(ctx, *profileID, orgID)
	} else {
		base, err = s.findProfileForURL(ctx, orgID, seedURL)
	}
	if err != nil || base == nil {
		return base, err
	}
	if s.workflows == nil || base.WorkflowID == nil {
		return base, nil
	}
	overlay, err := s.workflows.CompileProfileOverlay(ctx, orgID, *base.WorkflowID, derefString(base.WorkflowVersionID))
	if err != nil {
		return nil, err
	}
	if overlay == nil {
		return base, nil
	}
	merged := crawlworkflow.MergeProfileConfigPatch(mustJSON(base.Config), overlay.ConfigPatch)
	normalized, normalizeErr := crawlprofile.NormalizeConfigJSON(merged)
	if normalizeErr == nil {
		base.Config = parseObjectOrDefault(normalized)
	}
	if strings.TrimSpace(overlay.ExecutionMode) != "" {
		base.ExecutionMode = overlay.ExecutionMode
	}
	return base, nil
}

// cleanupFailedJudge is the B1 terminal-failure cleanup.
func (s *Service) cleanupFailedJudge(ctx context.Context, node *NodeRecord, payload LlmJudgePayload, cause error) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.updateNodeMetadataFunc(cleanupCtx, node.ID, func(existing *Object) *Object {
		patch := NewObject()
		patch.SetNumber("pendingLlmJudgeJobs", float64(maxInt(0, ResolvePendingLlmJudgeJobs(existing)-1)))
		patch.SetString("llmJudgeDeferredResolvedAt", s.nowISO())
		patch.SetString("llmJudgeJobError", cause.Error())
		patch.SetString("llmJudgeJobFailedAt", s.nowISO())
		warningFlags := uniqueStringList(
			CollectNodeWarningFlags(existing, node.LastError),
			[]string{"llm_judge_job_failed"},
		)
		if warningFlags == nil {
			warningFlags = []string{"llm_judge_job_failed"}
		}
		patch.Set("warningFlags", warningFlags)
		return patch
	}); err != nil {
		log.Printf("crawlfrontierllm: judge cleanup metadata for node %s failed: %v", node.ID, err)
		return
	}
	run, err := s.loadRun(cleanupCtx, node.RunID)
	if err != nil || run == nil || run.WorkflowRunID == nil {
		if err != nil {
			log.Printf("crawlfrontierllm: judge cleanup run read for node %s failed: %v", node.ID, err)
		}
		return
	}
	details := NewObject()
	details.SetString("mode", string(payload.Mode))
	details.SetString("error", cause.Error())
	details.Set("warningFlags", []string{"llm_judge_job_failed"})
	if err := s.AppendEvent(cleanupCtx, *run.WorkflowRunID, WorkflowEvent{
		Level: "warn", EventType: "llm_judge_resolved", NodeID: &node.ID,
		NodeType:      stringPointer("branch"),
		Message:       "Deferred LLM judge job failed; pending judge counter reconciled",
		TriggerReason: stringPointer("llm_judge_job_failed"),
		BeforeCount:   intPointer(len(payload.Candidates)), AfterCount: intPointer(0),
		RescuedCount: intPointer(0), Details: details, Timestamp: s.nowISO(),
	}); err != nil {
		log.Printf("crawlfrontierllm: judge cleanup event for run %s failed: %v", run.ID, err)
	}
	if err := s.refreshRunStatus(cleanupCtx, node.RunID); err != nil {
		log.Printf("crawlfrontierllm: judge cleanup refresh for run %s failed: %v", node.RunID, err)
	}
}

func decisionNullableNumber(decision *Object, key string) json.RawMessage {
	if decision == nil {
		return json.RawMessage("null")
	}
	value, ok := decision.Number(key)
	if !ok {
		return json.RawMessage("null")
	}
	return numberJSON(value)
}

func decisionNullableString(decision *Object, key string) json.RawMessage {
	if decision == nil {
		return json.RawMessage("null")
	}
	value, ok := decision.String(key)
	if !ok {
		return json.RawMessage("null")
	}
	return mustJSON(value)
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

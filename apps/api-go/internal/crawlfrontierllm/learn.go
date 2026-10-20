package crawlfrontierllm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// learn.go ports CrawlFrontierService.processQueuedLlmLearn,
// handleActiveRunCompletion, handleShadowRunCompletion, the shadow profile
// writes and createRunFromProfile. The learning prompt itself lives in
// llm_learn.go.

// ProcessQueuedLlmLearn is the learn queue entry point.
func (s *Service) ProcessQueuedLlmLearn(ctx context.Context, orgID string, payload LlmLearnPayload) (CrawlExecutionSummary, error) {
	run, err := s.loadRun(ctx, payload.RunID)
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	if run == nil || run.OrgID != orgID || run.ProfileID == nil {
		return CrawlExecutionSummary{}, notFound("Crawl frontier run not found for LLM learning")
	}
	profile, err := s.loadProfile(ctx, *run.ProfileID, orgID)
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	if profile == nil {
		return CrawlExecutionSummary{}, notFound("Crawl frontier run not found for LLM learning")
	}
	nodes, err := s.listNodesForLifecycle(ctx, run.ID)
	if err != nil {
		return CrawlExecutionSummary{}, err
	}
	metadata := objectOrEmpty(run.Metadata)
	finalSummary := LearnRun{
		ID: run.ID, SeedURL: run.SeedURL, Status: run.Status,
		MaxDepth: run.MaxDepth, MaxPages: run.MaxPages, NodeCount: run.NodeCount,
		Keywords: run.Keywords, ArticleCount: run.ArticleCount, PageCount: run.PageCount,
		FailedCount: run.FailedCount, DuplicateCount: run.DuplicateCount, Metadata: metadata,
	}
	lifecycleRun := LearnInput{OrgID: run.OrgID, Run: finalSummary, Profile: *profile, Nodes: nodes}

	// Both the learning write and the llmLifecycle update are inside the
	// NestJS try block, so either failure enters the bounded-retry catch.
	successErr := s.handleActiveRunCompletion(ctx, lifecycleRun, *profile, finalSummary)
	if successErr == nil {
		lifecycle := NewObject()
		if existing, ok := metadata.Object("llmLifecycle"); ok {
			lifecycle = existing.Clone()
		}
		lifecycle.SetString("learnHandledAt", s.nowISO())
		lifecycle.SetString("learnHandledKey", learnHandledKey(finalSummary))
		patch := NewObject()
		patch.SetRaw("llmLifecycle", mustJSON(lifecycle))
		successErr = s.updateRunMetadata(ctx, run.ID, patch)
	}
	if successErr == nil {
		return CrawlExecutionSummary{}, nil
	}

	message := successErr.Error()
	previousLifecycle := NewObject()
	if lifecycle, ok := metadata.Object("llmLifecycle"); ok {
		previousLifecycle = lifecycle
	}
	previousRetries := 0.0
	if value, ok := previousLifecycle.Number("learnRetryCount"); ok && isFinite(value) {
		previousRetries = value
	}
	patch := NewObject()
	warningFlags := uniqueStringList(metadataStrings(metadata, "warningFlags"), []string{"llm_learn_failed"})
	if warningFlags == nil {
		warningFlags = []string{"llm_learn_failed"}
	}
	patch.Set("warningFlags", warningFlags)
	lifecycle := previousLifecycle.Clone()
	lifecycle.SetString("learnHandledAt", s.nowISO())
	lifecycle.SetString("learnError", message)
	lifecycle.SetNumber("learnRetryCount", previousRetries+1)
	lifecycle.SetNull("learnQueuedKey")
	lifecycle.SetNull("learnQueuedAt")
	patch.SetRaw("llmLifecycle", mustJSON(lifecycle))
	if err := s.updateRunMetadata(ctx, run.ID, patch); err != nil {
		return CrawlExecutionSummary{}, err
	}
	// One bounded retry: LLM outages at the exact completion moment are common;
	// more than one retry risks hot-looping a broken upstream.
	if previousRetries < 1 && s.enqueuer != nil {
		taskID := run.ID
		if run.CrawlTaskID != nil && strings.TrimSpace(*run.CrawlTaskID) != "" {
			taskID = *run.CrawlTaskID
		}
		if err := s.enqueuer.EnqueueFrontierLlmLearn(ctx, crawlqueue.EnqueueFrontierLlmLearnOptions{
			OrgID: run.OrgID, TaskID: taskID, RunID: run.ID,
		}); err != nil {
			return CrawlExecutionSummary{}, err
		}
	}
	return CrawlExecutionSummary{}, nil
}

// learnHandledKey is [status, articleCount, pageCount, failedCount,
// duplicateCount].join(":").
func learnHandledKey(run LearnRun) string {
	return strings.Join([]string{
		run.Status,
		itoaInt(run.ArticleCount),
		itoaInt(run.PageCount),
		itoaInt(run.FailedCount),
		itoaInt(run.DuplicateCount),
	}, ":")
}

// handleActiveRunCompletion ports the active-run learn + shadow publish path.
func (s *Service) handleActiveRunCompletion(ctx context.Context, run LearnInput, profile ProfileRecord, finalSummary LearnRun) error {
	if s.llm == nil {
		return nil
	}
	runMetadata := objectOrEmpty(run.Run.Metadata)
	learning, err := s.llm.LearnShadowProfile(ctx, LearnInput{
		OrgID:   run.OrgID,
		Run:     finalSummary,
		Profile: profile,
		Nodes:   run.Nodes,
	})
	if err != nil {
		return err
	}
	shadowProfile, err := s.findShadowProfileForActiveProfile(ctx, run.OrgID, profile.ID)
	if err != nil {
		return err
	}
	if learning != nil && learning.ProfilePatch != nil && learning.Confidence >= 0.45 {
		shadowProfile, err = s.upsertShadowProfileFromSuggestion(ctx, run.OrgID, run.Run.Metadata, profile, *learning, run.Run.ID)
		if err != nil {
			return err
		}
	}
	metadataPatch := NewObject()
	if learning != nil {
		metadataPatch.SetRaw("learningSnapshot", nullableObject(learning.Snapshot))
	} else {
		metadataPatch.SetNull("learningSnapshot")
	}
	if shadowProfile != nil {
		metadataPatch.SetString("shadowProfileId", shadowProfile.ID)
	} else {
		metadataPatch.SetNull("shadowProfileId")
	}
	if learning != nil {
		metadataPatch.SetRaw("shadowLearningConfidence", numberOrNull(learning.Confidence))
		metadataPatch.SetRaw("shadowLearningReason", nullableRawString(learning.Rationale))
	} else {
		metadataPatch.SetRaw("shadowLearningConfidence", json.RawMessage("null"))
		metadataPatch.SetRaw("shadowLearningReason", json.RawMessage("null"))
	}
	if finalSummary.Status == "completed" && shadowProfile != nil {
		if _, triggered := runMetadata.String("shadowEvaluationTriggeredAt"); !triggered {
			shadowRunID, createErr := s.createRunFromProfile(ctx, createRunOptions{
				OrgID: run.OrgID, ActorID: profile.CreatedByID, SeedURL: run.Run.SeedURL,
				Profile: *shadowProfile, ExecutionMode: shadowProfile.ExecutionMode,
				MaxDepth: run.Run.MaxDepth,
				MaxPages: run.Run.MaxPages,
				Keywords: run.Run.Keywords,
				RunMetadata: NewObjectFromPairs(
					"runRole", "shadow",
					"originRunId", run.Run.ID,
					"shadowProfileId", shadowProfile.ID,
					"shadowOfProfileId", profile.ID,
					"shadowEvaluationOfRunId", run.Run.ID,
					"shadowEvaluationTriggeredByRunId", run.Run.ID,
				),
			})
			if createErr != nil {
				return createErr
			}
			metadataPatch.SetString("shadowRunId", shadowRunID)
			metadataPatch.SetString("shadowEvaluationTriggeredAt", s.nowISO())
		}
	}
	return s.updateRunMetadata(ctx, run.Run.ID, metadataPatch)
}

// handleShadowRunCompletion ports the shadow comparison and auto-publish.
func (s *Service) handleShadowRunCompletion(ctx context.Context, run LearnInput, profile ProfileRecord, finalSummary LearnRun) error {
	runMetadata := objectOrEmpty(run.Run.Metadata)
	originRunID, ok := runMetadata.String("originRunId")
	if !ok {
		return nil
	}
	originRun, err := s.loadRun(ctx, originRunID)
	if err != nil {
		return err
	}
	if originRun == nil {
		return nil
	}
	thresholds, _ := profile.Config.Object("llmAssist")
	var autoThresholds *Object
	if thresholds != nil {
		autoThresholds, _ = thresholds.Object("autoPublishThresholds")
	}
	comparison := compareShadowRunAgainstOrigin(originRun, finalSummary, run.Run.Metadata, autoThresholds)
	updatedShadowProfile, err := s.recordShadowEvaluation(ctx, run.OrgID, profile, originRunID, run.Run.ID, comparison)
	if err != nil {
		return err
	}
	patch := NewObject()
	patch.SetRaw("shadowComparison", mustJSON(comparison))
	patch.SetString("shadowComparisonAt", s.nowISO())
	if err := s.updateRunMetadata(ctx, run.Run.ID, patch); err != nil {
		return err
	}
	requiredPasses := 3.0
	if updatedShadowProfile.Config != nil {
		if assist, ok := updatedShadowProfile.Config.Object("llmAssist"); ok {
			if value, ok := assist.Number("shadowEvaluationRuns"); ok {
				requiredPasses = value
			}
		}
	}
	consecutivePasses := 0.0
	activeProfileID := ""
	if updatedShadowProfile.Config != nil {
		if assist, ok := updatedShadowProfile.Config.Object("llmAssist"); ok {
			if shadow, ok := assist.Object("shadow"); ok {
				if value, ok := shadow.Number("consecutivePasses"); ok {
					consecutivePasses = value
				}
				if value, ok := shadow.String("shadowOfProfileId"); ok {
					activeProfileID = value
				}
			}
		}
	}
	passed, _ := comparison.Bool("passed")
	if passed && activeProfileID != "" && consecutivePasses >= requiredPasses {
		published, err := s.publishShadowProfile(ctx, run.OrgID, profile, activeProfileID, updatedShadowProfile.ID, run.Run.ID, comparison)
		if err != nil {
			return err
		}
		patch := NewObject()
		patch.SetString("shadowPublishedAt", s.nowISO())
		if published != nil {
			patch.SetString("shadowPublishedProfileId", published.ID)
		}
		if err := s.updateRunMetadata(ctx, run.Run.ID, patch); err != nil {
			return err
		}
	}
	return nil
}

// compareShadowRunAgainstOrigin ports compareShadowRunAgainstOrigin.
func compareShadowRunAgainstOrigin(origin *RunRecord, shadow LearnRun, shadowMetadata *Object, thresholds *Object) *Object {
	originNoise := float64(origin.NodeCount - origin.ArticleCount)
	if origin.NodeCount == 0 {
		originNoise = float64(origin.PageCount - origin.ArticleCount)
	}
	if originNoise < 0 {
		originNoise = 0
	}
	shadowNodeCount := shadow.NodeCount
	shadowNoise := float64(shadowNodeCount - shadow.ArticleCount)
	if shadowNodeCount == 0 {
		shadowNoise = float64(shadow.PageCount - shadow.ArticleCount)
	}
	if shadowNoise < 0 {
		shadowNoise = 0
	}
	articleLift := 0.0
	if origin.ArticleCount > 0 {
		articleLift = float64(shadow.ArticleCount-origin.ArticleCount) / float64(origin.ArticleCount)
	} else if shadow.ArticleCount > 0 {
		articleLift = 1
	}
	noiseReduction := 0.0
	if originNoise > 0 {
		noiseReduction = (originNoise - shadowNoise) / originNoise
	}
	var averageJudgeConfidence *float64
	if shadowMetadata != nil {
		if judgeSummary, ok := shadowMetadata.Object("judgeSummary"); ok {
			if value, ok := judgeSummary.Number("averageConfidence"); ok {
				averageJudgeConfidence = &value
			}
		}
	}
	minArticleLift, minNoiseReduction, minJudgeConfidence := 0.15, 0.2, 0.75
	if thresholds != nil {
		if value, ok := thresholds.Number("minArticleLift"); ok {
			minArticleLift = value
		}
		if value, ok := thresholds.Number("minNoiseReduction"); ok {
			minNoiseReduction = value
		}
		if value, ok := thresholds.Number("minJudgeConfidence"); ok {
			minJudgeConfidence = value
		}
	}
	passed := shadow.ArticleCount >= origin.ArticleCount &&
		shadow.FailedCount <= origin.FailedCount &&
		(articleLift >= minArticleLift || noiseReduction >= minNoiseReduction) &&
		(averageJudgeConfidence == nil || *averageJudgeConfidence >= minJudgeConfidence)
	summary := "shadow_profile_below_publish_threshold"
	if passed {
		summary = "shadow_profile_improved_frontier_quality"
	}
	thresholdsObject := NewObjectFromPairs(
		"minArticleLift", minArticleLift,
		"minNoiseReduction", minNoiseReduction,
		"minJudgeConfidence", minJudgeConfidence,
	)
	return NewObjectFromPairs(
		"passed", passed,
		"articleLift", roundToFixed(articleLift, 4),
		"noiseReduction", roundToFixed(noiseReduction, 4),
		"averageJudgeConfidence", nullableNumber(averageJudgeConfidence),
		"summary", summary,
		"thresholds", thresholdsObject,
	)
}

// ---------------------------------------------------------------------------
// shadow profile writes

// findShadowProfileForActiveProfile ports the profile-service method.
func (s *Service) findShadowProfileForActiveProfile(ctx context.Context, orgID, activeProfileID string) (*ProfileRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, name, description, matchHost, isActive, executionMode, workflowId,
       workflowVersionId, workflowBindingMode, version, config, createdById
FROM CrawlSiteProfile WHERE orgId = ? AND isActive = 0
ORDER BY updatedAt DESC, createdAt DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		record, scanErr := scanProfileRow(rows, orgID)
		if scanErr != nil {
			return nil, scanErr
		}
		if record == nil {
			continue
		}
		assist, ok := record.Config.Object("llmAssist")
		if !ok {
			continue
		}
		shadow, ok := assist.Object("shadow")
		if !ok {
			continue
		}
		if value, ok := shadow.String("shadowOfProfileId"); ok && value == activeProfileID {
			return record, nil
		}
	}
	return nil, rows.Err()
}

func scanProfileRow(rows *sql.Rows, orgID string) (*ProfileRecord, error) {
	var (
		record                                     ProfileRecord
		description, workflowID, workflowVersionID sql.NullString
		active                                     int
		config                                     []byte
	)
	if err := rows.Scan(&record.ID, &record.Name, &description, &record.MatchHost, &active,
		&record.ExecutionMode, &workflowID, &workflowVersionID, &record.WorkflowBindingMode,
		&record.Version, &config, &record.CreatedByID); err != nil {
		return nil, err
	}
	record.OrgID = orgID
	record.Description = nullStringPtr(description)
	record.WorkflowID = nullStringPtr(workflowID)
	record.WorkflowVersionID = nullStringPtr(workflowVersionID)
	record.IsActive = active != 0
	normalized, err := crawlprofile.NormalizeConfigJSON(config)
	if err != nil {
		record.Config = NewObject()
	} else {
		record.Config = parseObjectOrDefault(normalized)
	}
	return &record, nil
}

// upsertShadowProfileFromSuggestion ports the profile-service method.
func (s *Service) upsertShadowProfileFromSuggestion(ctx context.Context, orgID string, sourceMetadata *Object, active ProfileRecord, learning LearningSuggestion, sourceRunID string) (*ProfileRecord, error) {
	existing, err := s.findShadowProfileForActiveProfile(ctx, orgID, active.ID)
	if err != nil {
		return nil, err
	}
	nextConfig := buildShadowProfileConfig(active, existing, learning, sourceRunID)
	if existing != nil {
		description := existing.Description
		if description == nil {
			value := "Shadow profile learned from " + active.Name
			description = &value
		}
		return s.updateProfile(ctx, orgID, active.CreatedByID, existing.ID, profileUpdate{
			Name: existing.Name, Description: description, MatchHost: existing.MatchHost,
			IsActive: false, ExecutionMode: existing.ExecutionMode, Config: nextConfig,
		})
	}
	name := active.Name + " [shadow]"
	description := active.Description
	if description == nil {
		value := "Shadow profile learned from " + active.Name
		description = &value
	}
	return s.createProfile(ctx, orgID, active.CreatedByID, profileCreate{
		Name: name, Description: description, MatchHost: active.MatchHost,
		IsActive: false, ExecutionMode: active.ExecutionMode, Config: nextConfig,
	})
}

// buildShadowProfileConfig ports buildShadowProfileConfig.
func buildShadowProfileConfig(active ProfileRecord, existing *ProfileRecord, learning LearningSuggestion, sourceRunID string) *Object {
	merged := mergeProfilePatch(active.Config, learning.ProfilePatch)
	assist := NewObject()
	activeEvaluationRuns := 3.0
	var activeAutoPublish *Object
	if active.Config != nil {
		if value, ok := active.Config.Object("llmAssist"); ok {
			assist = value.Clone()
			if runs, ok := value.Number("shadowEvaluationRuns"); ok {
				activeEvaluationRuns = runs
			}
			if thresholds, ok := value.Object("autoPublishThresholds"); ok {
				activeAutoPublish = thresholds
			}
		}
	}
	shadowAssist := NewObject()
	if existing != nil && existing.Config != nil {
		if value, ok := existing.Config.Object("llmAssist"); ok {
			shadowAssist = value.Clone()
		}
	}
	for _, key := range shadowAssist.Keys() {
		if key == "shadow" {
			continue
		}
		assist.SetRaw(key, mustJSONRaw(shadowAssist, key))
	}
	assist.SetBool("enabled", true)
	assist.SetNumber("shadowEvaluationRuns", activeEvaluationRuns)
	if activeAutoPublish != nil {
		assist.SetRaw("autoPublishThresholds", mustJSON(activeAutoPublish))
	} else if _, ok := assist.Object("autoPublishThresholds"); !ok {
		assist.SetRaw("autoPublishThresholds", mustJSON(NewObjectFromPairs(
			"minArticleLift", 0.15, "minNoiseReduction", 0.2, "minJudgeConfidence", 0.75,
		)))
	}
	shadow := NewObject()
	if existing != nil && existing.Config != nil {
		if value, ok := existing.Config.Object("llmAssist"); ok {
			if current, ok := value.Object("shadow"); ok {
				shadow = current.Clone()
			}
		}
	}
	shadow.SetString("role", "shadow")
	shadow.SetString("shadowOfProfileId", active.ID)
	shadow.SetNumber("originProfileVersion", float64(active.Version))
	shadow.SetString("state", "evaluating")
	shadow.SetString("lastOriginRunId", sourceRunID)
	shadow.SetString("lastSuggestedAt", nestNowISOString())
	shadow.SetNumber("lastSuggestionConfidence", learning.Confidence)
	shadow.SetRaw("lastSuggestionReason", nullableRawString(learning.Rationale))
	assist.SetRaw("shadow", mustJSON(shadow))
	merged.SetRaw("llmAssist", mustJSON(assist))
	return normalizeConfigObject(merged)
}

// mergeProfilePatch ports the profile-service mergeProfilePatch: top-level
// spread, then the six nested objects merge key by key.
func mergeProfilePatch(base, patch *Object) *Object {
	merged := objectOrEmpty(base).Clone()
	if patch == nil {
		return merged
	}
	for _, key := range patch.Keys() {
		merged.SetRaw(key, mustJSONRaw(patch, key))
	}
	for _, key := range []string{"urlPatterns", "pageTypeSignals", "localeScope", "seedDiscovery", "llmAssist"} {
		baseNested, _ := base.Object(key)
		patchNested, _ := patch.Object(key)
		if baseNested == nil && patchNested == nil {
			continue
		}
		nested := mergeObjects(baseNested, patchNested)
		if key == "seedDiscovery" {
			baseThresholds, _ := baseNested.Object("qualityThresholds")
			patchThresholds, _ := patchNested.Object("qualityThresholds")
			thresholds := mergeObjects(baseThresholds, patchThresholds)
			if thresholds != nil {
				nested.SetRaw("qualityThresholds", mustJSON(thresholds))
			}
		}
		merged.SetRaw(key, mustJSON(nested))
	}
	return normalizeConfigObject(merged)
}

func normalizeConfigObject(config *Object) *Object {
	if config == nil {
		return NewObject()
	}
	normalized, err := crawlprofile.NormalizeConfigJSON(mustJSON(config))
	if err != nil {
		return config
	}
	return parseObjectOrDefault(normalized)
}

// recordShadowEvaluation ports the profile-service method.
func (s *Service) recordShadowEvaluation(ctx context.Context, orgID string, profile ProfileRecord, originRunID, shadowRunID string, metrics *Object) (*ProfileRecord, error) {
	shadow := NewObject()
	if profile.Config != nil {
		if assist, ok := profile.Config.Object("llmAssist"); ok {
			if current, ok := assist.Object("shadow"); ok {
				shadow = current.Clone()
			}
		}
	}
	evaluationRuns := 0.0
	if value, ok := shadow.Number("evaluationRunsCompleted"); ok {
		evaluationRuns = value
	}
	consecutive := 0.0
	if value, ok := shadow.Number("consecutivePasses"); ok {
		consecutive = value
	}
	passed, _ := metrics.Bool("passed")
	lastReason := ""
	if value, ok := metrics.String("summary"); ok {
		lastReason = value
	} else if value, ok := shadow.String("lastSuggestionReason"); ok {
		lastReason = value
	}
	shadow.SetString("role", "shadow")
	shadow.SetString("state", "evaluating")
	shadow.SetNumber("evaluationRunsCompleted", evaluationRuns+1)
	if passed {
		shadow.SetNumber("consecutivePasses", consecutive+1)
	} else {
		shadow.SetNumber("consecutivePasses", 0)
	}
	shadow.SetString("lastOriginRunId", originRunID)
	shadow.SetString("lastShadowRunId", shadowRunID)
	shadow.SetString("lastSuggestionReason", lastReason)
	config := profile.Config.Clone()
	assist := NewObject()
	if current, ok := config.Object("llmAssist"); ok {
		assist = current.Clone()
	}
	assist.SetRaw("shadow", mustJSON(shadow))
	config.SetRaw("llmAssist", mustJSON(assist))
	description := profile.Description
	return s.updateProfile(ctx, orgID, profile.CreatedByID, profile.ID, profileUpdate{
		Name: profile.Name, Description: description, MatchHost: profile.MatchHost,
		IsActive: false, ExecutionMode: profile.ExecutionMode, Config: normalizeConfigObject(config),
	})
}

// publishShadowProfile ports publishShadowProfile.
func (s *Service) publishShadowProfile(ctx context.Context, orgID string, active ProfileRecord, activeProfileID, shadowProfileID, shadowRunID string, comparison *Object) (*ProfileRecord, error) {
	shadow, err := s.loadProfile(ctx, shadowProfileID, orgID)
	if err != nil || shadow == nil {
		return nil, err
	}
	publishedAt := s.nowISO()
	nextActiveConfig := shadow.Config.Clone()
	nextAssist := NewObject()
	if current, ok := nextActiveConfig.Object("llmAssist"); ok {
		nextAssist = current.Clone()
	}
	nextShadow := NewObjectFromPairs(
		"role", "active", "state", "published",
		"lastShadowRunId", shadowRunID, "lastPublishedAt", publishedAt,
	)
	nextAssist.SetRaw("shadow", mustJSON(nextShadow))
	nextActiveConfig.SetRaw("llmAssist", mustJSON(nextAssist))
	updatedActive, err := s.updateProfile(ctx, orgID, active.CreatedByID, activeProfileID, profileUpdate{
		Name: active.Name, Description: active.Description, MatchHost: active.MatchHost,
		IsActive: active.IsActive, ExecutionMode: shadow.ExecutionMode,
		Config: normalizeConfigObject(nextActiveConfig),
	})
	if err != nil {
		return nil, err
	}
	shadowConfig := shadow.Config.Clone()
	shadowAssist := NewObject()
	if current, ok := shadowConfig.Object("llmAssist"); ok {
		shadowAssist = current.Clone()
	}
	shadowState := NewObject()
	if current, ok := shadowAssist.Object("shadow"); ok {
		shadowState = current.Clone()
	}
	shadowState.SetString("role", "shadow")
	shadowState.SetString("state", "published")
	shadowState.SetString("lastShadowRunId", shadowRunID)
	shadowState.SetString("lastPublishedAt", publishedAt)
	reason := ""
	if value, ok := comparison.String("summary"); ok {
		reason = value
	} else if value, ok := shadowState.String("lastSuggestionReason"); ok {
		reason = value
	}
	shadowState.SetString("lastSuggestionReason", reason)
	shadowAssist.SetRaw("shadow", mustJSON(shadowState))
	shadowConfig.SetRaw("llmAssist", mustJSON(shadowAssist))
	if _, err := s.updateProfile(ctx, orgID, shadow.CreatedByID, shadowProfileID, profileUpdate{
		Name: shadow.Name, Description: shadow.Description, MatchHost: shadow.MatchHost,
		IsActive: false, ExecutionMode: shadow.ExecutionMode, Config: normalizeConfigObject(shadowConfig),
	}); err != nil {
		return nil, err
	}
	return updatedActive, nil
}

// profileCreate is the profile insert input the shadow path needs.
type profileCreate struct {
	Name          string
	Description   *string
	MatchHost     string
	IsActive      bool
	ExecutionMode string
	Config        *Object
}

// profileUpdate is the profile update input the shadow path needs.
type profileUpdate struct {
	Name          string
	Description   *string
	MatchHost     string
	IsActive      bool
	ExecutionMode string
	Config        *Object
}

// createProfile creates the profile and its first version snapshot in one
// transaction, mirroring CrawlSiteProfileService.createProfile.
func (s *Service) createProfile(ctx context.Context, orgID, actorID string, input profileCreate) (*ProfileRecord, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	profileID, err := newRowID()
	if err != nil {
		return nil, err
	}
	now := truncateMillis(s.now())
	config, err := input.Config.MarshalJSON()
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlSiteProfile
  (id, orgId, name, description, matchHost, isActive, executionMode, workflowId,
   workflowVersionId, workflowBindingMode, version, config, createdById, updatedById,
   publishedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'published', 1, ?, ?, ?, ?, ?, ?)`,
		profileID, orgID, input.Name, nullableString(input.Description), input.MatchHost,
		boolToInt(input.IsActive), input.ExecutionMode, config, actorID, actorID, now, now, now)
	if err != nil {
		return nil, err
	}
	if err := s.insertProfileVersion(ctx, tx, profileID, orgID, actorID, 1, input.Name,
		input.Description, input.MatchHost, input.IsActive, input.ExecutionMode, config, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.loadProfile(ctx, profileID, orgID)
}

// updateProfile increments the profile version and appends the snapshot in one
// transaction inside a row lock, mirroring CrawlSiteProfileService.updateProfile.
func (s *Service) updateProfile(ctx context.Context, orgID, actorID, profileID string, input profileUpdate) (*ProfileRecord, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var lockedID string
	if err := tx.QueryRowContext(ctx,
		"SELECT id FROM CrawlSiteProfile WHERE id = ? AND orgId = ? FOR UPDATE",
		profileID, orgID).Scan(&lockedID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, notFound("Crawl site profile not found")
		}
		return nil, err
	}
	var currentVersion int
	var currentConfig []byte
	if err := tx.QueryRowContext(ctx,
		"SELECT version, config FROM CrawlSiteProfile WHERE id = ?", profileID).Scan(&currentVersion, &currentConfig); err != nil {
		return nil, err
	}
	config := input.Config
	if config == nil {
		config = parseObjectOrDefault(currentConfig)
	}
	encoded, err := config.MarshalJSON()
	if err != nil {
		return nil, err
	}
	nextVersion := currentVersion + 1
	now := truncateMillis(s.now())
	_, err = tx.ExecContext(ctx, `
UPDATE CrawlSiteProfile
SET name = ?, description = ?, matchHost = ?, isActive = ?, executionMode = ?,
    version = ?, config = ?, updatedById = ?, publishedAt = ?, updatedAt = ?
WHERE id = ? AND orgId = ?`,
		input.Name, nullableString(input.Description), input.MatchHost, boolToInt(input.IsActive),
		input.ExecutionMode, nextVersion, encoded, actorID, now, now, profileID, orgID)
	if err != nil {
		return nil, err
	}
	if err := s.insertProfileVersion(ctx, tx, profileID, orgID, actorID, nextVersion, input.Name,
		input.Description, input.MatchHost, input.IsActive, input.ExecutionMode, encoded, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.loadProfile(ctx, profileID, orgID)
}

func (s *Service) insertProfileVersion(ctx context.Context, tx *sql.Tx, profileID, orgID, actorID string, version int, name string, description *string, matchHost string, isActive bool, executionMode string, config []byte, createdAt time.Time) error {
	versionID, err := newRowID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO CrawlSiteProfileVersion
  (id, profileId, orgId, version, name, description, matchHost, isActive, executionMode,
   workflowId, workflowVersionId, workflowBindingMode, config, createdById, createdAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'published', ?, ?, ?)`,
		versionID, profileID, orgID, version, name, nullableString(description), matchHost,
		boolToInt(isActive), executionMode, config, actorID, createdAt)
	return err
}

// ---------------------------------------------------------------------------
// shadow run creation

// createRunOptions is createRunFromProfile's argument set.
type createRunOptions struct {
	OrgID         string
	ActorID       string
	SeedURL       string
	Profile       ProfileRecord
	ExecutionMode string
	MaxDepth      int
	MaxPages      int
	Keywords      []string
	RunMetadata   *Object
}

// createRunFromProfile ports createRunFromProfile.
func (s *Service) createRunFromProfile(ctx context.Context, options createRunOptions) (string, error) {
	seedURL := strings.TrimSpace(options.SeedURL)
	if parsed, ok := parseHTTPURL(seedURL); ok {
		seedURL = parsed.String()
	} else {
		return "", badRequest("seedUrl must be a valid absolute URL")
	}
	now := truncateMillis(s.now())
	taskID, err := newRowID()
	if err != nil {
		return "", err
	}
	displayName := sliceRunes("Frontier: "+options.Profile.Name, 80)
	keywords := options.Keywords
	if keywords == nil {
		keywords = []string{}
	}
	taskConfig := NewObject()
	taskConfig.SetBool("frontier", true)
	taskConfig.SetString("frontierProfileId", options.Profile.ID)
	taskConfig.SetString("executionMode", options.ExecutionMode)
	if options.Profile.WorkflowID != nil {
		taskConfig.SetString("workflowId", *options.Profile.WorkflowID)
	} else {
		taskConfig.SetNull("workflowId")
	}
	if options.Profile.WorkflowVersionID != nil {
		taskConfig.SetString("workflowVersionId", *options.Profile.WorkflowVersionID)
	} else {
		taskConfig.SetNull("workflowVersionId")
	}
	taskConfig.SetString("workflowBindingMode", defaultString(options.Profile.WorkflowBindingMode, "published"))
	taskConfig.Set("urlQueryParamAllowlist", normalizeAllowlist(configStringListOrNil(options.Profile.Config, "urlQueryParamAllowlist")))
	itemMetadata := NewObjectFromPairs("frontier", true, "crawlSiteProfileId", options.Profile.ID)
	taskConfig.Set("itemPayload", NewObjectFromPairs("metadata", itemMetadata))
	taskConfigJSON, err := taskConfig.MarshalJSON()
	if err != nil {
		return "", err
	}
	keywordsJSON := mustJSON(keywords)
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlTask
  (id, orgId, createdById, targetUrl, displayName, status, concurrency, keywords, config,
   createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?)`,
		taskID, options.OrgID, options.ActorID, seedURL, displayName, keywordsJSON, taskConfigJSON, now, now)
	if err != nil {
		return "", err
	}

	runID, err := newRowID()
	if err != nil {
		return "", err
	}
	metadata := NewObject()
	metadata.SetNumber("profileVersion", float64(options.Profile.Version))
	budgets := ComputeFrontierPageTypeBudgets(options.MaxDepth, options.MaxPages)
	metadata.SetRaw("pageTypeBudgets", mustJSON(NewObjectFromPairs(
		"home", budgets.Home, "category", budgets.Category, "list", budgets.List, "article", budgets.Article,
	)))
	metadata.SetString("seedStrategy", resolveSeedStrategy(options.Profile.Config))
	seedDiscoveryMode := "robots"
	topologyPages := json.RawMessage("null")
	topologyDepth := json.RawMessage("null")
	if options.Profile.Config != nil {
		if seed, ok := options.Profile.Config.Object("seedDiscovery"); ok {
			if value, ok := seed.String("mode"); ok {
				seedDiscoveryMode = value
			}
			if raw, ok := seed.Raw("topologyBudgetPages"); ok {
				topologyPages = raw
			}
			if raw, ok := seed.Raw("topologyBudgetDepth"); ok {
				topologyDepth = raw
			}
		}
	}
	metadata.SetString("seedDiscoveryMode", seedDiscoveryMode)
	metadata.SetRaw("topologyBudgetPages", topologyPages)
	metadata.SetRaw("topologyBudgetDepth", topologyDepth)
	metadata.SetString("sourceTier", configStringOr(options.Profile.Config, "sourceTier", "tier2"))
	metadata.SetString("hostScope", resolveHostScope(options.Profile.Config))
	metadata.SetRaw("workflowId", nullableStringJSON(options.Profile.WorkflowID))
	metadata.SetRaw("workflowVersionId", nullableStringJSON(options.Profile.WorkflowVersionID))
	metadata.SetString("workflowBindingMode", defaultString(options.Profile.WorkflowBindingMode, "published"))
	if options.RunMetadata != nil {
		for _, key := range options.RunMetadata.Keys() {
			metadata.SetRaw(key, mustJSONRaw(options.RunMetadata, key))
		}
	}
	metadataJSON, err := metadata.MarshalJSON()
	if err != nil {
		return "", err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlFrontierRun
  (id, orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status,
   maxDepth, maxPages, keywords, pageCount, nodeCount, articleCount, failedCount,
   duplicateCount, nativeRunId, lastError, metadata, createdById, startedAt, finishedAt,
   createdAt, updatedAt)
VALUES (?, ?, ?, NULL, ?, ?, ?, 'queued', ?, ?, ?, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, NULL, NULL, ?, ?)`,
		runID, options.OrgID, options.Profile.ID, seedURL, taskID, options.ExecutionMode,
		options.MaxDepth, options.MaxPages, keywordsJSON, metadataJSON, options.ActorID, now, now)
	if err != nil {
		return "", err
	}

	workflowRunID, workflowOrigin, definition, workflowID, workflowVersionID, parameterSources, err := s.createWorkflowRunForFrontier(ctx, options, runID, seedURL)
	if err != nil {
		return "", err
	}
	runPatch := NewObject()
	runPatch.SetString("workflowRunId", workflowRunID)
	runPatch.SetString("workflowOrigin", workflowOrigin)
	runPatch.SetNumber("workflowGraphNodeCount", float64(len(definition.Nodes)))
	runPatch.SetNumber("workflowGraphEdgeCount", float64(len(definition.Edges)))
	if err := s.updateRunMetadata(ctx, runID, runPatch); err != nil {
		return "", err
	}
	_ = workflowID
	_ = workflowVersionID
	_ = parameterSources

	rootMetadata := NewObject()
	rootMetadata.SetBool("seed", true)
	rootMetadata.SetString("profileId", options.Profile.ID)
	rootMetadata.SetString("seedStrategy", resolveSeedStrategy(options.Profile.Config))
	rootMetadata.SetString("seedOrigin", "frontier_root")
	rootMetadata.SetString("sourceTier", configStringOr(options.Profile.Config, "sourceTier", "tier2"))
	rootMetadata.Set("discoveryPath", []string{"home"})
	rootMetadata.Set("frontierPath", []string{"home"})
	rootMetadata.SetString("workflowRunId", workflowRunID)
	rootMetadata.SetString("workflowOrigin", workflowOrigin)
	runRole := "active"
	if options.RunMetadata != nil {
		if value, ok := options.RunMetadata.String("runRole"); ok {
			runRole = value
		}
	}
	rootMetadata.SetString("runRole", runRole)
	rootID, _, _, err := s.persistFrontierNode(ctx, persistNodeInput{
		RunID: runID, OrgID: options.OrgID, URL: seedURL, PageType: "home", Depth: 0,
		QueueClass: "hot", Status: "queued", QueuedAt: s.nowISO(), Metadata: rootMetadata,
	})
	if err != nil {
		return "", err
	}
	if err := s.enqueueNode(ctx, options.OrgID, taskID, runID, rootID, "hot"); err != nil {
		return "", err
	}
	return runID, nil
}

// workflowGraph is the subset of the graph snapshot createRunFromProfile needs.
type workflowGraph struct {
	Nodes []json.RawMessage
	Edges []json.RawMessage
}

func (s *Service) createWorkflowRunForFrontier(ctx context.Context, options createRunOptions, runID, seedURL string) (string, string, workflowGraph, *string, *string, []crawlworkflow.ParameterSource, error) {
	workflowID := options.Profile.WorkflowID
	workflowVersionID := options.Profile.WorkflowVersionID
	workflowOrigin := "bound"
	var definitionJSON json.RawMessage
	var parameterSources []crawlworkflow.ParameterSource
	if workflowID != nil || workflowVersionID != nil {
		if s.workflows == nil {
			return "", "", workflowGraph{}, nil, nil, nil, errors.New("crawlfrontierllm: workflow service is not configured")
		}
		resolved, err := s.workflows.ResolveBoundWorkflowVersion(ctx, options.OrgID, derefString(workflowID), derefString(workflowVersionID))
		if err != nil {
			return "", "", workflowGraph{}, nil, nil, nil, err
		}
		if resolved != nil {
			workflowID = stringPointer(resolved.WorkflowID)
			workflowVersionID = stringPointer(resolved.VersionID)
			definitionJSON = mustJSON(resolved.Definition)
			overlay, overlayErr := s.workflows.CompileProfileOverlay(ctx, options.OrgID, resolved.WorkflowID, resolved.VersionID)
			if overlayErr != nil {
				return "", "", workflowGraph{}, nil, nil, nil, overlayErr
			}
			if overlay != nil {
				parameterSources = overlay.ParameterSources
			}
		}
	}
	if len(definitionJSON) == 0 {
		workflowOrigin = "legacy_bridge"
		definition := buildLegacyProfileDefinition(options.Profile, seedURL)
		definitionJSON = mustJSON(definition)
		parameterSources = []crawlworkflow.ParameterSource{{
			Key: "legacy_profile_bridge",
			Value: mustJSON(NewObjectFromPairs(
				"profileId", options.Profile.ID, "profileVersion", options.Profile.Version,
			)),
			Source: "legacy_profile",
		}}
	}
	graph, err := parseWorkflowGraph(definitionJSON)
	if err != nil {
		return "", "", workflowGraph{}, nil, nil, nil, err
	}

	input := NewObject()
	input.SetString("frontierRunId", runID)
	input.SetString("seedUrl", seedURL)
	input.SetString("profileId", options.Profile.ID)
	input.SetString("executionMode", options.ExecutionMode)
	input.SetNumber("maxDepth", float64(options.MaxDepth))
	input.SetNumber("maxPages", float64(options.MaxPages))
	keywords := options.Keywords
	if keywords == nil {
		keywords = []string{}
	}
	input.Set("keywords", keywords)
	workflowRunID, err := newRowID()
	if err != nil {
		return "", "", workflowGraph{}, nil, nil, nil, err
	}
	now := truncateMillis(s.now())
	_, err = s.db.ExecContext(ctx, `
INSERT INTO CrawlStrategyWorkflowRun
  (id, orgId, workflowId, workflowVersionId, workflowOrigin, profileId, newsSourceId, status,
   runKind, input, output, graphSnapshot, stepResults, candidates, parameterSources, error,
   stepCount, candidateCount, selectedCount, createdById, startedAt, finishedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', 'frontier_run', ?, NULL, ?, NULL, NULL, ?, NULL,
        0, 0, 0, ?, NULL, NULL, ?, ?)`,
		workflowRunID, options.OrgID, nullableString(workflowID), nullableString(workflowVersionID),
		workflowOrigin, options.Profile.ID, mustJSON(input), definitionJSON,
		mustJSON(parameterSources), options.ActorID, now, now)
	if err != nil {
		return "", "", workflowGraph{}, nil, nil, nil, err
	}
	if _, err := s.db.ExecContext(ctx,
		"UPDATE CrawlFrontierRun SET workflowRunId = ?, updatedAt = ? WHERE id = ?",
		workflowRunID, now, runID); err != nil {
		return "", "", workflowGraph{}, nil, nil, nil, err
	}
	return workflowRunID, workflowOrigin, graph, workflowID, workflowVersionID, parameterSources, nil
}

func parseWorkflowGraph(raw json.RawMessage) (workflowGraph, error) {
	object, ok := ParseObject(raw)
	if !ok {
		return workflowGraph{}, errors.New("workflow graph is not an object")
	}
	graph := workflowGraph{}
	if nodesRaw, ok := object.Raw("nodes"); ok {
		_ = json.Unmarshal(nodesRaw, &graph.Nodes)
	}
	if edgesRaw, ok := object.Raw("edges"); ok {
		_ = json.Unmarshal(edgesRaw, &graph.Edges)
	}
	return graph, nil
}

// buildLegacyProfileDefinition ports buildWorkflowFromProfile.
func buildLegacyProfileDefinition(profile ProfileRecord, seedURL string) *Object {
	config := objectOrEmpty(profile.Config)
	description := "Generated from profile " + profile.Name
	if profile.Description != nil && *profile.Description != "" {
		description = *profile.Description
	}
	settings := NewObject()
	settings.SetString("executionMode", profile.ExecutionMode)
	settings.SetNumber("maxDepth", configLayeredOrDefault(config, "maxDepth", 3))
	settings.SetNumber("maxPages", configLayeredOrDefault(config, "maxPages", 60))
	robots := "respect"
	if crawlOptions, ok := config.Object("crawlOptions"); ok {
		if check, ok := crawlOptions.Bool("check_robots_txt"); ok && !check {
			robots = "ignore"
		}
	}
	settings.SetString("robotsPolicy", robots)
	domainScope := "registrable_domain"
	if value, ok := config.String("hostScope"); ok && value == "strict_hosts" {
		domainScope = "strict_hosts"
	}
	settings.SetString("domainScope", domainScope)

	metadata := NewObjectFromPairs("description", description, "template", "legacy_profile", "tags", []string{})
	definition := NewObject()
	definition.SetNumber("version", 1)
	definition.SetRaw("metadata", mustJSON(metadata))
	definition.SetRaw("settings", mustJSON(settings))
	nodes := buildLegacyNodes(config, seedURL)
	definition.SetRaw("nodes", mustJSON(nodes))
	definition.SetRaw("edges", mustJSON(legacyEdges()))
	return definition
}

func buildLegacyNodes(config *Object, seedURL string) *Array {
	seedConfig := NewObjectFromPairs("mode", "sitemap", "seedUrl", seedURL, "maxUrls", 40)
	seedMode := "robots"
	if seed, ok := config.Object("seedDiscovery"); ok {
		if value, ok := seed.String("mode"); ok {
			seedMode = value
		}
	}
	seedConfig.SetString("mode", seedMode)
	if seed, ok := config.Object("seedDiscovery"); ok {
		if value, ok := seed.Number("maxSeedUrls"); ok {
			seedConfig.SetNumber("maxUrls", value)
		}
	}
	urlPatterns, _ := config.Object("urlPatterns")
	pageTypeSignals, _ := config.Object("pageTypeSignals")
	keywords := append(configStringList(config, "keywords"), configStringList(config, "priorityKeywords")...)
	freshness, _ := config.Object("freshnessRules")
	freshnessValues := NewObjectFromPairs(
		"recentHours", 24, "weekHours", 168, "monthHours", 720,
	)
	if freshness != nil {
		for _, key := range []string{"recentHours", "weekHours", "monthHours"} {
			if value, ok := freshness.Number(key); ok {
				freshnessValues.SetNumber(key, value)
			}
		}
	}
	maxPages := configLayeredOrDefault(config, "maxPages", 60)
	maxDepth := configLayeredOrDefault(config, "maxDepth", 3)
	scoreThreshold := configLayeredOrDefault(config, "scoreThreshold", 0)
	nodes := NewArray()
	appendNode := func(id, nodeType, label string, x, y float64, nodeConfig *Object) {
		node := NewObject()
		node.SetString("id", id)
		node.SetString("type", nodeType)
		node.SetString("label", label)
		node.Set("position", NewObjectFromPairs("x", x, "y", y))
		node.SetRaw("config", mustJSON(nodeConfig))
		nodes.Append(mustJSON(node))
	}
	appendNode("seed-discovery", "seed-discovery", "Seed Discovery", 80, 120, seedConfig)
	appendNode("url-filter", "url-filter", "URL Filter", 360, 120, NewObjectFromPairs(
		"includePatterns", nestedStrings(urlPatterns, "article"),
		"excludePatterns", nestedStrings(urlPatterns, "exclude"),
		"blockedDomains", configStringList(config, "blockedDomains"),
		"allowedHosts", configStringList(config, "allowedHosts"),
		"denyKeywords", configStringList(config, "denyKeywords"),
	))
	appendNode("page-type-classifier", "page-type-classifier", "Page Type", 640, 120, NewObjectFromPairs(
		"urlPatterns", objectOrEmpty(urlPatterns), "pageTypeSignals", objectOrEmpty(pageTypeSignals),
	))
	appendNode("url-scorer", "url-scorer", "URL Score", 920, 120, NewObjectFromPairs("keywordBoosts", keywords))
	appendNode("freshness-scorer", "freshness-scorer", "Freshness", 1200, 120, freshnessValues)
	appendNode("budget-control", "budget-control", "Budget Control", 1480, 120, NewObjectFromPairs(
		"keepTopK", maxPages, "minScore", scoreThreshold, "maxPages", maxPages, "maxDepth", maxDepth,
	))
	appendNode("persist-result", "persist-result", "Persist Result", 1760, 120, NewObjectFromPairs("selectTopK", maxPages))
	return nodes
}

func legacyEdges() *Array {
	edges := NewArray()
	for _, pair := range [][2]string{
		{"seed-discovery", "url-filter"},
		{"url-filter", "page-type-classifier"},
		{"page-type-classifier", "url-scorer"},
		{"url-scorer", "freshness-scorer"},
		{"freshness-scorer", "budget-control"},
		{"budget-control", "persist-result"},
	} {
		edges.Append(mustJSON(NewObjectFromPairs(
			"id", pair[0]+"->"+pair[1], "source", pair[0], "target", pair[1],
		)))
	}
	return edges
}

// ---------------------------------------------------------------------------
// small value helpers

func resolveSeedStrategy(config *Object) string {
	if config != nil {
		if seed, ok := config.Object("seedDiscovery"); ok {
			if value, ok := seed.String("strategy"); ok {
				return value
			}
		}
	}
	return "auto"
}

func resolveHostScope(config *Object) string {
	if config != nil {
		if value, ok := config.String("hostScope"); ok {
			return value
		}
		hosts := configStringList(config, "allowedHosts")
		domains := configStringList(config, "allowedDomains")
		if len(hosts) > 0 && len(domains) == 0 {
			return "strict_hosts"
		}
	}
	return "registrable_domain"
}

func normalizeAllowlist(values []string) []string {
	if values == nil {
		return DefaultURLQueryParamAllowlist
	}
	return NormalizeURLQueryParamAllowlist(values, DefaultURLQueryParamAllowlist)
}

func configLayeredOrDefault(config *Object, key string, fallback float64) float64 {
	if config != nil {
		if layered, ok := config.Object("layeredOptions"); ok {
			if value, ok := layered.Number(key); ok {
				return value
			}
		}
	}
	return fallback
}

func nestedStrings(object *Object, key string) []string {
	if object == nil {
		return []string{}
	}
	values, ok := object.Strings(key)
	if !ok {
		return []string{}
	}
	return values
}

func mustJSONRaw(object *Object, key string) json.RawMessage {
	if object == nil {
		return json.RawMessage("null")
	}
	raw, ok := object.Raw(key)
	if !ok {
		return json.RawMessage("null")
	}
	return raw
}

func nullableStringJSON(value *string) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	return mustJSON(*value)
}

func numberOrNull(value float64) json.RawMessage {
	if !isFinite(value) {
		return json.RawMessage("null")
	}
	return numberJSON(value)
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func itoaInt(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := make([]byte, 0, 12)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

// configNumber reads a numeric run-metadata field with a fallback.
func (o *Object) configNumber(key string, fallback int) int {
	if o == nil {
		return fallback
	}
	value, ok := o.Number(key)
	if !ok {
		return fallback
	}
	return int(value)
}

// stringList reads a string array run-metadata field.
func (o *Object) stringList(key string) []string {
	if o == nil {
		return nil
	}
	values, ok := o.Strings(key)
	if !ok {
		return nil
	}
	return values
}

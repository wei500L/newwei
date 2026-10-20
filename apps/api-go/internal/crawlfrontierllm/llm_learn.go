package crawlfrontierllm

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
)

// llm_learn.go ports CrawlFrontierLlmService.learnShadowProfile and its
// buildLearningSnapshot. The snapshot is the exact prompt body; the response
// validation and the confidence clamp match the Zod schema.

// LearnRun is the run projection learnShadowProfile reads.
type LearnRun struct {
	ID             string
	SeedURL        string
	Status         string
	MaxDepth       int
	MaxPages       int
	NodeCount      int
	Keywords       []string
	ArticleCount   int
	PageCount      int
	FailedCount    int
	DuplicateCount int
	Metadata       *Object
}

// LearnInput is learnShadowProfile's argument set.
type LearnInput struct {
	OrgID   string
	Run     LearnRun
	Profile ProfileRecord
	Nodes   []NodeRecord
}

// LearningSuggestion is FrontierProfileLearningSuggestion.
type LearningSuggestion struct {
	Confidence   float64
	Rationale    *string
	ProfilePatch *Object
	Snapshot     *Object
}

const learnSystemPrompt = "You are improving a reusable news crawl site profile. " +
	"Only suggest constrained config fields that improve article discovery and reduce navigation noise. " +
	"Do not output arbitrary crawl payloads, JavaScript, extraction strategies, auth, or bypass logic. " +
	"Return strict JSON only."

// LearnShadowProfile implements the learn chain.
func (c *LLMClient) LearnShadowProfile(ctx context.Context, input LearnInput) (*LearningSuggestion, error) {
	assist := ResolveEffectiveLlmAssistConfig(input.Profile.Config, LlmPurposeLearn)
	if assist == nil {
		return nil, nil
	}
	if c.isCircuitOpen("learn") {
		return nil, errors.New("llm_learn_circuit_open")
	}
	snapshot := buildLearningSnapshot(input)
	snapshotJSON, err := snapshot.MarshalJSON()
	if err != nil {
		return nil, err
	}
	metadata := NewObject()
	metadata.SetString("feature", "crawl_frontier_learn")
	metadata.SetString("source", "crawl-frontier")
	metadata.SetString("runId", input.Run.ID)
	metadata.SetString("profileId", input.Profile.ID)
	metadata.SetString("frontierRunId", input.Run.ID)
	metadata.SetString("crawlSiteProfileId", input.Profile.ID)
	response, callErr := c.complete(ctx, completionRequest{
		OrgID:          input.OrgID,
		Model:          assist.SiteLearnerModel,
		Temperature:    0.15,
		MaxTokens:      1800,
		ResponseFormat: learnResponseFormat(),
		Metadata:       metadata,
		Messages: []chatMessage{
			{Role: "system", Content: learnSystemPrompt},
			{Role: "user", Content: prettyJSON(snapshotJSON)},
		},
	})
	if callErr != nil {
		c.recordCircuitFailure("learn")
		return nil, callErr
	}
	text := completionText(response.Choices)
	parsedRaw, ok := safeJSONParseFromText(text)
	if !ok {
		c.recordCircuitFailure("learn")
		return nil, errors.New("llm_learn_parse_failed")
	}
	parsed, ok := validateLearnResponse(parsedRaw)
	if !ok {
		c.recordCircuitFailure("learn")
		return nil, errors.New("llm_learn_parse_failed")
	}
	c.recordCircuitSuccess("learn")
	return &LearningSuggestion{
		Confidence:   clamp01(parsed.Confidence, 0.5),
		Rationale:    parsed.Rationale,
		ProfilePatch: parsed.ProfilePatch,
		Snapshot:     snapshot,
	}, nil
}

func buildLearningSnapshot(input LearnInput) *Object {
	runMetadata := input.Run.Metadata
	topArticles := NewArray()
	for _, node := range input.Nodes {
		if node.PageType != "article" {
			continue
		}
		item := NewObject()
		item.SetString("url", node.URL)
		item.SetString("status", node.Status)
		item.SetRaw("score", nullableNumber(node.Score))
		item.SetRaw("freshnessScore", nullableNumber(node.FreshnessScore))
		judgeMethod := ""
		if node.Metadata != nil {
			judgeMethod, _ = node.Metadata.String("judgeMethod")
		}
		item.SetRaw("judgeMethod", nullableRawString(stringPointer(judgeMethod)))
		topArticles.Append(mustJSON(item))
		if topArticles.Len() >= 12 {
			break
		}
	}

	topRejected := buildTopRejected(runMetadata)

	pageSamples := NewArray()
	for index, node := range input.Nodes {
		if index >= 24 {
			break
		}
		item := NewObject()
		item.SetString("url", node.URL)
		item.SetString("pageType", node.PageType)
		item.SetString("status", node.Status)
		item.SetRaw("discoveryPath", metadataRawOrNull(node.Metadata, "discoveryPath"))
		judgeMethod := ""
		judgeReason := ""
		if node.Metadata != nil {
			judgeMethod, _ = node.Metadata.String("judgeMethod")
			judgeReason, _ = node.Metadata.String("judgeReason")
		}
		item.SetRaw("judgeMethod", nullableRawString(stringPointer(judgeMethod)))
		item.SetRaw("judgeReason", nullableRawString(stringPointer(judgeReason)))
		pageSamples.Append(mustJSON(item))
	}

	profileConfig := input.Profile.Config
	snapshot := NewObject()
	snapshot.SetString("seedUrl", input.Run.SeedURL)
	snapshot.SetString("runId", input.Run.ID)
	snapshot.SetString("runStatus", input.Run.Status)
	snapshot.SetNumber("articleCount", float64(input.Run.ArticleCount))
	snapshot.SetNumber("pageCount", float64(input.Run.PageCount))
	snapshot.SetNumber("failedCount", float64(input.Run.FailedCount))
	snapshot.SetNumber("duplicateCount", float64(input.Run.DuplicateCount))
	snapshot.SetRaw("rootDiagnosis", metadataRawOrNull(runMetadata, "rootDiagnosis"))
	snapshot.SetRaw("coverage", metadataRawOrNull(runMetadata, "coverage"))
	snapshot.SetRaw("candidateStats", metadataRawOrNull(runMetadata, "candidateStats"))
	snapshot.SetRaw("seedDiagnostics", metadataRawOrNull(runMetadata, "seedDiagnostics"))
	snapshot.SetRaw("seedQuality", metadataRawOrNull(runMetadata, "seedQuality"))
	snapshot.SetRaw("seedYield", metadataRawOrNull(runMetadata, "seedYield"))
	fallbackStage := ""
	if runMetadata != nil {
		fallbackStage, _ = runMetadata.String("fallbackStage")
	}
	snapshot.SetRaw("fallbackStage", nullableRawString(stringPointer(fallbackStage)))
	snapshot.Set("warningFlags", asStringArray(runMetadata, "warningFlags"))

	activeProfile := NewObject()
	activeProfile.SetString("id", input.Profile.ID)
	activeProfile.SetString("name", input.Profile.Name)
	activeProfile.SetString("matchHost", input.Profile.MatchHost)
	activeProfile.SetString("executionMode", input.Profile.ExecutionMode)
	activeProfile.SetRaw("seedDiscovery", metadataRawOrNull(profileConfig, "seedDiscovery"))
	sourceTier := "tier2"
	if profileConfig != nil {
		if value, ok := profileConfig.String("sourceTier"); ok {
			sourceTier = value
		}
	}
	activeProfile.SetString("sourceTier", sourceTier)
	hostScope := "registrable_domain"
	if profileConfig != nil {
		if value, ok := profileConfig.String("hostScope"); ok {
			hostScope = value
		}
	}
	activeProfile.SetString("hostScope", hostScope)
	activeProfile.SetRaw("localeScope", metadataRawOrNull(profileConfig, "localeScope"))
	activeProfile.SetRaw("urlPatterns", metadataRawOrNull(profileConfig, "urlPatterns"))
	activeProfile.SetRaw("pageTypeSignals", metadataRawOrNull(profileConfig, "pageTypeSignals"))
	activeProfile.Set("domLinkScopes", configStringList(profileConfig, "domLinkScopes"))
	activeProfile.Set("domLinkExcludeSelectors", configStringList(profileConfig, "domLinkExcludeSelectors"))
	activeProfile.Set("priorityKeywords", configStringList(profileConfig, "priorityKeywords"))
	activeProfile.Set("denyKeywords", configStringList(profileConfig, "denyKeywords"))
	snapshot.SetRaw("activeProfile", mustJSON(activeProfile))
	snapshot.SetRaw("topArticles", mustJSON(topArticles))
	snapshot.SetRaw("topRejected", mustJSON(topRejected))
	snapshot.SetRaw("pageSamples", mustJSON(pageSamples))
	return snapshot
}

func buildTopRejected(runMetadata *Object) *Array {
	type rejectedEntry struct {
		reason string
		count  float64
	}
	entries := make([]rejectedEntry, 0)
	if runMetadata != nil {
		if counts, ok := runMetadata.Object("rejectionCounts"); ok {
			for _, key := range counts.Keys() {
				raw, _ := counts.Raw(key)
				count, ok := toFiniteNumber(raw)
				if !ok {
					count = 0
				}
				entries = append(entries, rejectedEntry{reason: key, count: count})
			}
		}
	}
	sort.SliceStable(entries, func(left, right int) bool {
		return entries[left].count > entries[right].count
	})
	if len(entries) > 10 {
		entries = entries[:10]
	}
	out := NewArray()
	for _, entry := range entries {
		item := NewObject()
		item.SetString("reason", entry.reason)
		item.SetNumber("count", entry.count)
		out.Append(mustJSON(item))
	}
	return out
}

// asStringArray is asStringArray: a non-array is empty, non-string entries are
// dropped.
func asStringArray(object *Object, key string) []string {
	if object == nil {
		return []string{}
	}
	raw, ok := object.Raw(key)
	if !ok {
		return []string{}
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			continue
		}
		out = append(out, text)
	}
	return out
}

func nullableNumber(value *float64) json.RawMessage {
	if value == nil || !isFinite(*value) {
		return json.RawMessage("null")
	}
	return mustJSON(*value)
}

package crawlfrontierllm

import (
	"context"
	"encoding/json"
	"math"
	"strings"
)

// llm_judge.go ports CrawlFrontierLlmService.judgeCandidates and
// rerankCandidates. The request payload, the response_format, the decision
// thresholds and the metadata merge are the source values.

// JudgeInput is judgeCandidates' argument set.
type JudgeInput struct {
	OrgID          string
	RunID          string
	NodeID         string
	ProfileID      *string
	SeedURL        string
	ParentURL      string
	ParentPageType string
	Config         *Object
	Candidates     []Candidate
}

// JudgeResult is FrontierLlmJudgeResult.
type JudgeResult struct {
	Candidates  []Candidate
	Diagnostics *Object
}

const judgeSystemPrompt = "You are helping a news intelligence crawler choose frontier links. " +
	"Use only the provided URL, anchor text, page type hints, freshness, and scores. " +
	"Prefer real news section pages, latest/list pages, and current article pages. " +
	"Drop utility/legal/account/newsletter/podcast/video/gallery/profile/author/tag/search links unless the evidence strongly shows a news landing page. " +
	"Return strict JSON only."

// JudgeCandidates implements the judge chain.
func (c *LLMClient) JudgeCandidates(ctx context.Context, input JudgeInput) (JudgeResult, error) {
	assist := ResolveEffectiveLlmAssistConfig(input.Config, LlmPurposeJudge)
	if assist == nil || len(input.Candidates) == 0 {
		return JudgeResult{
			Candidates: input.Candidates,
			Diagnostics: diagnosticsObject(map[string]any{
				"llmJudgeEnabled":   false,
				"llmJudgeAttempted": false,
			}, nil),
		}, nil
	}
	if c.isCircuitOpen("judge") {
		return JudgeResult{
			Candidates: input.Candidates,
			Diagnostics: diagnosticsObject(map[string]any{
				"llmJudgeEnabled":     true,
				"llmJudgeAttempted":   false,
				"llmJudgeCircuitOpen": true,
			}, []string{"llm_judge_circuit_open"}),
		}, nil
	}
	budget := ResolveCandidateBudget(assist, input.ParentPageType)
	if budget <= 0 {
		return JudgeResult{
			Candidates: input.Candidates,
			Diagnostics: diagnosticsObject(map[string]any{
				"llmJudgeEnabled":   true,
				"llmJudgeAttempted": false,
				"llmJudgeBudget":    0,
			}, nil),
		}, nil
	}

	reranked := make([]Candidate, len(input.Candidates))
	copy(reranked, input.Candidates)
	rerankApplied := false
	topN := budget
	if topN < 8 {
		topN = 8
	}
	if recall := ResolveRecallBudget(assist, input.ParentPageType); topN > recall {
		topN = recall
	}
	if results, err := c.rerankCandidates(ctx, input, assist, reranked, topN); err == nil {
		reranked = results
		rerankApplied = true
	}
	if budget > len(reranked) {
		budget = len(reranked)
	}
	candidatesForJudge := reranked[:budget]
	if len(candidatesForJudge) == 0 {
		return JudgeResult{
			Candidates: reranked,
			Diagnostics: diagnosticsObject(map[string]any{
				"llmJudgeEnabled":   true,
				"llmJudgeAttempted": false,
				"llmJudgeBudget":    budget,
				"llmRerankApplied":  rerankApplied,
			}, nil),
		}, nil
	}

	metadata := NewObject()
	metadata.SetString("feature", "crawl_frontier_judge")
	metadata.SetString("source", "crawl-frontier")
	metadata.SetString("runId", input.RunID)
	metadata.SetString("nodeId", input.NodeID)
	if input.ProfileID != nil {
		metadata.SetString("profileId", *input.ProfileID)
	}
	metadata.SetString("frontierRunId", input.RunID)
	metadata.SetString("frontierNodeId", input.NodeID)
	metadata.SetString("frontierParentPageType", input.ParentPageType)

	userPayload := buildJudgeUserPayload(input, candidatesForJudge)
	userJSON, err := userPayload.MarshalJSON()
	if err != nil {
		return JudgeResult{}, err
	}
	response, err := c.complete(ctx, completionRequest{
		OrgID:          input.OrgID,
		Model:          assist.JudgeModel,
		Temperature:    0.1,
		MaxTokens:      1600,
		ResponseFormat: judgeResponseFormat(),
		Metadata:       metadata,
		Messages: []chatMessage{
			{Role: "system", Content: judgeSystemPrompt},
			{Role: "user", Content: prettyJSON(userJSON)},
		},
	})
	if err != nil {
		c.recordCircuitFailure("judge")
		return JudgeResult{}, err
	}
	text := completionText(response.Choices)
	parsedRaw, ok := safeJSONParseFromText(text)
	if !ok {
		c.recordCircuitFailure("judge")
		return parseFailedJudgeResult(reranked, budget, rerankApplied), nil
	}
	parsed, ok := validateJudgeResponse(parsedRaw)
	if !ok {
		c.recordCircuitFailure("judge")
		return parseFailedJudgeResult(reranked, budget, rerankApplied), nil
	}
	c.recordCircuitSuccess("judge")

	minJudgeConfidence := clamp01(assist.MinJudgeConfidence, 0.72)
	decisions := map[string]judgeDecision{}
	for _, decision := range parsed.Decisions {
		decisions[decision.URL] = decision
	}
	dropped, retyped, judged := 0, 0, 0
	candidates := make([]Candidate, 0, len(reranked))
	for _, candidate := range reranked {
		decision, hasDecision := decisions[candidate.URL]
		if !hasDecision {
			metadata := candidate.metadataObject()
			method := "rule"
			if rerankApplied {
				method = "rerank"
			}
			metadata.SetString("judgeMethod", method)
			candidates = append(candidates, withCandidateMetadata(candidate, metadata))
			continue
		}
		judged++
		if decision.Action == "drop" && decision.Confidence >= minJudgeConfidence {
			dropped++
			continue
		}
		pageType := decision.PageType
		if pageType != candidate.PageType {
			retyped++
		}
		confidence := clamp01(decision.Confidence, 0.5)
		scoreBoost := -0.15
		switch decision.Action {
		case "fetch":
			if pageType == "article" {
				scoreBoost = 0.35
			} else {
				scoreBoost = 0.18
			}
		case "expand":
			if pageType == "article" {
				scoreBoost = 0.05
			} else {
				scoreBoost = 0.2
			}
		}
		metadata := candidate.metadataObject()
		metadata.SetString("judgeMethod", "llm")
		metadata.SetString("judgeAction", decision.Action)
		metadata.SetNumber("judgeConfidence", confidence)
		metadata.SetRaw("judgeReason", nullableRawString(decision.Reason))
		metadata.SetRaw("clusterLabel", nullableRawString(decision.ClusterLabel))
		metadata.Set("selectorHints", selectorHints(decision.SelectorHints))
		metadata.SetRaw("localeHint", nullableRawString(decision.LocaleHint))
		updated := withCandidateMetadata(candidate, metadata)
		updated.PageType = pageType
		updated.Score = roundToFixed(candidate.Score+scoreBoost*confidence, 4)
		candidates = append(candidates, updated)
	}

	diagnostics := NewObject()
	diagnostics.SetBool("llmJudgeEnabled", true)
	diagnostics.SetBool("llmJudgeAttempted", true)
	diagnostics.SetBool("llmJudgeParsed", true)
	diagnostics.SetNumber("llmJudgeBudget", float64(budget))
	diagnostics.SetNumber("llmJudgeJudged", float64(judged))
	diagnostics.SetNumber("llmJudgeDropped", float64(dropped))
	diagnostics.SetNumber("llmJudgeRetyped", float64(retyped))
	diagnostics.SetRaw("llmJudgeRationale", nullableRawString(parsed.Rationale))
	diagnostics.SetBool("llmRerankApplied", rerankApplied)
	decisionList := NewArray()
	for _, decision := range parsed.Decisions {
		item := NewObject()
		item.SetString("url", decision.URL)
		item.SetString("action", decision.Action)
		item.SetString("pageType", decision.PageType)
		item.SetNumber("confidence", clamp01(decision.Confidence, 0.5))
		item.SetRaw("reason", nullableRawString(decision.Reason))
		item.SetRaw("clusterLabel", nullableRawString(decision.ClusterLabel))
		item.SetRaw("localeHint", nullableRawString(decision.LocaleHint))
		item.Set("selectorHints", selectorHints(decision.SelectorHints))
		item.SetBool("appliedDrop", decision.Action == "drop" && decision.Confidence >= minJudgeConfidence)
		decisionList.Append(mustJSON(item))
	}
	diagnostics.SetRaw("llmJudgeDecisions", mustJSON(decisionList))
	diagnostics.Set("warningFlags", []string{})
	return JudgeResult{Candidates: candidates, Diagnostics: diagnostics}, nil
}

func parseFailedJudgeResult(reranked []Candidate, budget int, rerankApplied bool) JudgeResult {
	diagnostics := NewObject()
	diagnostics.SetBool("llmJudgeEnabled", true)
	diagnostics.SetBool("llmJudgeAttempted", true)
	diagnostics.SetBool("llmJudgeParsed", false)
	diagnostics.SetNumber("llmJudgeBudget", float64(budget))
	diagnostics.SetBool("llmRerankApplied", rerankApplied)
	diagnostics.Set("warningFlags", []string{"llm_judge_parse_failed"})
	return JudgeResult{Candidates: reranked, Diagnostics: diagnostics}
}

func diagnosticsObject(values map[string]any, warningFlags []string) *Object {
	object := NewObject()
	// The four early branches have a fixed key order; rebuild it explicitly so
	// map iteration cannot reorder the diagnostics.
	switch {
	case values["llmJudgeCircuitOpen"] == true:
		object.SetBool("llmJudgeEnabled", true)
		object.SetBool("llmJudgeAttempted", false)
		object.SetBool("llmJudgeCircuitOpen", true)
		object.Set("warningFlags", warningFlags)
		return object
	}
	enabled, _ := values["llmJudgeEnabled"].(bool)
	attempted, _ := values["llmJudgeAttempted"].(bool)
	object.SetBool("llmJudgeEnabled", enabled)
	object.SetBool("llmJudgeAttempted", attempted)
	if budget, ok := values["llmJudgeBudget"]; ok {
		object.Set("llmJudgeBudget", budget)
	}
	if applied, ok := values["llmRerankApplied"]; ok {
		object.Set("llmRerankApplied", applied)
	}
	if warningFlags == nil {
		object.Set("warningFlags", []string{})
	} else {
		object.Set("warningFlags", warningFlags)
	}
	return object
}

func buildJudgeUserPayload(input JudgeInput, candidates []Candidate) *Object {
	payload := NewObject()
	payload.SetString("seedUrl", input.SeedURL)
	payload.SetString("parentUrl", input.ParentURL)
	payload.SetString("parentPageType", input.ParentPageType)
	locale := ""
	if scope, ok := input.Config.Object("localeScope"); ok {
		if value, ok := scope.String("locale"); ok {
			locale = value
		}
	}
	payload.SetRaw("preferredLocale", nullableRawString(stringPointer(locale)))
	payload.Set("priorityKeywords", configStringList(input.Config, "priorityKeywords"))
	payload.Set("denyKeywords", configStringList(input.Config, "denyKeywords"))
	payload.SetRaw("urlPatterns", configObjectOrEmpty(input.Config, "urlPatterns"))
	payload.SetRaw("pageTypeSignals", configObjectOrEmpty(input.Config, "pageTypeSignals"))
	list := NewArray()
	for _, candidate := range candidates {
		metadata := candidate.metadataObject()
		item := NewObject()
		item.SetString("url", candidate.URL)
		item.SetString("pageType", candidate.PageType)
		item.SetNumber("score", candidate.Score)
		item.SetNumber("freshnessScore", candidate.FreshnessScore)
		linkText, _ := metadata.String("linkText")
		item.SetRaw("linkText", nullableRawString(stringPointer(linkText)))
		item.SetRaw("discoveryPath", metadataRawOrNull(metadata, "discoveryPath"))
		list.Append(mustJSON(item))
	}
	payload.SetRaw("candidates", mustJSON(list))
	return payload
}

func (c *LLMClient) rerankCandidates(ctx context.Context, input JudgeInput, assist *LlmAssist, candidates []Candidate, topN int) ([]Candidate, error) {
	documents := make([]string, 0, len(candidates))
	indexByURL := map[string]int{}
	for index, candidate := range candidates {
		metadata := candidate.metadataObject()
		linkText, _ := metadata.String("linkText")
		body := NewObject()
		body.SetString("url", candidate.URL)
		body.SetString("pageType", candidate.PageType)
		body.SetNumber("score", candidate.Score)
		body.SetNumber("freshnessScore", candidate.FreshnessScore)
		body.SetRaw("linkText", nullableRawString(stringPointer(linkText)))
		documents = append(documents, string(mustJSON(body)))
		indexByURL[candidate.URL] = index
	}
	query := buildJudgeQuery(input)
	limit := topN
	if limit > len(documents) {
		limit = len(documents)
	}
	metadata := NewObject()
	metadata.SetString("feature", "crawl_frontier_judge")
	metadata.SetString("source", "crawl-frontier")
	metadata.SetString("runId", input.RunID)
	metadata.SetString("nodeId", input.NodeID)
	if input.ProfileID != nil {
		metadata.SetString("profileId", *input.ProfileID)
	}
	metadata.SetString("mode", "rerank")
	results, err := c.rerank(ctx, input.OrgID, assist.JudgeModel, query, documents, limit, metadata)
	if err != nil {
		return nil, err
	}
	scoreByIndex := map[int]float64{}
	for _, result := range results {
		scoreByIndex[result.Index] = result.Score
	}
	out := make([]Candidate, len(candidates))
	copy(out, candidates)
	// Stable sort: rerank score desc, then the rule score desc.
	stableSortCandidates(out, func(left, right Candidate) (bool, bool) {
		leftScore := -1.0
		if index, ok := indexByURL[left.URL]; ok {
			if score, ok := scoreByIndex[index]; ok {
				leftScore = score
			}
		}
		rightScore := -1.0
		if index, ok := indexByURL[right.URL]; ok {
			if score, ok := scoreByIndex[index]; ok {
				rightScore = score
			}
		}
		if leftScore != rightScore {
			return leftScore > rightScore, true
		}
		if left.Score != right.Score {
			return left.Score > right.Score, true
		}
		return false, false
	})
	return out, nil
}

func stableSortCandidates(candidates []Candidate, less func(left, right Candidate) (bool, bool)) {
	// insertion sort keeps exact ties in their original order.
	for index := 1; index < len(candidates); index++ {
		current := candidates[index]
		position := index - 1
		for position >= 0 {
			before, decided := less(current, candidates[position])
			if !decided || !before {
				break
			}
			candidates[position+1] = candidates[position]
			position--
		}
		candidates[position+1] = current
	}
}

func buildJudgeQuery(input JudgeInput) string {
	parts := []string{input.SeedURL, input.ParentURL, input.ParentPageType}
	parts = append(parts, configStringList(input.Config, "priorityKeywords")...)
	parts = append(parts, configStringList(input.Config, "keywords")...)
	for _, pageType := range []string{"category", "list", "article"} {
		if signals, ok := input.Config.Object("pageTypeSignals"); ok {
			if record, ok := signals.Object(pageType); ok {
				keywords, _ := record.Strings("keywords")
				parts = append(parts, keywords...)
			}
		}
	}
	unique := uniqueStringList(parts)
	if len(unique) > 20 {
		unique = unique[:20]
	}
	return strings.Join(unique, " ")
}

func clamp01(value, fallback float64) float64 {
	if !isFinite(value) {
		value = fallback
	}
	return math.Max(0, math.Min(1, roundToFixed(value, 4)))
}

func withCandidateMetadata(candidate Candidate, metadata *Object) Candidate {
	encoded, err := metadata.MarshalJSON()
	if err != nil {
		return candidate
	}
	candidate.Metadata = encoded
	return candidate
}

func nullableRawString(value *string) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	return mustJSON(*value)
}

func metadataRawOrNull(metadata *Object, key string) json.RawMessage {
	if metadata == nil {
		return json.RawMessage("null")
	}
	raw, ok := metadata.Raw(key)
	if !ok {
		return json.RawMessage("null")
	}
	return raw
}

func selectorHints(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	out := value
	return &out
}

func configStringList(config *Object, key string) []string {
	if config == nil {
		return []string{}
	}
	values, ok := config.Strings(key)
	if !ok {
		return []string{}
	}
	return values
}

func configObjectOrEmpty(config *Object, key string) json.RawMessage {
	if config != nil {
		if object, ok := config.Object(key); ok {
			return mustJSON(object)
		}
	}
	return json.RawMessage("{}")
}

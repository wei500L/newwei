package crawlfrontierllm

import (
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// This file ports the crawl-frontier.utils.ts helpers the two workers call:
// resolveEffectiveLlmAssistConfig (:754), computeFrontierPageTypeBudgets
// (:1053), prioritizeFrontierCandidates (:1192), resolveNodeQueueClass (:1240),
// resolveFreshnessBucket (:1286) and classifyFrontierFailureKind (:1445).

// LlmPurpose selects the judge or learn gate.
const (
	LlmPurposeJudge = "judge"
	LlmPurposeLearn = "learn"
)

var defaultLlmAssistBudgets = map[string]float64{
	"home":     24,
	"category": 24,
	"list":     16,
	"article":  0,
}

var defaultLlmAutoPublish = map[string]float64{
	"minArticleLift":     0.15,
	"minNoiseReduction":  0.2,
	"minJudgeConfidence": 0.75,
}

// ResolveEffectiveLlmAssistConfig mirrors resolveEffectiveLlmAssistConfig.
func ResolveEffectiveLlmAssistConfig(config *Object, purpose string) *LlmAssist {
	var configured *Object
	if config != nil {
		configured, _ = config.Object("llmAssist")
	}
	if configured != nil {
		if enabled, ok := configured.Bool("enabled"); ok && !enabled {
			return nil
		}
	}
	if purpose == LlmPurposeLearn {
		if configured == nil {
			return nil
		}
		if enabled, ok := configured.Bool("enabled"); !ok || !enabled {
			return nil
		}
	}
	assist := &LlmAssist{Enabled: true, RecallMode: "high_recall", MinJudgeConfidence: 0.72, ShadowEvaluationRuns: 3}
	if configured != nil {
		if recall, ok := configured.String("recallMode"); ok {
			assist.RecallMode = recall
		}
		if model, ok := configured.String("judgeModel"); ok {
			assist.JudgeModel = &model
		}
		if model, ok := configured.String("siteLearnerModel"); ok {
			assist.SiteLearnerModel = &model
		}
		if budgets, ok := configured.Object("candidateBudgetByPageType"); ok {
			assist.CandidateBudgetByPageType = budgets
		}
		if confidence, ok := configured.Number("minJudgeConfidence"); ok {
			assist.MinJudgeConfidence = confidence
		}
		if runs, ok := configured.Number("shadowEvaluationRuns"); ok {
			assist.ShadowEvaluationRuns = int(runs)
		}
		if thresholds, ok := configured.Object("autoPublishThresholds"); ok {
			assist.AutoPublishThresholds = thresholds
		}
		if shadow, ok := configured.Object("shadow"); ok {
			assist.Shadow = shadow
		}
	}
	if assist.CandidateBudgetByPageType == nil {
		budgets := NewObject()
		for _, key := range []string{"home", "category", "list", "article"} {
			budgets.SetNumber(key, defaultLlmAssistBudgets[key])
		}
		assist.CandidateBudgetByPageType = budgets
	}
	if assist.AutoPublishThresholds == nil {
		thresholds := NewObject()
		for _, key := range []string{"minArticleLift", "minNoiseReduction", "minJudgeConfidence"} {
			thresholds.SetNumber(key, defaultLlmAutoPublish[key])
		}
		assist.AutoPublishThresholds = thresholds
	}
	return assist
}

// ResolveCandidateBudget mirrors resolveCandidateBudget: a configured budget is
// clamped to [0,64], list defaults to 16, article to 0 and everything else 24.
func ResolveCandidateBudget(assist *LlmAssist, pageType string) int {
	if assist != nil && assist.CandidateBudgetByPageType != nil {
		if configured, ok := assist.CandidateBudgetByPageType.Number(pageType); ok {
			value := roundToFixed(configured, 0)
			if value < 0 {
				value = 0
			}
			if value > 64 {
				value = 64
			}
			return int(value)
		}
	}
	switch pageType {
	case "list":
		return 16
	case "article":
		return 0
	}
	return 24
}

// ResolveRecallBudget mirrors resolveRecallBudget.
func ResolveRecallBudget(assist *LlmAssist, pageType string) int {
	mode := "high_recall"
	if assist != nil && assist.RecallMode != "" {
		mode = assist.RecallMode
	}
	switch mode {
	case "low_cost":
		if pageType == "list" {
			return 12
		}
		return 16
	case "balanced":
		if pageType == "list" {
			return 14
		}
		return 20
	}
	if pageType == "list" {
		return 18
	}
	return 28
}

// PageTypeBudgets is the computeFrontierPageTypeBudgets result.
type PageTypeBudgets struct {
	Home     int
	Category int
	List     int
	Article  int
}

// Get reads a page type budget.
func (b PageTypeBudgets) Get(pageType string) int {
	switch pageType {
	case "home":
		return b.Home
	case "category":
		return b.Category
	case "list":
		return b.List
	case "article":
		return b.Article
	}
	return 0
}

// Increment adds one to the page type budget.
func (b *PageTypeBudgets) Increment(pageType string) {
	switch pageType {
	case "home":
		b.Home++
	case "category":
		b.Category++
	case "list":
		b.List++
	case "article":
		b.Article++
	}
}

// ComputeFrontierPageTypeBudgets mirrors computeFrontierPageTypeBudgets.
func ComputeFrontierPageTypeBudgets(maxDepth, maxPages int) PageTypeBudgets {
	budgets := PageTypeBudgets{}
	if maxPages > 0 {
		budgets.Home = 1
	}
	active := make([]string, 0, 3)
	if maxDepth >= 1 {
		active = append(active, "category")
	}
	if maxDepth >= 2 {
		active = append(active, "list")
	}
	if maxDepth >= 3 {
		active = append(active, "article")
	}
	remaining := maxPages - budgets.Home
	if remaining < 0 {
		remaining = 0
	}
	for _, pageType := range active {
		if remaining == 0 {
			return budgets
		}
		budgets.Increment(pageType)
		remaining--
	}
	priority := make([]string, 0, 3)
	for _, pageType := range []string{"article", "category", "list"} {
		for _, candidate := range active {
			if candidate == pageType {
				priority = append(priority, pageType)
				break
			}
		}
	}
	cursor := 0
	for remaining > 0 && len(priority) > 0 {
		budgets.Increment(priority[cursor%len(priority)])
		remaining--
		cursor++
	}
	return budgets
}

var pageTypeDiscoveryPriority = map[string][]string{
	"home":     {"category", "list", "article", "home"},
	"category": {"list", "article", "category", "home"},
	"list":     {"article", "list", "category", "home"},
	"article":  {"article", "list", "category", "home"},
}

// PrioritizeCandidates mirrors prioritizeFrontierCandidates: page-type rank,
// then score desc, freshness desc, then url localeCompare. sort.SliceStable
// keeps the input order for exact ties.
func PrioritizeCandidates(parentPageType string, candidates []Candidate) []Candidate {
	priority, ok := pageTypeDiscoveryPriority[parentPageType]
	if !ok {
		priority = pageTypeDiscoveryPriority["article"]
	}
	rank := map[string]int{}
	for index, pageType := range priority {
		rank[pageType] = index
	}
	comparator := collate.New(language.Und)
	out := make([]Candidate, len(candidates))
	copy(out, candidates)
	sort.SliceStable(out, func(left, right int) bool {
		leftRank, ok := rank[out[left].PageType]
		if !ok {
			leftRank = len(priority)
		}
		rightRank, ok := rank[out[right].PageType]
		if !ok {
			rightRank = len(priority)
		}
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		if out[left].Score != out[right].Score {
			return out[left].Score > out[right].Score
		}
		if out[left].FreshnessScore != out[right].FreshnessScore {
			return out[left].FreshnessScore > out[right].FreshnessScore
		}
		return comparator.CompareString(out[left].URL, out[right].URL) < 0
	})
	return out
}

// ResolveNodeQueueClass mirrors resolveNodeQueueClass.
func ResolveNodeQueueClass(pageType string) string {
	switch pageType {
	case "home", "category", "list":
		return "hot"
	}
	return "normal"
}

// ResolveFreshnessBucket mirrors resolveFreshnessBucket.
func ResolveFreshnessBucket(score float64) string {
	switch {
	case score >= 0.99:
		return "24h"
	case score >= 0.74:
		return "7d"
	case score >= 0.39:
		return "30d"
	case score > 0:
		return "stale"
	}
	return "unknown"
}

// ClassifyFrontierFailureKind mirrors classifyFrontierFailureKind.
func ClassifyFrontierFailureKind(message *string) *string {
	if message == nil {
		return nil
	}
	normalized := strings.ToLower(jsTrim(*message))
	if normalized == "" {
		return nil
	}
	kinds := []struct {
		needles []string
		kind    string
	}{
		{[]string{"ssrf protection", "resolves to private ip", "blocked non-public dns answer"}, "ssrf_blocked"},
		{[]string{"datadome", "captcha", "cloudflare", "challenge", "protected", "access denied", "status code 401", "status code 403", "status code 429"}, "challenge_detected"},
		{[]string{"err_tunnel_connection_failed", "tunnel_connection_failed", "err_connection_closed", "connection_closed", "econnreset", "etimedout", "navigation timeout", "request timed out"}, "network_tunnel_error"},
	}
	for _, candidate := range kinds {
		for _, needle := range candidate.needles {
			if strings.Contains(normalized, needle) {
				kind := candidate.kind
				return &kind
			}
		}
	}
	return nil
}

// CollectNodeWarningFlags mirrors collectNodeWarningFlags.
func CollectNodeWarningFlags(metadata *Object, lastError *string) []string {
	var failureKind *string
	if metadata != nil {
		if value, ok := metadata.String("failureKind"); ok {
			failureKind = &value
		}
	}
	if failureKind == nil {
		failureKind = ClassifyFrontierFailureKind(lastError)
	}
	var parseFailed []string
	if metadata != nil {
		enabled, _ := metadata.Bool("llmJudgeEnabled")
		attempted, _ := metadata.Bool("llmJudgeAttempted")
		parsed, hasParsed := metadata.Bool("llmJudgeParsed")
		if enabled && attempted && hasParsed && !parsed {
			parseFailed = []string{"llm_judge_parse_failed"}
		}
	}
	var judgeFailed []string
	if metadata != nil {
		enabled, _ := metadata.Bool("llmJudgeEnabled")
		attempted, _ := metadata.Bool("llmJudgeAttempted")
		if _, hasError := metadata.String("llmJudgeError"); enabled && attempted && hasError {
			judgeFailed = []string{"llm_judge_failed"}
		}
	}
	var failureFlags []string
	if failureKind != nil {
		failureFlags = []string{*failureKind}
	}
	flags := uniqueStringList(
		metadataStrings(metadata, "warningFlags"),
		parseFailed,
		judgeFailed,
		failureFlags,
	)
	if flags == nil {
		return []string{}
	}
	return flags
}

// ResolvePendingLlmJudgeJobs mirrors resolvePendingLlmJudgeJobs.
func ResolvePendingLlmJudgeJobs(metadata *Object) int {
	if metadata == nil {
		return 0
	}
	count, ok := metadata.Number("pendingLlmJudgeJobs")
	if !ok {
		return 0
	}
	rounded := roundToFixed(count, 0)
	if rounded < 0 {
		return 0
	}
	return int(rounded)
}

func metadataStrings(metadata *Object, key string) []string {
	if metadata == nil {
		return nil
	}
	values, ok := metadata.Strings(key)
	if !ok {
		return nil
	}
	return values
}

// matchHostPattern mirrors matchHostPattern.
func matchHostPattern(pattern, host string) bool {
	normalizedPattern := strings.ToLower(jsTrim(pattern))
	normalizedHost := strings.ToLower(jsTrim(host))
	if normalizedPattern == "" || normalizedHost == "" {
		return false
	}
	if normalizedPattern == normalizedHost {
		return true
	}
	if strings.HasPrefix(normalizedPattern, "*.") {
		return strings.HasSuffix(normalizedHost, normalizedPattern[1:])
	}
	if strings.Contains(normalizedPattern, "*") {
		compiled, err := wildcardToRegex(normalizedPattern)
		if err != nil {
			return false
		}
		return compiled.MatchString(normalizedHost)
	}
	return normalizedHost == normalizedPattern
}

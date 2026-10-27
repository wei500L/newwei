package crawlfrontierllm

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
)

// llm_schema.go ports the two Zod response schemas, safeJsonParseFromText and
// the zodToJsonSchema response_format documents from
// crawl-frontier-llm.service.ts. The schemas are written as literals because
// the upstream gateway only consumes them; the validators implement the same
// constraints the Zod safeParse enforced.

const judgeResponseSchema = `{"type":"object","properties":{"decisions":{"type":"array","maxItems":48,"items":{"type":"object","properties":{"url":{"type":"string","format":"uri"},"action":{"type":"string","enum":["expand","fetch","drop"]},"pageType":{"type":"string","enum":["home","category","list","article"]},"confidence":{"type":"number","minimum":0,"maximum":1},"reason":{"type":["string","null"],"maxLength":280},"clusterLabel":{"type":["string","null"],"maxLength":120},"localeHint":{"type":["string","null"],"maxLength":32},"selectorHints":{"type":"array","maxItems":5,"items":{"type":"string","minLength":1,"maxLength":120}}},"required":["url","action","pageType","confidence"],"additionalProperties":false},"default":[]},"rationale":{"type":["string","null"],"maxLength":320}},"required":["decisions"],"additionalProperties":false}`

const learnResponseSchema = `{"type":"object","properties":{"confidence":{"type":"number","minimum":0,"maximum":1},"rationale":{"type":["string","null"],"maxLength":400},"profilePatch":{"type":"object","properties":{"seedDiscovery":{"type":"object","properties":{"strategy":{"type":"string","enum":["auto","seed_first","frontier_first","frontier_only"]},"mode":{"type":"string","enum":["robots","common_paths","sitemap_only","disabled"]},"freshnessWindowHours":{"type":"integer","minimum":1,"maximum":8760},"maxSeedUrls":{"type":"integer","minimum":1,"maximum":500},"topologyBudgetPages":{"type":"integer","minimum":1,"maximum":100},"topologyBudgetDepth":{"type":"integer","minimum":1,"maximum":8},"qualityThresholds":{"type":"object","properties":{"minCandidates":{"type":"integer","minimum":1,"maximum":200},"minArticleRatio":{"type":"number","minimum":0,"maximum":1},"maxNoiseRatio":{"type":"number","minimum":0,"maximum":1},"minFreshRatio":{"type":"number","minimum":0,"maximum":1}},"additionalProperties":false}},"additionalProperties":false},"urlPatterns":{"type":"object","properties":{"home":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"category":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"list":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"article":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"exclude":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}}},"additionalProperties":false},"pageTypeSignals":{"type":"object","properties":{"home":{"type":"object","properties":{"patterns":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"keywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}}},"additionalProperties":false},"category":{"type":"object","properties":{"patterns":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"keywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}}},"additionalProperties":false},"list":{"type":"object","properties":{"patterns":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"keywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}}},"additionalProperties":false},"article":{"type":"object","properties":{"patterns":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"keywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}}},"additionalProperties":false},"deny":{"type":"object","properties":{"patterns":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"keywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}}},"additionalProperties":false}},"additionalProperties":false},"localeScope":{"type":"object","properties":{"locale":{"type":"string","minLength":1,"maxLength":16},"acceptLanguages":{"type":"array","maxItems":8,"items":{"type":"string","minLength":1}},"denyUrlPatterns":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"denyHostPatterns":{"type":"array","maxItems":12,"items":{"type":"string","minLength":1}}},"additionalProperties":false},"domLinkScopes":{"type":"array","maxItems":16,"items":{"type":"string","minLength":1}},"domLinkExcludeSelectors":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"priorityKeywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"denyKeywords":{"type":"array","maxItems":24,"items":{"type":"string","minLength":1}},"sourceTier":{"type":"string","enum":["tier1","tier2","tier3"]}},"additionalProperties":false}},"required":["confidence"],"additionalProperties":false}`

// judgeResponseFormat is FRONTIER_JUDGE_RESPONSE_FORMAT.
func judgeResponseFormat() json.RawMessage {
	return json.RawMessage(`{"type":"json_schema","json_schema":{"name":"crawl_frontier_judge","schema":` + judgeResponseSchema + `}}`)
}

// learnResponseFormat is FRONTIER_LEARN_RESPONSE_FORMAT.
func learnResponseFormat() json.RawMessage {
	return json.RawMessage(`{"type":"json_schema","json_schema":{"name":"crawl_frontier_learn","schema":` + learnResponseSchema + `}}`)
}

// stripMarkdownCodeFence mirrors common/llm-json.ts.
func stripMarkdownCodeFence(text string) string {
	trimmed := jsTrim(text)
	if !strings.HasPrefix(trimmed, "```") {
		return trimmed
	}
	firstNewline := strings.Index(trimmed, "\n")
	if firstNewline == -1 {
		return trimmed
	}
	afterFence := trimmed[firstNewline+1:]
	closingFence := strings.LastIndex(afterFence, "```")
	if closingFence == -1 {
		return trimmed
	}
	return jsTrim(afterFence[:closingFence])
}

// extractFirstJSON mirrors extractFirstJson: markdown fence stripping, then a
// balanced-brace scan that honours JSON strings.
func extractFirstJSON(text string) (string, bool) {
	cleaned := stripMarkdownCodeFence(text)
	startObject := strings.Index(cleaned, "{")
	startArray := strings.Index(cleaned, "[")
	start := -1
	switch {
	case startObject == -1:
		start = startArray
	case startArray == -1:
		start = startObject
	default:
		start = startObject
		if startArray < startObject {
			start = startArray
		}
	}
	if start == -1 {
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
				return jsTrim(cleaned[start : index+1]), true
			}
		}
	}
	return "", false
}

// safeJSONParseFromText mirrors safeJsonParseFromText.
func safeJSONParseFromText(text string) (json.RawMessage, bool) {
	extracted, ok := extractFirstJSON(text)
	if !ok {
		return nil, false
	}
	if !json.Valid([]byte(extracted)) {
		return nil, false
	}
	return json.RawMessage(extracted), true
}

// completionText joins the non-empty choice contents with a newline, exactly
// like parseCompletionJson.
func completionText(choices []completionChoice) string {
	parts := make([]string, 0, len(choices))
	for _, choice := range choices {
		if choice.Message.Content == "" {
			continue
		}
		parts = append(parts, choice.Message.Content)
	}
	return jsTrim(strings.Join(parts, "\n"))
}

// judgeDecision is one validated FrontierJudgeDecision.
type judgeDecision struct {
	URL           string
	Action        string
	PageType      string
	Confidence    float64
	Reason        *string
	ClusterLabel  *string
	LocaleHint    *string
	SelectorHints []string
}

// judgeResponse is the validated FrontierJudgeResponse.
type judgeResponse struct {
	Decisions []judgeDecision
	Rationale *string
}

func validateJudgeResponse(raw json.RawMessage) (*judgeResponse, bool) {
	object, ok := ParseObject(raw)
	if !ok {
		return nil, false
	}
	out := &judgeResponse{Decisions: []judgeDecision{}}
	if decisionsRaw, present := object.Raw("decisions"); present && !isEmptyJSON(decisionsRaw) {
		var entries []json.RawMessage
		if err := json.Unmarshal(decisionsRaw, &entries); err != nil {
			return nil, false
		}
		if len(entries) > 48 {
			return nil, false
		}
		for _, entry := range entries {
			decision, ok := validateJudgeDecision(entry)
			if !ok {
				return nil, false
			}
			out.Decisions = append(out.Decisions, decision)
		}
	}
	if rationale, present := object.Raw("rationale"); present && !isEmptyJSON(rationale) {
		var text string
		if err := json.Unmarshal(rationale, &text); err != nil {
			return nil, false
		}
		if runeLen(text) > 320 {
			return nil, false
		}
		out.Rationale = &text
	}
	return out, true
}

// decodeSelectorHints mirrors
// z.array(z.string().min(1).max(120)).max(5).optional(): an EMPTY array is
// valid (the Zod array has no min length), a non-string or empty entry is not,
// and more than five entries invalidate the response. Rejecting the empty array
// used to discard the whole judge response - every decision in it - whenever the
// model spelled "no hints" as [] instead of omitting the key.
func decodeSelectorHints(raw json.RawMessage) ([]string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, false
	}
	if len(entries) > 5 {
		return nil, false
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err != nil {
			return nil, false
		}
		if text == "" || runeLen(text) > 120 {
			return nil, false
		}
		out = append(out, text)
	}
	return out, true
}

func validateJudgeDecision(raw json.RawMessage) (judgeDecision, bool) {
	object, ok := ParseObject(raw)
	if !ok {
		return judgeDecision{}, false
	}
	var decision judgeDecision
	decision.URL, ok = object.UntrimmedString("url")
	if !ok || !isValidURL(decision.URL) {
		return judgeDecision{}, false
	}
	decision.Action, ok = object.UntrimmedString("action")
	if !ok || !oneOf(decision.Action, "expand", "fetch", "drop") {
		return judgeDecision{}, false
	}
	decision.PageType, ok = object.UntrimmedString("pageType")
	if !ok || !oneOf(decision.PageType, "home", "category", "list", "article") {
		return judgeDecision{}, false
	}
	decision.Confidence, ok = object.Number("confidence")
	if !ok || decision.Confidence < 0 || decision.Confidence > 1 {
		return judgeDecision{}, false
	}
	if reason, ok := optionalString(object, "reason", 280); ok {
		decision.Reason = reason
	} else if object.Has("reason") {
		return judgeDecision{}, false
	}
	if cluster, ok := optionalString(object, "clusterLabel", 120); ok {
		decision.ClusterLabel = cluster
	} else if object.Has("clusterLabel") {
		return judgeDecision{}, false
	}
	if locale, ok := optionalString(object, "localeHint", 32); ok {
		decision.LocaleHint = locale
	} else if object.Has("localeHint") {
		return judgeDecision{}, false
	}
	if hintsRaw, present := object.Raw("selectorHints"); present && !isEmptyJSON(hintsRaw) {
		hints, ok := decodeSelectorHints(hintsRaw)
		if !ok {
			return judgeDecision{}, false
		}
		decision.SelectorHints = hints
	}
	return decision, true
}

// learningSuggestion is FrontierProfileLearningSuggestion.
type learningSuggestion struct {
	Confidence   float64
	Rationale    *string
	ProfilePatch *Object
}

func validateLearnResponse(raw json.RawMessage) (*learningSuggestion, bool) {
	object, ok := ParseObject(raw)
	if !ok {
		return nil, false
	}
	confidence, ok := object.Number("confidence")
	if !ok || confidence < 0 || confidence > 1 {
		return nil, false
	}
	out := &learningSuggestion{Confidence: confidence}
	if rationale, ok := optionalString(object, "rationale", 400); ok {
		out.Rationale = rationale
	} else if object.Has("rationale") {
		return nil, false
	}
	if patchRaw, present := object.Raw("profilePatch"); present && !isEmptyJSON(patchRaw) {
		patch, ok := ParseObject(patchRaw)
		if !ok {
			return nil, false
		}
		sanitized, ok := sanitizeProfilePatch(patch)
		if !ok {
			return nil, false
		}
		out.ProfilePatch = sanitized
	}
	return out, true
}

// sanitizeProfilePatch implements the Zod strip/validate semantics of
// FrontierProfilePatchSchema: unknown keys are dropped and a known key with a
// wrong type or out-of-range value invalidates the whole response.
func sanitizeProfilePatch(patch *Object) (*Object, bool) {
	out := NewObject()
	if seedRaw, present := patch.Raw("seedDiscovery"); present && !isEmptyJSON(seedRaw) {
		seed, ok := ParseObject(seedRaw)
		if !ok {
			return nil, false
		}
		cleanSeed := NewObject()
		if value, present := seed.Raw("strategy"); present && !isEmptyJSON(value) {
			text, ok := jsonStringValue(value)
			if !ok || !oneOf(text, "auto", "seed_first", "frontier_first", "frontier_only") {
				return nil, false
			}
			cleanSeed.SetString("strategy", text)
		}
		if value, present := seed.Raw("mode"); present && !isEmptyJSON(value) {
			text, ok := jsonStringValue(value)
			if !ok || !oneOf(text, "robots", "common_paths", "sitemap_only", "disabled") {
				return nil, false
			}
			cleanSeed.SetString("mode", text)
		}
		// Declaration order, not a map: the sanitized patch is serialised into
		// the profile config, so its key order has to be deterministic and match
		// the Zod schema's field order.
		intFields := []struct {
			key string
			min float64
			max float64
		}{
			{"freshnessWindowHours", 1, 8760},
			{"maxSeedUrls", 1, 500},
			{"topologyBudgetPages", 1, 100},
			{"topologyBudgetDepth", 1, 8},
		}
		for _, field := range intFields {
			value, present := seed.Raw(field.key)
			if !present || isEmptyJSON(value) {
				continue
			}
			number, ok := toFiniteNumber(value)
			if !ok || number != roundToFixed(number, 0) || number < field.min || number > field.max {
				return nil, false
			}
			cleanSeed.SetNumber(field.key, number)
		}
		if value, present := seed.Raw("qualityThresholds"); present && !isEmptyJSON(value) {
			thresholds, ok := ParseObject(value)
			if !ok {
				return nil, false
			}
			cleanThresholds := NewObject()
			if min, present := thresholds.Raw("minCandidates"); present && !isEmptyJSON(min) {
				number, ok := toFiniteNumber(min)
				if !ok || number != roundToFixed(number, 0) || number < 1 || number > 200 {
					return nil, false
				}
				cleanThresholds.SetNumber("minCandidates", number)
			}
			for _, key := range []string{"minArticleRatio", "maxNoiseRatio", "minFreshRatio"} {
				if value, present := thresholds.Raw(key); present && !isEmptyJSON(value) {
					number, ok := toFiniteNumber(value)
					if !ok || number < 0 || number > 1 {
						return nil, false
					}
					cleanThresholds.SetNumber(key, number)
				}
			}
			cleanSeed.SetRaw("qualityThresholds", mustJSON(cleanThresholds))
		}
		out.SetRaw("seedDiscovery", mustJSON(cleanSeed))
	}
	if rawPatterns, present := patch.Raw("urlPatterns"); present && !isEmptyJSON(rawPatterns) {
		patterns, ok := ParseObject(rawPatterns)
		if !ok {
			return nil, false
		}
		clean := NewObject()
		for _, key := range []string{"home", "category", "list", "article", "exclude"} {
			if value, present := patterns.Raw(key); present && !isEmptyJSON(value) {
				list, ok := decodeStringArray(value)
				if !ok || len(list) > 24 {
					return nil, false
				}
				clean.Set(key, list)
			}
		}
		out.SetRaw("urlPatterns", mustJSON(clean))
	}
	if rawSignals, present := patch.Raw("pageTypeSignals"); present && !isEmptyJSON(rawSignals) {
		signals, ok := ParseObject(rawSignals)
		if !ok {
			return nil, false
		}
		clean := NewObject()
		for _, key := range []string{"home", "category", "list", "article", "deny"} {
			value, present := signals.Raw(key)
			if !present || isEmptyJSON(value) {
				continue
			}
			record, ok := ParseObject(value)
			if !ok {
				return nil, false
			}
			cleanRecord := NewObject()
			for _, field := range []string{"patterns", "keywords"} {
				if fieldRaw, present := record.Raw(field); present && !isEmptyJSON(fieldRaw) {
					list, ok := decodeStringArray(fieldRaw)
					if !ok || len(list) > 24 {
						return nil, false
					}
					cleanRecord.Set(field, list)
				}
			}
			clean.SetRaw(key, mustJSON(cleanRecord))
		}
		out.SetRaw("pageTypeSignals", mustJSON(clean))
	}
	if rawLocale, present := patch.Raw("localeScope"); present && !isEmptyJSON(rawLocale) {
		locale, ok := ParseObject(rawLocale)
		if !ok {
			return nil, false
		}
		clean := NewObject()
		if value, present := locale.Raw("locale"); present && !isEmptyJSON(value) {
			text, ok := jsonStringValue(value)
			if !ok || runeLen(text) < 1 || runeLen(text) > 16 {
				return nil, false
			}
			clean.SetString("locale", text)
		}
		// Declaration order, not a map, for the same reason as the seed integers
		// above.
		localeLists := []struct {
			key   string
			limit int
		}{
			{"acceptLanguages", 8},
			{"denyUrlPatterns", 24},
			{"denyHostPatterns", 12},
		}
		for _, field := range localeLists {
			value, present := locale.Raw(field.key)
			if !present || isEmptyJSON(value) {
				continue
			}
			list, ok := decodeStringArray(value)
			if !ok || len(list) > field.limit {
				return nil, false
			}
			clean.Set(field.key, list)
		}
		out.SetRaw("localeScope", mustJSON(clean))
	}
	patchLists := []struct {
		key   string
		limit int
	}{
		{"domLinkScopes", 16},
		{"domLinkExcludeSelectors", 24},
		{"priorityKeywords", 24},
		{"denyKeywords", 24},
	}
	for _, field := range patchLists {
		value, present := patch.Raw(field.key)
		if !present || isEmptyJSON(value) {
			continue
		}
		list, ok := decodeStringArray(value)
		if !ok || len(list) > field.limit {
			return nil, false
		}
		out.Set(field.key, list)
	}
	if value, present := patch.Raw("sourceTier"); present && !isEmptyJSON(value) {
		text, ok := jsonStringValue(value)
		if !ok || !oneOf(text, "tier1", "tier2", "tier3") {
			return nil, false
		}
		out.SetString("sourceTier", text)
	}
	return out, true
}

func optionalString(object *Object, key string, maxLength int) (*string, bool) {
	raw, present := object.Raw(key)
	if !present || isEmptyJSON(raw) {
		return nil, true
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	if runeLen(value) > maxLength {
		return nil, false
	}
	return &value, true
}

func jsonStringValue(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func isValidURL(value string) bool {
	parsed, err := url.Parse(jsTrim(value))
	if err != nil {
		return false
	}
	return parsed.Scheme != "" && parsed.Host != ""
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

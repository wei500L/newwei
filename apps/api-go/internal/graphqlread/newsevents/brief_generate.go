package newsevents

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// briefEvent carries the event facts the prompt needs. Title already applies
// Nest's nullish fallback title ?? primaryEntity ?? primaryTopic ?? id.
type briefEvent struct {
	Title    string
	Summary  *string
	StartAt  time.Time
	LastAt   time.Time
	Language *string
}

func briefEventTitle(row *eventRow) string {
	if row == nil {
		return ""
	}
	title := row.ID
	if row.PrimaryTopic != nil {
		title = *row.PrimaryTopic
	}
	if row.PrimaryEntity != nil {
		title = *row.PrimaryEntity
	}
	if row.Title != nil {
		title = *row.Title
	}
	return title
}

// generateBrief performs the synchronous model call and validates the
// structured output against the Nest payload schema. A network failure, empty
// content, invalid JSON and a structurally invalid payload all surface as an
// error, never as a legal null.
func (s *service) generateBrief(ctx context.Context, orgID string, row *eventRow, sources []briefSource, language string) (briefPayload, error) {
	if s == nil || s.brief == nil {
		return briefPayload{}, errors.New("news event brief completer is not configured")
	}
	event := briefEvent{
		Title:    briefEventTitle(row),
		Summary:  row.Summary,
		StartAt:  row.StartAt,
		LastAt:   row.LastAt,
		Language: row.Language,
	}
	result, err := s.brief.CompleteBrief(ctx, publicportal.BriefCompletionRequest{
		OrgID:  orgID,
		System: briefSystemPrompt(language),
		User:   briefUserPrompt(event, sources),
		Metadata: publicportal.BriefCompletionMetadata{
			Feature:    "news_event_brief",
			EventTitle: event.Title,
			Sources:    len(sources),
		},
		Observer: s.briefObserver,
	})
	if err != nil {
		return briefPayload{}, err
	}
	if strings.TrimSpace(result.Content) == "" {
		return briefPayload{}, errors.New("model gateway returned empty content for the news event brief")
	}
	raw, ok := extractBriefJSON(result.Content)
	if !ok {
		log.Printf("api-go: news event brief JSON parse failed, preview=%q", truncateUTF16(result.Content, 280))
		return briefPayload{}, errors.New("model gateway returned invalid JSON for the news event brief")
	}
	payload, ok := validateBriefPayload(raw)
	if !ok {
		return briefPayload{}, errors.New("model gateway returned a structurally invalid news event brief")
	}
	return payload, nil
}

// extractBriefJSON mirrors Nest safeJsonParseFromText: strip a markdown code
// fence, then scan the first balanced JSON object or array.
func extractBriefJSON(content string) (json.RawMessage, bool) {
	cleaned := stripMarkdownCodeFence(content)
	startObject := strings.Index(cleaned, "{")
	startArray := strings.Index(cleaned, "[")
	start := -1
	switch {
	case startObject == -1 && startArray == -1:
		return nil, false
	case startObject == -1:
		start = startArray
	case startArray == -1:
		start = startObject
	case startObject < startArray:
		start = startObject
	default:
		start = startArray
	}
	stack := make([]byte, 0, 8)
	inString := false
	escaped := false
	for index := start; index < len(cleaned); index++ {
		char := cleaned[index]
		if inString {
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
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
			if len(stack) == 0 || stack[len(stack)-1] != char {
				return nil, false
			}
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				candidate := strings.TrimSpace(cleaned[start : index+1])
				if !json.Valid([]byte(candidate)) {
					return nil, false
				}
				return json.RawMessage(candidate), true
			}
		}
	}
	return nil, false
}

func stripMarkdownCodeFence(text string) string {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "```") {
		return trimmed
	}
	newline := strings.Index(trimmed, "\n")
	if newline < 0 {
		return trimmed
	}
	afterFence := trimmed[newline+1:]
	closing := strings.LastIndex(afterFence, "```")
	if closing < 0 {
		return trimmed
	}
	return strings.TrimSpace(afterFence[:closing])
}

// validateBriefPayload mirrors NewsEventBriefPayloadSchema. The caller must
// pass a JSON object; unknown keys are ignored, exactly like zod's default
// stripping. key_points present must hold 1..10 points, while an absent
// key_points falls back to the schema default of [].
func validateBriefPayload(raw json.RawMessage) (briefPayload, bool) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return briefPayload{}, false
	}
	summary, ok := requiredBriefText(root, "detailed_summary")
	if !ok {
		return briefPayload{}, false
	}
	tldr, ok := requiredBriefText(root, "tldr")
	if !ok {
		return briefPayload{}, false
	}
	keyPoints, ok := parsePointArray(root, "key_points", 1, 10)
	if !ok {
		return briefPayload{}, false
	}
	whyItMatters, ok := parsePointArray(root, "why_it_matters", 0, 10)
	if !ok {
		return briefPayload{}, false
	}
	whatToWatch, ok := parsePointArray(root, "what_to_watch", 0, 12)
	if !ok {
		return briefPayload{}, false
	}
	payload := briefPayload{
		DetailedSummary: summary,
		Tldr:            tldr,
		KeyPoints:       keyPoints,
		WhyItMatters:    whyItMatters,
		WhatToWatch:     whatToWatch,
	}
	if latestRaw, present := root["latest_update"]; present && !rawIsNull(latestRaw) {
		point, pointOK := parsePoint(latestRaw)
		if !pointOK {
			return briefPayload{}, false
		}
		payload.LatestUpdate = &point
	}
	if comparisonRaw, present := root["comparison"]; present && !rawIsNull(comparisonRaw) {
		var fields map[string]json.RawMessage
		if json.Unmarshal(comparisonRaw, &fields) != nil {
			return briefPayload{}, false
		}
		consensus, consensusOK := parsePointArray(fields, "consensus", 0, 12)
		if !consensusOK {
			return briefPayload{}, false
		}
		divergence, divergenceOK := parsePointArray(fields, "divergence", 0, 12)
		if !divergenceOK {
			return briefPayload{}, false
		}
		payload.Comparison = &briefComparison{Consensus: consensus, Divergence: divergence}
	}
	if limitationsRaw, present := root["limitations"]; present && !rawIsNull(limitationsRaw) {
		var limitations string
		if json.Unmarshal(limitationsRaw, &limitations) != nil {
			return briefPayload{}, false
		}
		payload.Limitations = &limitations
	}
	return payload, true
}

func requiredBriefText(root map[string]json.RawMessage, key string) (string, bool) {
	raw, present := root[key]
	if !present || rawIsNull(raw) {
		return "", false
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	if text == "" {
		return "", false
	}
	return text, true
}

// parsePointArray returns an absent key as a nil slice; minItems applies only
// when the key is present, which matches zod default([]) short-circuiting the
// array bounds for undefined input.
func parsePointArray(fields map[string]json.RawMessage, key string, minItems, maxItems int) ([]briefPoint, bool) {
	raw, present := fields[key]
	if !present {
		return nil, true
	}
	if rawIsNull(raw) {
		return nil, false
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	if len(items) < minItems || len(items) > maxItems {
		return nil, false
	}
	out := make([]briefPoint, 0, len(items))
	for _, item := range items {
		point, ok := parsePoint(item)
		if !ok {
			return nil, false
		}
		out = append(out, point)
	}
	return out, true
}

func parsePoint(raw json.RawMessage) (briefPoint, bool) {
	if rawIsNull(raw) {
		return briefPoint{}, false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return briefPoint{}, false
	}
	textRaw, present := fields["text"]
	if !present || rawIsNull(textRaw) {
		return briefPoint{}, false
	}
	var text string
	if json.Unmarshal(textRaw, &text) != nil || text == "" {
		return briefPoint{}, false
	}
	citations := []int{}
	if citationsRaw, present := fields["citations"]; present {
		if rawIsNull(citationsRaw) {
			return briefPoint{}, false
		}
		var entries []json.RawMessage
		if json.Unmarshal(citationsRaw, &entries) != nil || len(entries) > 12 {
			return briefPoint{}, false
		}
		for _, entry := range entries {
			var number float64
			if json.Unmarshal(entry, &number) != nil {
				return briefPoint{}, false
			}
			// zod accepts any integer >= 1 here; the value is only bounded
			// later by the 1..maxSources sanitize pass. An index beyond int
			// range is always outside that window, so it is kept as a
			// sentinel instead of crashing the conversion.
			if number != math.Trunc(number) || number < 1 {
				return briefPoint{}, false
			}
			if number > math.MaxInt32 {
				citations = append(citations, math.MaxInt32)
				continue
			}
			citations = append(citations, int(number))
		}
	}
	return briefPoint{Text: text, Citations: citations}, true
}

func rawIsNull(raw json.RawMessage) bool {
	return len(raw) == 0 || strings.TrimSpace(string(raw)) == "null"
}

// briefSystemPrompt mirrors NewsEventBriefService.buildSystemPrompt.
func briefSystemPrompt(language string) string {
	hint := "Write all free-text fields in " + language + "."
	if language == "zh" {
		hint = "Write all free-text fields in Simplified Chinese."
	}
	return strings.Join([]string{
		"You are an editor producing a one-page brief for a general audience.",
		"Use ONLY the provided sources. Do NOT invent facts.",
		"Be concise, concrete, and avoid fluff. Prefer numbers, dates, and named entities when present.",
		"Every point MUST include citations: a non-empty list of 1-based source indexes that support the point.",
		"If sources disagree, capture it under comparison.divergence with citations for each side.",
		"If information is uncertain or missing, state uncertainty explicitly.",
		hint,
	}, " ")
}

// briefUserPrompt mirrors NewsEventBriefService.buildUserPrompt.
func briefUserPrompt(event briefEvent, sources []briefSource) string {
	eventSummary := ""
	if event.Summary != nil && *event.Summary != "" {
		eventSummary = truncateUTF16(*event.Summary, 600)
	}
	blocks := make([]string, 0, len(sources))
	for _, source := range sources {
		when := "unknown"
		if source.PublishedAt != nil {
			when = source.PublishedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		label := "Unknown source"
		if source.SourceLabel != nil && strings.TrimSpace(*source.SourceLabel) != "" {
			label = *source.SourceLabel
		}
		title := ""
		if source.Title != nil {
			title = *source.Title
		}
		bits := []string{
			"[" + itoa(source.Index) + "] " + label,
			"time: " + when,
			"title: " + title,
			"url: " + source.URL,
		}
		if source.Summary != nil && *source.Summary != "" {
			bits = append(bits, "summary: "+truncateUTF16(*source.Summary, 700))
		}
		if len(source.KeyPoints) > 0 {
			points := source.KeyPoints
			if len(points) > 8 {
				points = points[:8]
			}
			bits = append(bits, "key_points: "+truncateUTF16(strings.Join(points, " | "), 900))
		}
		blocks = append(blocks, strings.Join(bits, "\n"))
	}
	lines := []string{
		"Event:",
		"title: " + event.Title,
		"startAt: " + event.StartAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		"lastAt: " + event.LastAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if event.Language != nil && *event.Language != "" {
		lines = append(lines, "sourceLanguage: "+*event.Language)
	}
	if eventSummary != "" {
		lines = append(lines, "eventSummary: "+eventSummary)
	}
	lines = append(lines,
		"",
		"Sources (use only these):",
		strings.Join(blocks, "\n\n"),
		"",
		"Output requirements:",
		"- Citation indexes must be within 1.."+itoa(len(sources))+". Do not output points without at least one valid citation.",
		"- detailed_summary: 4-8 paragraphs, narrative style, explain chronology, current status, disagreements, and near-term watchpoints.",
		"- tldr: 1-2 sentences summarizing what happened and the latest state.",
		"- key_points: 4-8 bullets covering core facts and chronology (each with citations).",
		"- why_it_matters: 2-5 bullets about impact (each with citations).",
		"- latest_update: one bullet describing what's newest/changed, or null if none (with citations).",
		"- what_to_watch: 3-6 bullets about what to monitor next (each with citations).",
		"- comparison.consensus: 2-5 bullets that multiple sources agree on (citations should include multiple indexes).",
		"- comparison.divergence: 0-5 bullets highlighting differences/unique claims (with citations).",
		"- limitations: optional, one sentence about data gaps.",
	)
	return strings.Join(lines, "\n")
}

// truncateUTF16 mirrors the Nest truncate helper: JavaScript string length and
// slice are UTF-16 based, and the ellipsis replaces the last kept unit.
func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	cut := limit - 1
	if cut < 0 {
		cut = 0
	}
	if cut > len(units) {
		cut = len(units)
	}
	return strings.TrimRightFunc(string(utf16.Decode(units[:cut])), unicode.IsSpace) + "…"
}

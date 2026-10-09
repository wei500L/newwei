package publicportal

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	briefVersion    = 1
	briefMaxSources = 10
	briefItemLimit  = 200
	fallbackItems   = 24
)

type briefSource struct {
	Index              int
	URL                string
	SourceLabel        string
	Title              string
	Summary            string
	KeyPoints          []string
	PublishedAt        *time.Time
	ProcessedItemID    string
	ProcessedArticleID string
}

type briefView struct {
	GeneratedAt string            `json:"generatedAt"`
	Language    string            `json:"language"`
	Payload     map[string]any    `json:"payload"`
	Sources     []briefSourceView `json:"sources"`
}

type briefSourceView struct {
	Index       int     `json:"index"`
	URL         string  `json:"url"`
	SourceLabel *string `json:"sourceLabel"`
	Title       *string `json:"title"`
	PublishedAt *string `json:"publishedAt"`
}

type fingerprintBody struct {
	Version  int                 `json:"version"`
	Language string              `json:"language"`
	LastAt   string              `json:"lastAt"`
	Sources  []fingerprintSource `json:"sources"`
}

type fingerprintSource struct {
	ProcessedArticleID *string `json:"processedArticleId"`
	ProcessedItemID    *string `json:"processedItemId"`
	URL                string  `json:"url"`
}

func selectBriefSources(items []BriefItem, maxSources int) []briefSource {
	type candidate struct {
		briefSource
		stamp time.Time
	}
	candidates := make([]candidate, 0, len(items))
	for _, item := range items {
		url := strings.TrimSpace(item.URL)
		if url == "" {
			continue
		}
		label := strings.TrimSpace(item.SourceLabel)
		if label == "" {
			label = strings.TrimSpace(item.Source)
		}
		var published *time.Time
		stamp := time.Unix(0, 0).UTC()
		if item.HasPublishedAt {
			value := item.PublishedAt.UTC()
			published = &value
			stamp = value
		} else if item.HasCrawlAt {
			stamp = item.CrawlAt.UTC()
		} else if !item.ProcessedAt.IsZero() {
			stamp = item.ProcessedAt.UTC()
		}
		candidates = append(candidates, candidate{
			briefSource: briefSource{
				URL:                url,
				SourceLabel:        label,
				Title:              strings.TrimSpace(item.Title),
				Summary:            strings.TrimSpace(item.Summary),
				KeyPoints:          uniqueNonEmpty(item.KeyPoints),
				PublishedAt:        published,
				ProcessedItemID:    strings.TrimSpace(item.ProcessedItemID),
				ProcessedArticleID: strings.TrimSpace(item.ProcessedArticleID),
			},
			stamp: stamp,
		})
	}
	for i := 1; i < len(candidates); i++ {
		current := candidates[i]
		j := i
		for j > 0 && candidates[j-1].stamp.Before(current.stamp) {
			candidates[j] = candidates[j-1]
			j--
		}
		candidates[j] = current
	}
	deduped := make([]candidate, 0, len(candidates))
	seenURL := map[string]struct{}{}
	for _, entry := range candidates {
		if _, ok := seenURL[entry.URL]; ok {
			continue
		}
		seenURL[entry.URL] = struct{}{}
		deduped = append(deduped, entry)
	}
	picked := make([]candidate, 0, maxSources)
	usedKeys := map[string]struct{}{}
	for _, entry := range deduped {
		if len(picked) >= maxSources {
			break
		}
		key := sourceKey(entry.SourceLabel, entry.URL)
		if _, ok := usedKeys[key]; ok {
			continue
		}
		usedKeys[key] = struct{}{}
		picked = append(picked, entry)
	}
	if len(picked) < maxSources {
		chosen := map[string]struct{}{}
		for _, entry := range picked {
			chosen[entry.URL] = struct{}{}
		}
		for _, entry := range deduped {
			if len(picked) >= maxSources {
				break
			}
			if _, ok := chosen[entry.URL]; ok {
				continue
			}
			picked = append(picked, entry)
		}
	}
	out := make([]briefSource, 0, len(picked))
	for i, entry := range picked {
		source := entry.briefSource
		if len(source.KeyPoints) > 20 {
			source.KeyPoints = source.KeyPoints[:20]
		}
		source.Index = i + 1
		out = append(out, source)
	}
	return out
}

func sourceKey(label, rawURL string) string {
	trimmed := strings.ToLower(strings.TrimSpace(label))
	if trimmed != "" {
		return trimmed
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Hostname() == "" {
		return rawURL
	}
	return strings.ToLower(parsed.Hostname())
}

func briefFingerprint(language, lastAt string, sources []briefSource) string {
	body := fingerprintBody{
		Version:  briefVersion,
		Language: language,
		LastAt:   lastAt,
		Sources:  make([]fingerprintSource, 0, len(sources)),
	}
	for _, source := range sources {
		body.Sources = append(body.Sources, fingerprintSource{
			ProcessedArticleID: nullableString(source.ProcessedArticleID),
			ProcessedItemID:    nullableString(source.ProcessedItemID),
			URL:                source.URL,
		})
	}
	encoded, err := marshalJSON(body)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// marshalJSON 对齐 Nest JSON.stringify：不把 &、<、> 写成 \uXXXX。
// encoding/json 默认会转义它们，查询串里的 & 会让指纹和已缓存 brief 对不上。
func marshalJSON(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func nullableString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func normalizeBriefLanguage(value string) string {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return "zh"
	}
	lower := strings.ToLower(normalized)
	if strings.HasPrefix(lower, "zh") {
		return "zh"
	}
	if strings.HasPrefix(lower, "en") {
		return "en"
	}
	if utf8.RuneCountInString(lower) <= 8 {
		return lower
	}
	return "zh"
}

func readCachedBrief(metadata []byte, language, fingerprint string, now time.Time) *briefView {
	var doc map[string]any
	if err := json.Unmarshal(metadata, &doc); err != nil {
		return nil
	}
	raw, ok := doc["briefV1"].(map[string]any)
	if !ok || jsonInt(raw["version"], 0) != briefVersion {
		return nil
	}
	cachedLanguage, _ := raw["language"].(string)
	cachedFingerprint, _ := raw["fingerprint"].(string)
	generatedRaw, _ := raw["generatedAt"].(string)
	if strings.TrimSpace(cachedLanguage) == "" || strings.TrimSpace(cachedFingerprint) == "" || strings.TrimSpace(generatedRaw) == "" {
		return nil
	}
	if cachedLanguage != language || cachedFingerprint != fingerprint {
		return nil
	}
	payload, ok := raw["payload"].(map[string]any)
	if !ok {
		return nil
	}
	sources := cachedSources(raw["sources"])
	if sources == nil {
		return nil
	}
	sanitized, ok := sanitizeBriefPayload(payload, len(sources))
	if !ok {
		return nil
	}
	generatedAt := now.UTC()
	if parsed, err := time.Parse(time.RFC3339Nano, generatedRaw); err == nil {
		generatedAt = parsed.UTC()
	}
	return &briefView{
		GeneratedAt: isoTime(generatedAt),
		Language:    language,
		Payload:     sanitized,
		Sources:     sourceViews(sources),
	}
}

type cachedSource struct {
	Index              int
	URL                string
	SourceLabel        string
	Title              string
	PublishedAt        *time.Time
	ProcessedItemID    string
	ProcessedArticleID string
}

func cachedSources(value any) []cachedSource {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]cachedSource, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		index := jsonInt(record["index"], 0)
		url, _ := record["url"].(string)
		url = strings.TrimSpace(url)
		if index < 1 || url == "" {
			continue
		}
		source := cachedSource{Index: index, URL: url}
		if label, ok := record["sourceLabel"].(string); ok {
			source.SourceLabel = strings.TrimSpace(label)
		}
		if title, ok := record["title"].(string); ok {
			source.Title = strings.TrimSpace(title)
		}
		if when, ok := record["publishedAt"].(string); ok && strings.TrimSpace(when) != "" {
			if parsed, err := time.Parse(time.RFC3339Nano, when); err == nil {
				value := parsed.UTC()
				source.PublishedAt = &value
			}
		}
		if id, ok := record["processedItemId"].(string); ok {
			source.ProcessedItemID = strings.TrimSpace(id)
		}
		if id, ok := record["processedArticleId"].(string); ok {
			source.ProcessedArticleID = strings.TrimSpace(id)
		}
		out = append(out, source)
	}
	return out
}

func sourceViews(sources []cachedSource) []briefSourceView {
	out := make([]briefSourceView, 0, len(sources))
	for _, source := range sources {
		view := briefSourceView{
			Index:       source.Index,
			URL:         source.URL,
			SourceLabel: optionalString(source.SourceLabel),
			Title:       optionalString(source.Title),
		}
		if source.PublishedAt != nil {
			text := isoTime(*source.PublishedAt)
			view.PublishedAt = &text
		}
		out = append(out, view)
	}
	return out
}

func viewsFromSources(sources []briefSource) []briefSourceView {
	cached := make([]cachedSource, 0, len(sources))
	for _, source := range sources {
		cached = append(cached, cachedSource{
			Index:              source.Index,
			URL:                source.URL,
			SourceLabel:        source.SourceLabel,
			Title:              source.Title,
			PublishedAt:        source.PublishedAt,
			ProcessedItemID:    source.ProcessedItemID,
			ProcessedArticleID: source.ProcessedArticleID,
		})
	}
	return sourceViews(cached)
}

func mergeBriefMetadata(current []byte, brief map[string]any) ([]byte, error) {
	base := map[string]any{}
	if len(current) > 0 {
		var decoded any
		if err := json.Unmarshal(current, &decoded); err == nil {
			if record, ok := decoded.(map[string]any); ok {
				base = record
			}
		}
	}
	base["briefV1"] = brief
	return json.Marshal(base)
}

func sanitizeBriefPayload(payload map[string]any, maxSources int) (map[string]any, bool) {
	summary, ok := requiredText(payload["detailed_summary"])
	if !ok {
		return nil, false
	}
	tldr, ok := requiredText(payload["tldr"])
	if !ok {
		return nil, false
	}
	keyPoints, ok := briefPoints(payload, "key_points", true, 10, maxSources)
	if !ok {
		return nil, false
	}
	why, ok := briefPoints(payload, "why_it_matters", false, 10, maxSources)
	if !ok {
		return nil, false
	}
	watch, ok := briefPoints(payload, "what_to_watch", false, 12, maxSources)
	if !ok {
		return nil, false
	}
	out := map[string]any{
		"detailed_summary": strings.TrimSpace(summary),
		"tldr":             strings.TrimSpace(tldr),
		"key_points":       keyPoints,
		"why_it_matters":   why,
		"what_to_watch":    watch,
	}
	if _, present := payload["latest_update"]; present {
		if payload["latest_update"] == nil {
			out["latest_update"] = nil
		} else {
			point, ok := onePoint(payload["latest_update"], maxSources)
			if !ok {
				return nil, false
			}
			if point != nil {
				out["latest_update"] = point
			}
		}
	}
	if raw, present := payload["comparison"]; present && raw != nil {
		comparison, ok := raw.(map[string]any)
		if !ok {
			return nil, false
		}
		consensus, ok := briefPoints(comparison, "consensus", false, 12, maxSources)
		if !ok {
			return nil, false
		}
		divergence, ok := briefPoints(comparison, "divergence", false, 12, maxSources)
		if !ok {
			return nil, false
		}
		out["comparison"] = map[string]any{
			"consensus":  consensus,
			"divergence": divergence,
		}
	}
	if _, present := payload["limitations"]; present {
		if payload["limitations"] == nil {
			out["limitations"] = nil
		} else {
			text, ok := payload["limitations"].(string)
			if !ok {
				return nil, false
			}
			out["limitations"] = text
		}
	}
	return out, true
}

func requiredText(value any) (string, bool) {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "", false
	}
	return text, true
}

func briefPoints(payload map[string]any, key string, required bool, maxItems, maxSources int) ([]any, bool) {
	raw, present := payload[key]
	if !present || raw == nil {
		if required {
			return []any{}, true
		}
		return []any{}, true
	}
	items, ok := raw.([]any)
	if !ok || len(items) > maxItems {
		return nil, false
	}
	if required && len(items) == 0 {
		return nil, false
	}
	out := make([]any, 0, len(items))
	for _, item := range items {
		point, ok := onePoint(item, maxSources)
		if !ok {
			return nil, false
		}
		if point == nil {
			continue
		}
		out = append(out, point)
	}
	return out, true
}

func onePoint(value any, maxSources int) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	text, ok := record["text"].(string)
	if !ok || text == "" {
		return nil, false
	}
	citations, ok := citationList(record["citations"], maxSources)
	if !ok {
		return nil, false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, true
	}
	return map[string]any{"text": trimmed, "citations": citations}, true
}

func citationList(value any, maxSources int) ([]int, bool) {
	if value == nil {
		return []int{}, true
	}
	items, ok := value.([]any)
	if !ok || len(items) > 12 {
		return nil, false
	}
	seen := map[int]struct{}{}
	out := make([]int, 0, len(items))
	for _, item := range items {
		number, ok := item.(float64)
		if !ok || number != float64(int(number)) || int(number) < 1 {
			return nil, false
		}
		index := int(number)
		if index > maxSources {
			continue
		}
		if _, ok := seen[index]; ok {
			continue
		}
		seen[index] = struct{}{}
		out = append(out, index)
	}
	for i := 1; i < len(out); i++ {
		current := out[i]
		j := i
		for j > 0 && out[j-1] > current {
			out[j] = out[j-1]
			j--
		}
		out[j] = current
	}
	if len(out) > 12 {
		out = out[:12]
	}
	return out, true
}

func buildBriefSystemPrompt(language string) string {
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

func buildBriefUserPrompt(title, summary, language string, startAt, lastAt time.Time, sources []briefSource) string {
	lines := []string{
		"Event:",
		"title: " + title,
		"startAt: " + isoTime(startAt),
		"lastAt: " + isoTime(lastAt),
	}
	if strings.TrimSpace(language) != "" {
		lines = append(lines, "sourceLanguage: "+strings.TrimSpace(language))
	}
	if trimmed := strings.TrimSpace(summary); trimmed != "" {
		lines = append(lines, "eventSummary: "+truncateText(trimmed, 600))
	}
	lines = append(lines, "", "Sources (use only these):")
	blocks := make([]string, 0, len(sources))
	for _, source := range sources {
		when := "unknown"
		if source.PublishedAt != nil {
			when = isoTime(*source.PublishedAt)
		}
		bits := []string{
			"[" + itoa(source.Index) + "] " + nonEmpty(source.SourceLabel, "Unknown source"),
			"time: " + when,
			"title: " + source.Title,
			"url: " + source.URL,
		}
		if source.Summary != "" {
			bits = append(bits, "summary: "+truncateText(source.Summary, 700))
		}
		if len(source.KeyPoints) > 0 {
			points := source.KeyPoints
			if len(points) > 8 {
				points = points[:8]
			}
			bits = append(bits, "key_points: "+truncateText(strings.Join(points, " | "), 900))
		}
		blocks = append(blocks, strings.Join(bits, "\n"))
	}
	lines = append(lines, strings.Join(blocks, "\n\n"))
	lines = append(lines,
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

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [12]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[i:])
}

func truncateText(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	cut := limit - 1
	if cut < 0 {
		cut = 0
	}
	runes := []rune(value)
	if cut > len(runes) {
		cut = len(runes)
	}
	return strings.TrimRightFunc(string(runes[:cut]), unicode.IsSpace) + "…"
}

func parseBriefJSON(content string) (map[string]any, bool) {
	extracted := extractJSONObject(content)
	if extracted == "" {
		return nil, false
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(extracted), &payload); err != nil {
		return nil, false
	}
	return payload, true
}

func extractJSONObject(text string) string {
	cleaned := stripCodeFence(strings.TrimSpace(text))
	start := strings.Index(cleaned, "{")
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(cleaned); i++ {
		char := cleaned[i]
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
			depth++
		case '}':
			depth--
			if depth == 0 {
				return strings.TrimSpace(cleaned[start : i+1])
			}
		}
	}
	return ""
}

func stripCodeFence(text string) string {
	if !strings.HasPrefix(text, "```") {
		return text
	}
	newline := strings.Index(text, "\n")
	if newline < 0 {
		return text
	}
	rest := text[newline+1:]
	closeAt := strings.LastIndex(rest, "```")
	if closeAt < 0 {
		return text
	}
	return strings.TrimSpace(rest[:closeAt])
}

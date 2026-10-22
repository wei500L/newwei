package crawlexecution

// This file ports the markdown parts of apps/api/src/modules/crawl/crawl-result.service.ts
// that runTask's result persistence and the quality/anti-bot branches read:
// extractMarkdownResult (candidate scoring included), normalizeMarkdownCandidate,
// isLikelyBotChallengeMarkdown, isLowSignalMarkdown and the markdown quality
// score from crawl-quality.strategy.ts.

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

var (
	botChallengeStrongIndicators = []string{
		"verification required",
		"please enable js and disable any ad blocker",
		"please enable javascript",
		"checking your browser before accessing",
		"you are being rate limited",
	}
	botChallengeWeakIndicators = []string{
		"captcha", "cloudflare", "datadome", "are you human", "access denied",
		"security check", "automated requests", "bot detection",
	}
	preambleIndexPattern    = regexp.MustCompile(`^(?:[⟨<]\d+[⟩>]\s*)+$`)
	navigationLinkPattern   = regexp.MustCompile(`^(?:\[[^\]]+\]\(\S+\)\s*)+$`)
	markdownLinkPattern     = regexp.MustCompile(`\[[^\]]+\]\(\S+\)`)
	referenceHeadingPattern = regexp.MustCompile(`(?i)^#{1,6}\s*references\b`)
	referenceLinePattern    = regexp.MustCompile(`(?i)^references\b`)
	referenceDefinition     = regexp.MustCompile(`(?i)^\[[^\]]+\]:\s*\S+`)
	footnoteDefinition      = regexp.MustCompile(`(?i)^\[\^[^\]]+\]:\s*\S+`)
	bareURLPattern          = regexp.MustCompile(`(?i)^https?://\S+$`)
	markdownLinkLine        = regexp.MustCompile(`^[-*]\s*\[[^\]]+\]\(\S+\)`)
	preambleNoisePattern    = regexp.MustCompile(`(?i)^(?:politico pro\s*[⟨<]\d+[⟩>]|menu)$`)
	// politicoProNoisePattern is isLikelyNoiseLine's politico-pro rule. The bare
	// "politico pro" line is excluded there and only dropped before the first
	// heading by isLikelyPreambleNoiseLine.
	politicoProNoisePattern = regexp.MustCompile(`(?i)^\s*politico pro\s*(?:[⟨<]\d+[⟩>])?\s*$`)
)

// extractMarkdownResult is extractMarkdownResult.
func extractMarkdownResult(raw json.RawMessage) markdownResult {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return markdownResult{}
	}
	if strings.HasPrefix(trimmed, "\"") {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return markdownResult{}
		}
		normalized := normalizeMarkdownCandidate(&value)
		if normalized == nil {
			return markdownResult{}
		}
		return markdownResult{Primary: normalized, Raw: normalized}
	}
	if !strings.HasPrefix(trimmed, "{") {
		return markdownResult{}
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(raw, &record); err != nil {
		return markdownResult{}
	}
	rawMarkdown := normalizeMarkdownCandidate(firstStringValue(record,
		"raw_markdown", "rawMarkdown", "markdown"))
	citations := normalizeMarkdownCandidate(firstStringValue(record,
		"markdown_with_citations", "markdownWithCitations"))
	var citationsBody *string
	if citations != nil {
		citationsBody = stripCitationReferenceSection(*citations)
	}
	references := normalizeMarkdownCandidate(firstStringValue(record,
		"references_markdown", "referencesMarkdown"))
	fit := normalizeMarkdownCandidate(firstStringValue(record,
		"fit_markdown", "fitMarkdown"))
	textFallback := normalizeMarkdownCandidate(firstStringValue(record, "text"))

	candidates := make([]scoredCandidate, 0, 5)
	if citationsBody != nil {
		candidates = append(candidates, scoredCandidate{source: "citations", value: *citationsBody})
	}
	if rawMarkdown != nil {
		candidates = append(candidates, scoredCandidate{source: "raw", value: *rawMarkdown})
	}
	if fit != nil {
		candidates = append(candidates, scoredCandidate{source: "fit", value: *fit})
	}
	if references != nil {
		candidates = append(candidates, scoredCandidate{source: "references", value: *references})
	}
	if textFallback != nil {
		candidates = append(candidates, scoredCandidate{source: "text", value: *textFallback})
	}

	maxNonReferenceLength := 0
	for _, entry := range candidates {
		if entry.source != "references" && len(entry.value) > maxNonReferenceLength {
			maxNonReferenceLength = len(entry.value)
		}
	}
	for index := range candidates {
		candidates[index].score = scoreMarkdownCandidate(candidates[index].value, candidates[index].source, maxNonReferenceLength)
	}
	// Sort by score desc, then length desc (stable insertion order for ties).
	for left := 0; left < len(candidates); left++ {
		for right := left + 1; right < len(candidates); right++ {
			if candidates[right].score > candidates[left].score ||
				(candidates[right].score == candidates[left].score && len(candidates[right].value) > len(candidates[left].value)) {
				candidates[left], candidates[right] = candidates[right], candidates[left]
			}
		}
	}
	var best *scoredCandidate
	if len(candidates) > 0 {
		best = &candidates[0]
	}
	richer := selectRicherPrimaryCandidate(candidates)
	if best != nil && richer != nil && shouldPreferRicherCandidate(*best, *richer) {
		best = richer
	}
	result := markdownResult{
		Raw:        rawMarkdown,
		Citations:  citations,
		References: references,
		Fit:        fit,
	}
	switch {
	case best != nil:
		primary := best.value
		result.Primary = &primary
	case citationsBody != nil:
		result.Primary = citationsBody
	case rawMarkdown != nil:
		result.Primary = rawMarkdown
	case fit != nil:
		result.Primary = fit
	case references != nil:
		result.Primary = references
	case textFallback != nil:
		result.Primary = textFallback
	}
	if result.Raw == nil && result.Primary != nil {
		value := *result.Primary
		result.Raw = &value
	}
	return result
}

type scoredCandidate struct {
	source string
	value  string
	score  float64
}

func selectRicherPrimaryCandidate(candidates []scoredCandidate) *scoredCandidate {
	var richer *scoredCandidate
	for index := range candidates {
		entry := &candidates[index]
		if entry.source != "citations" && entry.source != "raw" {
			continue
		}
		if isLikelyBotChallengeMarkdown(entry.value) {
			continue
		}
		if richer == nil || len(entry.value) > len(richer.value) ||
			(len(entry.value) == len(richer.value) && entry.score > richer.score) {
			richer = entry
		}
	}
	return richer
}

func shouldPreferRicherCandidate(current, richer scoredCandidate) bool {
	currentTrimmed := strings.TrimSpace(current.value)
	richerTrimmed := strings.TrimSpace(richer.value)
	if currentTrimmed == "" || richerTrimmed == "" {
		return false
	}
	currentChallenge := isLikelyBotChallengeMarkdown(currentTrimmed)
	richerChallenge := isLikelyBotChallengeMarkdown(richerTrimmed)
	if currentChallenge && !richerChallenge {
		return true
	}
	currentLength := len(currentTrimmed)
	richerLength := len(richerTrimmed)
	if current.source == "fit" && richerLength >= 1600 && currentLength <= 800 {
		return true
	}
	if richerLength >= 1200 && float64(currentLength) < float64(richerLength)*0.33 &&
		current.score-richer.score <= 420 {
		return true
	}
	return false
}

// scoreMarkdownCandidate is scoreMarkdownCandidate.
func scoreMarkdownCandidate(markdown, source string, maxCandidateLength int) float64 {
	trimmed := strings.TrimSpace(markdown)
	if trimmed == "" {
		return math.Inf(-1)
	}
	if isLikelyBotChallengeMarkdown(trimmed) {
		return -5000
	}
	normalizedSpaces := strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(trimmed)
	wordCount := 0
	for _, word := range strings.Split(normalizedSpaces, " ") {
		if strings.TrimSpace(word) != "" {
			wordCount++
		}
	}
	headingCount := 0
	for _, line := range strings.Split(trimmed, "\n") {
		if strings.HasPrefix(strings.TrimLeft(line, " \t"), "#") {
			headingCount++
		}
	}
	citationCount := countOccurrences(trimmed, "[^")
	markdownLinkCount := countOccurrences(trimmed, "](")
	paragraphCount := 0
	for _, entry := range strings.Split(trimmed, "\n\n") {
		if strings.TrimSpace(entry) != "" {
			paragraphCount++
		}
	}
	score := math.Min(float64(wordCount), 12000) +
		float64(headingCount)*8 +
		float64(citationCount)*3 +
		math.Min(float64(paragraphCount), 160)*2 -
		float64(markdownLinkCount)*3
	score -= estimateNavigationNoisePenalty(trimmed)

	coverageRatio := 1.0
	if maxCandidateLength > 0 {
		coverageRatio = math.Min(2, float64(len(trimmed))/float64(maxCandidateLength))
	}
	switch source {
	case "citations":
		score += 30
	case "fit":
		score -= 60
		if maxCandidateLength >= 1200 && coverageRatio < 0.45 {
			score -= 260
		}
	case "references":
		score -= 140
	case "text":
		score -= 20
	}
	if (source == "raw" || source == "citations") && coverageRatio >= 0.45 {
		score += math.Min((coverageRatio-0.45)*180, 120)
	}
	return score
}

// stripCitationReferenceSection is stripCitationReferenceSection: everything
// before the first footnote reference definition is the citation body.
func stripCitationReferenceSection(markdown string) *string {
	lines := strings.Split(markdown, "\n")
	start := -1
	for index, line := range lines {
		if regexp.MustCompile(`^\[\^[^\]]+\]:`).MatchString(strings.TrimSpace(line)) {
			start = index
			break
		}
	}
	if start <= 0 {
		return &markdown
	}
	body := strings.TrimSpace(strings.Join(lines[:start], "\n"))
	if body == "" {
		return &markdown
	}
	return &body
}

// estimateNavigationNoisePenalty is estimateNavigationNoisePenalty.
func estimateNavigationNoisePenalty(markdown string) float64 {
	lines := make([]string, 0, 32)
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) < 10 {
		return 0
	}
	noise := 0
	for _, line := range lines {
		if len(line) > 80 {
			continue
		}
		if strings.ContainsAny(line, ".!?。！？") {
			continue
		}
		if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") ||
			strings.HasPrefix(line, "• ") || strings.Contains(line, "|") ||
			strings.Contains(line, "›") || strings.Contains(line, "»") ||
			strings.Contains(line, "⟨") || strings.Contains(line, "https://") ||
			strings.Contains(line, "http://") {
			noise++
		}
	}
	ratio := float64(noise) / float64(len(lines))
	if ratio < 0.35 {
		return 0
	}
	return math.Round(ratio * 1200)
}

func countOccurrences(value, needle string) int {
	if value == "" || needle == "" {
		return 0
	}
	count := 0
	from := 0
	for from < len(value) {
		next := strings.Index(value[from:], needle)
		if next < 0 {
			break
		}
		count++
		from += next + len(needle)
	}
	return count
}

// isLikelyBotChallengeMarkdown is isLikelyBotChallengeMarkdown.
func isLikelyBotChallengeMarkdown(markdown string) bool {
	normalized := strings.ToLower(markdown)
	for _, indicator := range botChallengeStrongIndicators {
		if strings.Contains(normalized, indicator) {
			return true
		}
	}
	weakHits := 0
	for _, indicator := range botChallengeWeakIndicators {
		if strings.Contains(normalized, indicator) {
			weakHits++
		}
	}
	return weakHits >= 2 && len(normalized) < 12000
}

// isLowSignalMarkdown is isLowSignalMarkdown.
func isLowSignalMarkdown(markdown string) bool {
	normalized := normalizeMarkdownCandidate(&markdown)
	if normalized == nil {
		return true
	}
	if isReferenceOnlyMarkdown(*normalized) {
		return true
	}
	words := 0
	for _, entry := range strings.Fields(*normalized) {
		if entry != "" {
			words++
		}
	}
	lines := make([]string, 0, 32)
	for _, line := range strings.Split(*normalized, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	meaningful := 0
	sentenceLike := 0
	sentencePattern := regexp.MustCompile(`[.!?。！？]`)
	for _, line := range lines {
		if isReferenceLine(line) {
			continue
		}
		meaningful++
		if sentencePattern.MatchString(line) {
			sentenceLike++
		}
	}
	if words <= 8 && meaningful <= 2 {
		return true
	}
	if words <= 16 && sentenceLike == 0 && meaningful <= 3 {
		return true
	}
	return false
}

func isReferenceOnlyMarkdown(markdown string) bool {
	lines := make([]string, 0, 16)
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) == 0 {
		return true
	}
	for _, line := range lines {
		if !isReferenceLine(line) {
			return false
		}
	}
	for _, line := range lines {
		if referenceHeadingPattern.MatchString(line) || referenceLinePattern.MatchString(line) {
			return true
		}
	}
	return false
}

func isReferenceLine(line string) bool {
	if line == "" {
		return true
	}
	if referenceHeadingPattern.MatchString(line) || referenceLinePattern.MatchString(line) {
		return true
	}
	if referenceDefinition.MatchString(line) || footnoteDefinition.MatchString(line) {
		return true
	}
	if markdownLinkLine.MatchString(line) {
		return true
	}
	if bareURLPattern.MatchString(line) {
		return true
	}
	return false
}

// normalizeMarkdownCandidate is normalizeMarkdownCandidate: control characters
// removed, repeated short lines collapsed, low-value noise lines dropped.
func normalizeMarkdownCandidate(value *string) *string {
	if value == nil {
		return nil
	}
	withoutControl := strings.ReplaceAll(*value, "\r\n", "\n")
	withoutControl = strings.ReplaceAll(withoutControl, "\r", "\n")
	withoutControl = strings.ReplaceAll(withoutControl, "\u0000", "")
	zeroWidth := regexp.MustCompile("[\u200B-\u200D\uFEFF]")
	withoutControl = zeroWidth.ReplaceAllString(withoutControl, "")

	rawLines := strings.Split(withoutControl, "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		lines = append(lines, strings.TrimRight(line, " \t"))
	}
	deduped := make([]string, 0, len(lines))
	previousCompact := ""
	repeated := 0
	for _, line := range lines {
		compact := strings.TrimSpace(line)
		if compact != "" && compact == previousCompact && len(compact) <= 80 {
			repeated++
			if repeated >= 2 {
				continue
			}
		} else {
			previousCompact = compact
			repeated = 0
		}
		deduped = append(deduped, line)
	}
	cleaned := dropLowValueNoiseLines(deduped)
	normalized := strings.TrimSpace(regexp.MustCompile(`\n{3,}`).ReplaceAllString(strings.Join(cleaned, "\n"), "\n\n"))
	if normalized == "" {
		return nil
	}
	return &normalized
}

// dropLowValueNoiseLines is dropLowValueNoiseLines.
func dropLowValueNoiseLines(lines []string) []string {
	if len(lines) == 0 {
		return lines
	}
	firstHeadingIndex := -1
	for index, line := range lines {
		if regexp.MustCompile(`^#{1,6}\s+`).MatchString(strings.TrimSpace(line)) {
			firstHeadingIndex = index
			break
		}
	}
	kept := make([]string, 0, len(lines))
	removed := 0
	for index, line := range lines {
		compact := strings.TrimSpace(line)
		if compact == "" {
			kept = append(kept, line)
			continue
		}
		if firstHeadingIndex >= 0 && index < firstHeadingIndex && isLikelyPreambleNoiseLine(compact) {
			removed++
			continue
		}
		if isLikelyNoiseLine(compact) {
			removed++
			continue
		}
		kept = append(kept, line)
	}
	dense := 0
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			dense++
		}
	}
	if dense == 0 {
		return kept
	}
	removalRatio := float64(removed) / float64(dense)
	keptDense := 0
	keptBody := 0
	for _, line := range kept {
		compact := strings.TrimSpace(line)
		if compact == "" {
			continue
		}
		keptDense++
		if !regexp.MustCompile(`^#{1,6}\s+`).MatchString(compact) {
			keptBody++
		}
	}
	if keptDense == 0 || keptBody == 0 {
		return lines
	}
	if keptDense <= 2 && removalRatio > 0.75 {
		return lines
	}
	return kept
}

func isLikelyPreambleNoiseLine(compact string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(compact), " "))
	if preambleIndexPattern.MatchString(compact) {
		return true
	}
	if normalized == "menu" || normalized == "politico pro" {
		return true
	}
	if preambleNoisePattern.MatchString(strings.ToLower(compact)) {
		return true
	}
	return isLikelyNavigationLinkLine(compact)
}

func isLikelyNavigationLinkLine(compact string) bool {
	if !navigationLinkPattern.MatchString(compact) {
		return false
	}
	visible := strings.ToLower(strings.TrimSpace(
		regexp.MustCompile(`\s+`).ReplaceAllString(markdownLinkPattern.ReplaceAllString(compact, "$1"), " ")))
	if visible == "" {
		return true
	}
	return regexp.MustCompile(`(skip to (main )?content|menu|log in|sign in|subscribe|politico pro|my account|account|home|search)`).MatchString(visible)
}

func isLikelyNoiseLine(compact string) bool {
	lower := strings.ToLower(compact)
	normalized := strings.Join(strings.Fields(lower), " ")
	if regexp.MustCompile(`(?i)^\s*skip to (main )?content\s*(?:[⟨<]\d+[⟩>])?\s*$`).MatchString(compact) {
		return true
	}
	if regexp.MustCompile(`(?i)^\s*menu\s*(?:[⟨<]\d+[⟩>])\s*$`).MatchString(compact) {
		return true
	}
	if regexp.MustCompile(`(?i)^\s*by\s+.+[⟨<]\d+[⟩>]\s*$`).MatchString(compact) {
		return true
	}
	if regexp.MustCompile(`(?i)^\s*\[\s*\]\(https?:\/\/[^)]+\)\s*$`).MatchString(compact) ||
		isLikelyNavigationLinkLine(compact) {
		return true
	}
	// A "politico pro ⟨n⟩" marker is newsroom chrome wherever it appears; the
	// bare label is only preamble noise (dropped before the first heading).
	if politicoProNoisePattern.MatchString(compact) && lower != "politico pro" {
		return true
	}
	if regexp.MustCompile(`(?i)^advertisement$|^sponsored$`).MatchString(compact) {
		return true
	}
	if strings.HasPrefix(normalized, "free article usually reserved for subscribers") {
		return true
	}
	if normalized == "listen" || normalized == "ai generated text-to-speech" || normalized == "ai-generated text-to-speech" {
		return true
	}
	if len(compact) <= 80 && regexp.MustCompile(`(?i)^(subscribe|sign in|log in|get unlimited access|already a subscriber|create an account)`).MatchString(compact) {
		return true
	}
	if len(compact) <= 120 && regexp.MustCompile(`(?i)^(accept|agree|manage)( all)? (cookies|privacy|consent)`).MatchString(compact) {
		return true
	}
	if len(compact) <= 140 && regexp.MustCompile(`(?i)^(privacy policy|cookie policy|terms of service|terms & conditions|all rights reserved)$`).MatchString(compact) {
		return true
	}
	return false
}

// ensureString is ensureString: only string values survive.
func ensureString(raw json.RawMessage) *string {
	if len(raw) == 0 {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

// firstStringValue returns the first non-empty decoded string field in key order.
func firstStringValue(record map[string]json.RawMessage, keys ...string) *string {
	for _, key := range keys {
		raw, ok := record[key]
		if !ok {
			continue
		}
		if value := ensureString(raw); value != nil {
			return value
		}
	}
	return nil
}

// estimateBoilerplateRatio is estimateBoilerplateRatio.
func estimateBoilerplateRatio(markdown string) float64 {
	if markdown == "" {
		return 0
	}
	lines := make([]string, 0, 32)
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) == 0 {
		return 0
	}
	pattern := regexp.MustCompile(`(?i)subscribe|newsletter|sign up|privacy policy|terms|cookie|follow us|advertisement`)
	boilerplate := 0
	for _, line := range lines {
		if pattern.MatchString(line) {
			boilerplate++
		}
	}
	return math.Min(1, float64(boilerplate)/float64(len(lines)))
}

// scoreMarkdownQuality is CrawlQualityStrategyService.scoreMarkdownQuality.
func scoreMarkdownQuality(successes []crawl4ai.PipelineArticle) float64 {
	if len(successes) == 0 {
		return math.Inf(-1)
	}
	total := 0.0
	for _, article := range successes {
		total += scoreSingleMarkdownQuality(article)
	}
	return total
}

// scoreSingleMarkdownQuality is scoreSingleMarkdownQuality.
func scoreSingleMarkdownQuality(article crawl4ai.PipelineArticle) float64 {
	markdown := extractMarkdownResult(article.Markdown)
	if markdown.Primary == nil {
		return -1000
	}
	primary := strings.TrimSpace(*markdown.Primary)
	if primary == "" {
		return -1000
	}
	words := len(strings.Fields(primary))
	headingPattern := regexp.MustCompile(`(?m)^#{1,6}\s+`)
	headings := len(headingPattern.FindAllString(primary, -1))
	linkPattern := regexp.MustCompile(`\]\((https?://|/)`)
	markdownLinks := len(linkPattern.FindAllString(primary, -1))
	rawURLPattern := regexp.MustCompile(`https?://\S+`)
	rawURLs := len(rawURLPattern.FindAllString(primary, -1))
	codeFenceMarkers := strings.Count(primary, "```")
	codeBlocks := codeFenceMarkers / 2
	citationPattern := regexp.MustCompile(`\[\^\d+\]`)
	citationMarks := len(citationPattern.FindAllString(primary, -1))
	boilerplateRatio := estimateBoilerplateRatio(primary)
	score := math.Min(float64(words), 6000) +
		float64(headings)*8 +
		float64(citationMarks)*2 -
		float64(markdownLinks+rawURLs)*4 -
		float64(codeBlocks)*3 -
		math.Round(boilerplateRatio*220)
	if math.IsNaN(score) || math.IsInf(score, 0) {
		return 0
	}
	return score
}

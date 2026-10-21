package newspipeline

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

// This file ports the gate evaluation and the pure markdown helpers of
// news-pipeline-stages.service.ts / news-pipeline-clean.service.ts that the
// staged pipeline needs:
//
//	evaluatePreflightGate, computePreflightQualityScore, clamp01,
//	evaluatePostCleanGate, buildGateRejectedCleanedNews, stripEnrichmentFields
//
// plus the markdown builders those gates call (buildPipelineQualityMarkdown,
// assessPipelineMarkdownQuality, buildMarkdownForLlm,
// scoreMarkdownForLlmCandidate, hasCitationMarkers,
// hasCitationReferenceDefinitions).
//
// The helpers are deliberately self-contained (pipeline* names) instead of
// reaching into the cleaner's internal surface: the gate path must not depend on
// how clean.go orders its own helpers, and both files stay byte-equivalent to
// the TypeScript originals. The one shared helper (isLikelyBotChallengeMarkdown)
// comes from internal.go (news-config scope).
//
// JavaScript semantics that matter here and are reproduced explicitly:
//   - String.prototype.trim() and RegExp \s use the JavaScript whitespace set
//     (which includes NBSP and the Unicode space separators);
//   - string length is measured in UTF-16 code units, so .slice(0, n) cuts by
//     code units, not bytes or runes;
//   - Array.prototype.sort is stable, so ties keep the candidate order.

// pipelineMarkdownQuality is PipelineMarkdownQuality.
type pipelineMarkdownQuality struct {
	words        int
	paragraphs   int
	headingCount int
	linkCount    int
	bulletLines  int
	score        float64
	isChallenge  bool
	isListLike   bool
}

// pipelinePreflightResult is the evaluatePreflightGate return value. The score
// and threshold members are nil when the gate is disabled (the TypeScript code
// only sets them after the enabled check).
type pipelinePreflightResult struct {
	rejected         bool
	reason           *string
	qualityScore     *float64
	qualityThreshold *float64
}

// pipelinePostCleanGateResult is the evaluatePostCleanGate return value.
type pipelinePostCleanGateResult struct {
	rejected bool
	reason   *string
}

// pipelineMarkdownForLLM is the buildMarkdownForLlm result. Only Markdown is
// used on the gate-rejected persist path; the other members keep the port
// faithful so the helper can be reused by tests.
type pipelineMarkdownForLLM struct {
	Markdown           string
	Source             string
	Variant            string
	ReferencesAppended bool
}

// JavaScript RegExp \s whitespace class. Go's RE2 \s is ASCII-only, so the
// class is spelled out.
const pipelineJSSpaceClass = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	// /\n\s*\n/g
	pipelineParagraphSplitPattern = regexp.MustCompile(`\n[` + pipelineJSSpaceClass + `]*\n`)
	// /^#{1,6}\s+/gm
	pipelineHeadingPattern = regexp.MustCompile(`(?m)^#{1,6}[` + pipelineJSSpaceClass + `]+`)
	// /\]\((https?:\/\/|\/)/g
	pipelineMarkdownLinkPattern = regexp.MustCompile(`\]\((https?://|/)`)
	// /\[\^[^\]]+\]/g
	pipelineCitationMarkerPattern = regexp.MustCompile(`\[\^[^\]]+\]`)
	// /^\[\^[^\]]+\]:\s+/m
	pipelineCitationDefinitionPattern = regexp.MustCompile(`(?m)^\[\^[^\]]+\]:[` + pipelineJSSpaceClass + `]+`)
)

// pipelineIsJSSpace reports whether r is matched by JavaScript's \s (and
// String.prototype.trim).
func pipelineIsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// pipelineTrimJS is String.prototype.trim().
func pipelineTrimJS(value string) string {
	return strings.TrimFunc(value, pipelineIsJSSpace)
}

// pipelineJSStringLength is value.length: the number of UTF-16 code units.
func pipelineJSStringLength(value string) int {
	length := 0
	for _, r := range value {
		if r > 0xFFFF {
			length += 2
			continue
		}
		length++
	}
	return length
}

// pipelineSliceJS is value.slice(0, limit) in UTF-16 code units. A surrogate
// pair is never split (JavaScript would produce a lone surrogate, which no Go
// string can carry).
func pipelineSliceJS(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := 0
	for index, r := range value {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > limit {
			return value[:index]
		}
		units += width
	}
	return value
}

// pipelineSplitJSSpace is value.split(/\s+/).
func pipelineSplitJSSpace(value string) []string {
	fields := make([]string, 0, 8)
	start := -1
	for index, r := range value {
		if pipelineIsJSSpace(r) {
			if start >= 0 {
				fields = append(fields, value[start:index])
				start = -1
			}
			continue
		}
		if start < 0 {
			start = index
		}
	}
	if start >= 0 {
		fields = append(fields, value[start:])
	}
	return fields
}

// pipelineSplitNewlines is value.split(/\n/g).
func pipelineSplitNewlines(value string) []string {
	return strings.Split(value, "\n")
}

// pipelineCountWords is value.split(/\s+/).filter(length > 0).length.
func pipelineCountWords(value string) int {
	return len(pipelineSplitJSSpace(value))
}

// pipelineCountParagraphs is
// value.split(/\n\s*\n/g).map(trim).filter(length > 0).length.
func pipelineCountParagraphs(value string) int {
	count := 0
	for _, entry := range pipelineParagraphSplitPattern.Split(value, -1) {
		if pipelineTrimJS(entry) != "" {
			count++
		}
	}
	return count
}

// pipelineCountBulletLines is the bullet-line counter of
// assessPipelineMarkdownQuality.
func pipelineCountBulletLines(value string) int {
	count := 0
	for _, entry := range pipelineSplitNewlines(value) {
		trimmed := pipelineTrimJS(entry)
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "• ") {
			count++
		}
	}
	return count
}

// pipelineAssessMarkdownQuality is assessPipelineMarkdownQuality.
func pipelineAssessMarkdownQuality(markdown string) pipelineMarkdownQuality {
	normalized := pipelineTrimJS(markdown)
	if normalized == "" {
		return pipelineMarkdownQuality{score: math.Inf(-1)}
	}

	words := pipelineCountWords(normalized)
	paragraphs := pipelineCountParagraphs(normalized)
	headingCount := len(pipelineHeadingPattern.FindAllStringIndex(normalized, -1))
	linkCount := len(pipelineMarkdownLinkPattern.FindAllStringIndex(normalized, -1))
	bulletLines := pipelineCountBulletLines(normalized)

	isChallenge := isLikelyBotChallengeMarkdown(normalized)
	linkDensity := 0.0
	if words > 0 {
		linkDensity = float64(linkCount) / float64(words)
	} else {
		linkDensity = float64(linkCount)
	}
	isListLike := (linkCount >= 16 && words <= 900) ||
		(bulletLines >= 10 && linkCount >= 10) ||
		(linkDensity >= 0.09 && words <= 600)

	score := float64(pipelineMinInt(words, 12000)) +
		float64(pipelineMinInt(paragraphs, 220))*6 +
		float64(headingCount)*3 -
		float64(linkCount)*6 -
		float64(bulletLines)*2

	return pipelineMarkdownQuality{
		words:        words,
		paragraphs:   paragraphs,
		headingCount: headingCount,
		linkCount:    linkCount,
		bulletLines:  bulletLines,
		score:        score,
		isChallenge:  isChallenge,
		isListLike:   isListLike,
	}
}

// pipelineBuildQualityMarkdown is buildPipelineQualityMarkdown.
func pipelineBuildQualityMarkdown(article CrawledArticle) string {
	candidates := make([]string, 0, 4)
	for _, entry := range []*string{
		stringPointer(article.Markdown),
		article.MarkdownWithCitations,
		article.RawMarkdown,
		article.FitMarkdown,
	} {
		if entry == nil {
			continue
		}
		trimmed := pipelineTrimJS(*entry)
		if trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}
	if len(candidates) == 0 {
		return ""
	}

	type scoredCandidate struct {
		value   string
		quality pipelineMarkdownQuality
	}
	scored := make([]scoredCandidate, 0, len(candidates))
	for _, value := range candidates {
		scored = append(scored, scoredCandidate{value: value, quality: pipelineAssessMarkdownQuality(value)})
	}
	sort.SliceStable(scored, func(left, right int) bool {
		if scored[right].quality.score != scored[left].quality.score {
			return scored[right].quality.score < scored[left].quality.score
		}
		return pipelineJSStringLength(scored[right].value) < pipelineJSStringLength(scored[left].value)
	})
	return scored[0].value
}

// pipelineComputePreflightQualityScore is computePreflightQualityScore.
func pipelineComputePreflightQualityScore(quality pipelineMarkdownQuality) float64 {
	if quality.words <= 0 || quality.isChallenge {
		return 0
	}
	score := pipelineClamp01(0.15 +
		0.45*pipelineClamp01(float64(quality.words)/300) +
		0.25*pipelineClamp01(float64(quality.paragraphs)/5) +
		0.1*pipelineClamp01(float64(quality.headingCount)/4) -
		0.2*pipelineClamp01(float64(quality.linkCount)/30) -
		0.1*pipelineClamp01(float64(quality.bulletLines)/40))
	if quality.isListLike {
		return math.Min(score, 0.3)
	}
	return score
}

// pipelineClamp01 is clamp01: a non-finite value becomes 0.
func pipelineClamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Min(1, math.Max(0, value))
}

func pipelineMinInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// evaluatePreflightGate is evaluatePreflightGate.
func evaluatePreflightGate(article CrawledArticle, settings ExtractionSettings) pipelinePreflightResult {
	gate := settings.PreflightGate
	if !gate.Enabled {
		return pipelinePreflightResult{}
	}
	markdown := pipelineBuildQualityMarkdown(article)
	quality := pipelineAssessMarkdownQuality(markdown)
	qualityScore := pipelineComputePreflightQualityScore(quality)
	qualityThreshold := gate.MinQualityScore
	result := pipelinePreflightResult{
		qualityScore:     floatPointer(qualityScore),
		qualityThreshold: floatPointer(qualityThreshold),
	}
	if gate.RejectBotChallenge && (quality.isChallenge || isLikelyBotChallengeMarkdown(markdown)) {
		result.rejected = true
		result.reason = stringPointer("bot_challenge_markdown")
		return result
	}
	if gate.RejectListLike && quality.isListLike {
		result.rejected = true
		result.reason = stringPointer("list_like_markdown")
		return result
	}
	if quality.words < gate.MinWordCount {
		result.rejected = true
		result.reason = stringPointer("insufficient_word_count")
		return result
	}
	if qualityScore < qualityThreshold {
		result.rejected = true
		result.reason = stringPointer("preflight_quality_score_below_threshold")
		return result
	}
	return result
}

// evaluatePostCleanGate is evaluatePostCleanGate.
func evaluatePostCleanGate(cleaned CleanedNews, settings ExtractionSettings) pipelinePostCleanGateResult {
	gate := settings.PostCleanGate
	if !gate.Enabled {
		return pipelinePostCleanGateResult{}
	}
	if pipelineJSStringLength(pipelineTrimJS(cleaned.CleanedMarkdown)) < gate.MinCleanedChars {
		return pipelinePostCleanGateResult{rejected: true, reason: stringPointer("cleaned_markdown_too_short")}
	}
	if gate.RequireSummary && (cleaned.Summary == nil || pipelineTrimJS(*cleaned.Summary) == "") {
		return pipelinePostCleanGateResult{rejected: true, reason: stringPointer("missing_summary")}
	}
	if cleaned.QualityScore != nil {
		score := *cleaned.QualityScore
		if !math.IsNaN(score) && !math.IsInf(score, 0) && score < gate.MinQualityScore {
			return pipelinePostCleanGateResult{rejected: true, reason: stringPointer("quality_score_below_threshold")}
		}
	}
	return pipelinePostCleanGateResult{}
}

// buildGateRejectedCleanedNews is buildGateRejectedCleanedNews.
func buildGateRejectedCleanedNews(article CrawledArticle, payload NormalizedPayload, reason string, stageMeta *StageMeta, maxInputChars int) CleanedNews {
	fallback := pipelineBuildMarkdownForLLM(article, pipelineMinInt(maxInputChars, 8_000))
	paragraphs := pipelineParagraphSplitPattern.Split(fallback.Markdown, -1)
	summaryParts := make([]string, 0, 2)
	for _, entry := range paragraphs {
		trimmed := pipelineTrimJS(entry)
		if trimmed == "" {
			continue
		}
		summaryParts = append(summaryParts, trimmed)
		if len(summaryParts) >= 2 {
			break
		}
	}
	summaryText := pipelineSliceJS(strings.Join(summaryParts, " "), 300)

	cleanedMarkdown := fallback.Markdown
	if cleanedMarkdown == "" {
		cleanedMarkdown = article.Markdown
	}
	var summary *string
	if summaryText != "" {
		summary = stringPointer(summaryText)
	}
	return CleanedNews{
		Title:                 payload.SourceName,
		Source:                payload.SourceName,
		PublishedAt:           article.PublishedAt,
		Language:              payload.Language,
		CategoryLabels:        []string{},
		CategoryCandidates:    []ClassificationCandidate{},
		Topics:                []string{},
		Summary:               summary,
		KeyPoints:             []string{},
		Entities:              []Entity{},
		KGRelations:           []KGRelation{},
		StageMeta:             stageMeta,
		CleanedMarkdown:       cleanedMarkdown,
		CleanedMarkdownSource: stringPointer("crawl_fallback"),
		RemovedNoiseTypes:     []string{reason},
	}
}

// stripEnrichmentFields is stripEnrichmentFields: it clears the enrichment
// outputs before the staged pipeline recomputes them.
func stripEnrichmentFields(cleaned CleanedNews) CleanedNews {
	cleaned.Sentiment = nil
	cleaned.SentimentLabel = nil
	cleaned.Entities = []Entity{}
	cleaned.KGRelations = []KGRelation{}
	cleaned.StageMeta = pipelineCloneStageMeta(cleaned.StageMeta)
	return cleaned
}

// cloneStageMeta shallow-copies a stage_meta object so the returned cleaned news
// no longer aliases the cleaner's output.
func pipelineCloneStageMeta(meta *StageMeta) *StageMeta {
	if meta == nil {
		return nil
	}
	copy := *meta
	return &copy
}

// pipelineScoreMarkdownForLLMCandidate is scoreMarkdownForLlmCandidate.
func pipelineScoreMarkdownForLLMCandidate(source, value string) float64 {
	trimmed := pipelineTrimJS(value)
	if trimmed == "" {
		return math.Inf(-1)
	}
	if isLikelyBotChallengeMarkdown(trimmed) {
		return -5000
	}
	words := pipelineCountWords(trimmed)
	headings := len(pipelineHeadingPattern.FindAllStringIndex(trimmed, -1))
	paragraphs := pipelineCountParagraphs(trimmed)
	markdownLinks := len(pipelineMarkdownLinkPattern.FindAllStringIndex(trimmed, -1))
	citations := len(pipelineCitationMarkerPattern.FindAllStringIndex(trimmed, -1))

	score := float64(pipelineMinInt(words, 12000)) +
		float64(headings)*8 +
		float64(pipelineMinInt(paragraphs, 200))*3 +
		float64(citations)*2 -
		float64(markdownLinks)*2
	switch source {
	case "citations":
		score += 30
	case "fit":
		score -= 80
	case "raw":
		score += 12
	}
	return score
}

// pipelineHasCitationMarkers is hasCitationMarkers.
func pipelineHasCitationMarkers(markdown string) bool {
	return pipelineCitationMarkerPattern.MatchString(markdown)
}

// pipelineHasCitationReferenceDefinitions is hasCitationReferenceDefinitions.
func pipelineHasCitationReferenceDefinitions(markdown string) bool {
	return pipelineCitationDefinitionPattern.MatchString(markdown)
}

// pipelineBuildMarkdownForLLM is buildMarkdownForLlm. The gate-rejected path
// only needs the selected markdown, but the full selection logic is ported so
// the value fed to the fallback summary is byte-equivalent.
func pipelineBuildMarkdownForLLM(article CrawledArticle, maxInputChars int) pipelineMarkdownForLLM {
	normalize := func(value *string) string {
		if value == nil {
			return ""
		}
		return pipelineTrimJS(*value)
	}

	primary := normalize(stringPointer(article.Markdown))
	citations := normalize(article.MarkdownWithCitations)
	raw := normalize(article.RawMarkdown)
	fit := normalize(article.FitMarkdown)
	references := normalize(article.ReferencesMarkdown)

	type candidate struct {
		source string
		value  string
	}
	candidates := make([]candidate, 0, 4)
	if primary != "" {
		candidates = append(candidates, candidate{source: "primary", value: primary})
	}
	if citations != "" {
		candidates = append(candidates, candidate{source: "citations", value: citations})
	}
	if raw != "" {
		candidates = append(candidates, candidate{source: "raw", value: raw})
	}
	if fit != "" {
		candidates = append(candidates, candidate{source: "fit", value: fit})
	}
	fallback := ""
	for _, value := range []string{primary, citations, raw, fit} {
		if value != "" {
			fallback = value
			break
		}
	}
	if fallback == "" {
		return pipelineMarkdownForLLM{Markdown: "", Source: "primary", Variant: "primary"}
	}

	scored := make([]candidate, len(candidates))
	copy(scored, candidates)
	sort.SliceStable(scored, func(left, right int) bool {
		return pipelineScoreMarkdownForLLMCandidate(scored[right].source, scored[right].value) <
			pipelineScoreMarkdownForLLMCandidate(scored[left].source, scored[left].value)
	})
	selected := scored[0]
	if pipelineIsChallengeCandidate(selected.value) {
		for _, entry := range scored {
			if !pipelineIsChallengeCandidate(entry.value) {
				selected = entry
				break
			}
		}
	}
	if selected.source == "fit" && raw != "" && !pipelineIsChallengeCandidate(raw) {
		rawLength := pipelineJSStringLength(raw)
		if rawLength >= 1600 && float64(pipelineJSStringLength(selected.value)) < float64(rawLength)*0.45 {
			selected = candidate{source: "raw", value: raw}
		}
	}

	merged := selected.value
	referencesAppended := false
	if references != "" && pipelineHasCitationMarkers(merged) && !pipelineHasCitationReferenceDefinitions(merged) {
		separator := "\n\n"
		if strings.HasSuffix(merged, "\n") {
			separator = "\n"
		}
		merged += separator + references
		referencesAppended = true
	}

	source := "primary"
	if selected.source == "citations" {
		source = "citations"
	}
	return pipelineMarkdownForLLM{
		Markdown:           pipelineSliceJS(merged, maxInputChars),
		Source:             source,
		Variant:            selected.source,
		ReferencesAppended: referencesAppended,
	}
}

// pipelineIsChallengeCandidate is isLikelyBotChallengeMarkdown, kept as a small
// wrapper so the port of buildMarkdownForLlm reads like the source.
func pipelineIsChallengeCandidate(value string) bool {
	return isLikelyBotChallengeMarkdown(value)
}

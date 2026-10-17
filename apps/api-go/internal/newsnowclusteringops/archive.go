// Archive rule-signal classifier port.
//
// Only the slice of apps/api/src/modules/archive/archive.classifier.ts that the
// domestic opinion index needs is ported: the rule scoring behind
// `classifyRuleSignals(input).ruleVertical`. Region resolution, country labels,
// anchors and the full per-vertical signal map are intentionally left out.
package newsnowclusteringops

import (
	"math"
	"strings"
)

// Archive rule-scoring constants, ported from
// apps/api/src/modules/archive/archive-classification.constants.ts.
const (
	// archiveRuleStrongScore is added once when a vertical matched a country.
	archiveRuleStrongScore = 1.0

	// archiveRuleStrongKeywordIncrement is added per matched strong keyword.
	archiveRuleStrongKeywordIncrement = 0.35

	// archiveRuleWeakKeywordIncrement is added per matched weak keyword.
	archiveRuleWeakKeywordIncrement = 0.18

	// archiveRuleExcludedKeywordPenalty is subtracted per excluded keyword.
	archiveRuleExcludedKeywordPenalty = 0.2

	// archiveRuleConflictKeywordPenalty is subtracted per conflict keyword.
	archiveRuleConflictKeywordPenalty = 0.25

	// archiveEntityTagLimit mirrors the collectEntityTags slice(0, 12).
	archiveEntityTagLimit = 12
)

// ruleArticleInput is the subset of ArchiveClassifierInput the domestic
// pipeline selector supplies. Nullable JS strings become plain Go strings, where
// the empty string is the null/undefined case.
type ruleArticleInput struct {
	Title    string
	Summary  string
	Location string
	Source   string
	Topics   []string
	Entities []newsSignalEntity
}

// ruleVerticalForArticle returns the archive rule vertical the NestJS
// ArchiveClassifier.classifyRuleSignals would choose for an article, i.e.
// exactly `classifyRuleSignals(input).ruleVertical`.
//
// The opinion index pipeline selector only asks whether the winner is
// ArchiveVerticalDomesticAffairs. The NestJS call site passes
// {title, summary, topics, entities, location} and leaves `source` undefined, so
// an empty `source` is dropped by buildSearchText just like the JS undefined.
//
// The helper methods hang off ruleArticleInput so this file contributes exactly
// one package-level entry point, ruleVerticalForArticle. The only other
// package-level function is clamp01Rounded6, which the task requires to stay
// separate from the opinion index clamp01.
func ruleVerticalForArticle(title, summary, location, source string, topics []string, entities []newsSignalEntity) ArchiveVertical {
	input := ruleArticleInput{
		Title:    title,
		Summary:  summary,
		Location: location,
		Source:   source,
		Topics:   topics,
		Entities: entities,
	}
	return input.resolveRuleVertical()
}

// resolveRuleVertical mirrors ArchiveClassifier.resolveRuleVertical, including
// the ARCHIVE_VERTICAL_ORDER tie-break and the FOREIGN_AFFAIRS default.
func (in ruleArticleInput) resolveRuleVertical() ArchiveVertical {
	text := in.buildSearchText()
	entityTags := in.collectEntityTags()
	countryCodes := in.resolveCountryCodes(entityTags)

	// tieBreakOrder reproduces TIE_BREAK_ORDER, falling back to "past the end"
	// exactly like Number.MAX_SAFE_INTEGER does in the JS version.
	tieBreakOrder := func(vertical ArchiveVertical) int {
		for index, candidate := range archiveVerticalKeys {
			if candidate == vertical {
				return index
			}
		}
		return len(archiveVerticalKeys)
	}

	bestVertical := ArchiveVerticalForeignAffairs
	bestScore := 0.0
	for _, vertical := range archiveVerticalKeys {
		score, _ := in.verticalScore(text, archiveVerticalTaxonomy[vertical], countryCodes)
		if score > bestScore {
			bestScore = score
			bestVertical = vertical
			continue
		}
		if score == bestScore && tieBreakOrder(vertical) < tieBreakOrder(bestVertical) {
			bestVertical = vertical
		}
	}

	if bestScore > 0 {
		return bestVertical
	}
	return ArchiveVerticalForeignAffairs
}

// verticalScore mirrors the per-vertical scoring loop of
// resolveVerticalRuleSignals. It returns the clamped score and whether a country
// code of the vertical matched.
func (in ruleArticleInput) verticalScore(text string, definition archiveVerticalDefinition, countryCodes []string) (float64, bool) {
	countrySet := make(map[string]struct{}, len(definition.Countries))
	for _, code := range definition.Countries {
		countrySet[code] = struct{}{}
	}

	matchedCountryCount := 0
	for _, code := range countryCodes {
		if _, ok := countrySet[code]; ok {
			matchedCountryCount++
		}
	}

	strongKeywords := len(in.collectKeywordMatches(text, definition.StrongKeywords))
	weakKeywords := len(in.collectKeywordMatches(text, definition.WeakKeywords))
	excludedKeywords := len(in.collectKeywordMatches(text, definition.ExcludedKeywords))
	conflictKeywords := len(in.collectKeywordMatches(text, definition.ConflictKeywords))

	// Accumulated in the same left-to-right order as the JS expression so the
	// floating-point result and the score equality tie-break stay identical.
	rawScore := 0.0
	if matchedCountryCount > 0 {
		rawScore += archiveRuleStrongScore
	}
	rawScore += float64(strongKeywords) * archiveRuleStrongKeywordIncrement
	rawScore += float64(weakKeywords) * archiveRuleWeakKeywordIncrement
	rawScore -= float64(excludedKeywords) * archiveRuleExcludedKeywordPenalty
	rawScore -= float64(conflictKeywords) * archiveRuleConflictKeywordPenalty

	return clamp01Rounded6(rawScore), matchedCountryCount > 0
}

// buildSearchText mirrors ArchiveClassifier.buildSearchText: the normalized
// title, summary, location, source, topics and entity names joined by newlines
// and lowercased.
func (in ruleArticleInput) buildSearchText() string {
	parts := make([]string, 0, 4+len(in.Topics)+len(in.Entities))
	for _, value := range [...]string{in.Title, in.Summary, in.Location, in.Source} {
		if normalized := in.normalizeOptionalString(value); normalized != "" {
			parts = append(parts, normalized)
		}
	}
	parts = append(parts, in.normalizeStringArray()...)
	parts = append(parts, in.normalizeEntityNames()...)
	return strings.ToLower(strings.Join(parts, "\n"))
}

// collectEntityTags mirrors ArchiveClassifier.collectEntityTags: topics followed
// by entity names, de-duplicated in order and capped at 12 entries.
func (in ruleArticleInput) collectEntityTags() []string {
	tags := make([]string, 0, len(in.Topics)+len(in.Entities))
	tags = append(tags, in.normalizeStringArray()...)
	tags = append(tags, in.normalizeEntityNames()...)

	unique := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		if _, exists := seen[tag]; exists {
			continue
		}
		seen[tag] = struct{}{}
		unique = append(unique, tag)
	}
	if len(unique) > archiveEntityTagLimit {
		unique = unique[:archiveEntityTagLimit]
	}
	return unique
}

// resolveCountryCodes mirrors ArchiveClassifier.resolveCountryCodes: the country
// codes extracted from location, title, summary and every entity tag, in that
// order and de-duplicated.
func (in ruleArticleInput) resolveCountryCodes(entityTags []string) []string {
	candidates := make([]string, 0, 3+len(entityTags))
	seen := make(map[string]struct{}, 3+len(entityTags))
	push := func(value string) {
		code := normalizeCountryCode(extractCountryCodeFromText(value))
		if code == "" {
			return
		}
		if _, exists := seen[code]; exists {
			return
		}
		seen[code] = struct{}{}
		candidates = append(candidates, code)
	}

	push(in.Location)
	push(in.Title)
	push(in.Summary)
	for _, tag := range entityTags {
		push(tag)
	}
	return candidates
}

// collectKeywordMatches mirrors ArchiveClassifier.collectKeywordMatches: the
// keywords whose trimmed lowercase form occurs in text, de-duplicated in order.
func (in ruleArticleInput) collectKeywordMatches(text string, keywords []string) []string {
	if text == "" {
		return []string{}
	}

	matches := make([]string, 0, len(keywords))
	seen := make(map[string]struct{}, len(keywords))
	for _, keyword := range keywords {
		normalized := strings.ToLower(strings.TrimSpace(keyword))
		if normalized == "" || !strings.Contains(text, normalized) {
			continue
		}
		if _, exists := seen[keyword]; exists {
			continue
		}
		seen[keyword] = struct{}{}
		matches = append(matches, keyword)
	}
	return matches
}

// normalizeStringArray mirrors ArchiveClassifier.normalizeStringArray: the
// trimmed, non-empty topic entries in their original order.
func (in ruleArticleInput) normalizeStringArray() []string {
	out := make([]string, 0, len(in.Topics))
	for _, entry := range in.Topics {
		if normalized := in.normalizeOptionalString(entry); normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

// normalizeEntityNames mirrors ArchiveClassifier.normalizeEntityNames for the
// typed entity model: the trimmed, non-empty names, de-duplicated in order.
func (in ruleArticleInput) normalizeEntityNames() []string {
	names := make([]string, 0, len(in.Entities))
	seen := make(map[string]struct{}, len(in.Entities))
	for _, entry := range in.Entities {
		name := in.normalizeOptionalString(entry.Name)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}

// normalizeOptionalString mirrors ArchiveClassifier.normalizeOptionalString: a
// trimmed string, or the empty string when nothing is left.
func (ruleArticleInput) normalizeOptionalString(value string) string {
	return strings.TrimSpace(value)
}

// clamp01Rounded6 is the archive classifier's clamp01: non-finite input becomes
// 0, otherwise the value is clamped to [0,1] and rounded to 6 decimals like
// Number(value.toFixed(6)). The opinion index keeps its own clamp01 rounded to 4
// decimals; the two are deliberately separate so each NestJS rounding is
// preserved.
func clamp01Rounded6(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value <= 0 {
		return 0
	}
	if value >= 1 {
		return 1
	}
	return math.Round(value*1e6) / 1e6
}

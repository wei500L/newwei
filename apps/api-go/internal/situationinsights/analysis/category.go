package analysis

import (
	"regexp"
	"strings"
)

// Classification sources mirror SituationMonitorCategoryClassificationSource.
const (
	ClassificationSourceTag                = "tag"
	ClassificationSourceResultCategory     = "result-category"
	ClassificationSourceResultCategoryPath = "result-category-path"
	ClassificationSourceResultTopics       = "result-topics"
	ClassificationSourceRawTags            = "raw-tags"
	ClassificationSourceHeuristic          = "heuristic"
)

// ClassificationInput is the typed projection of the fields the classifier
// reads from a ProcessedItem result document.
type ClassificationInput struct {
	Tags               []string
	ResultCategory     string
	CategoryConfidence *float64
	CategoryReason     string
	CategoryPath       string
	ResultTopics       []string
	RawTags            []string
	Title              string
	Summary            string
	Source             string
}

// ClassificationResult mirrors SituationMonitorCategoryClassificationResult.
type ClassificationResult struct {
	Category   Category
	Source     string
	Confidence *float64
	Reason     string
}

var categoryLabelMappings = []struct {
	pattern  *regexp.Regexp
	category Category
}{
	{regexp.MustCompile(`(?i)\b(ai|artificial intelligence|llm|gpt)\b`), CategoryAI},
	{regexp.MustCompile(`(?i)\b(intel|intelligence|osint|defense|military|security|cyber)\b`), CategoryIntel},
	{regexp.MustCompile(`(?i)\b(gov|government|policy|regulation|regulatory|agency)\b`), CategoryGov},
	{regexp.MustCompile(`(?i)\b(finance|financial|markets?|economy|economic|stocks?|equities?)\b`), CategoryFinance},
	{regexp.MustCompile(`(?i)\b(tech|technology|software|hardware|semiconductor|chips?)\b`), CategoryTech},
	{regexp.MustCompile(`(?i)\b(politics?|geopolitics?|diplomacy|election)\b`), CategoryPolitics},
}

var textRules = []struct {
	pattern  *regexp.Regexp
	category Category
}{
	{regexp.MustCompile(`(?i)\b(openai|anthropic|deepmind|chatgpt|gpt-?\d|llm|agi|artificial intelligence)\b`), CategoryAI},
	{regexp.MustCompile(`(?i)\b(federal reserve|fomc|sec\b|white house|congress|senate|supreme court|doj|treasury|regulation|regulatory)\b`), CategoryGov},
	{regexp.MustCompile(`(?i)\b(nasdaq|s&p|dow|earnings|bond|yield|inflation|cpi|gdp|recession|market|equity|stock|bitcoin|btc|ethereum|eth|crypto)\b`), CategoryFinance},
	{regexp.MustCompile(`(?i)\b(cyber|osint|pentagon|cia|nsa|fbi|defense|missile|airstrike|drone|munitions)\b`), CategoryIntel},
	{regexp.MustCompile(`(?i)\b(semiconductor|chip|apple|google|microsoft|meta|startup|cloud|software|hardware)\b`), CategoryTech},
	{regexp.MustCompile(`(?i)\b(election|campaign|parliament|sanction|ukraine|russia|israel|gaza|china|taiwan|iran|nato|ceasefire)\b`), CategoryPolitics},
}

// ClassifySituationMonitorCategory mirrors classifySituationMonitorCategory.
func ClassifySituationMonitorCategory(input ClassificationInput) ClassificationResult {
	if category, ok := extractCategoryFromTags(input.Tags); ok {
		return ClassificationResult{Category: category, Source: ClassificationSourceTag}
	}

	if input.ResultCategory != "" {
		if mapped, ok := mapLabelToCategory(input.ResultCategory); ok {
			return ClassificationResult{
				Category:   mapped,
				Source:     ClassificationSourceResultCategory,
				Confidence: input.CategoryConfidence,
				Reason:     input.CategoryReason,
			}
		}
	}

	if input.CategoryPath != "" {
		for _, part := range strings.Split(input.CategoryPath, "/") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if mapped, ok := mapLabelToCategory(part); ok {
				return ClassificationResult{
					Category:   mapped,
					Source:     ClassificationSourceResultCategoryPath,
					Confidence: input.CategoryConfidence,
					Reason:     input.CategoryReason,
				}
			}
		}
	}

	if category, ok := findFirstCategory(normalizeStringSlice(input.ResultTopics)); ok {
		return ClassificationResult{Category: category, Source: ClassificationSourceResultTopics}
	}
	if category, ok := findFirstCategory(normalizeStringSlice(input.RawTags)); ok {
		return ClassificationResult{Category: category, Source: ClassificationSourceRawTags}
	}

	text := strings.TrimSpace(input.Title + " " + input.Summary + " " + input.Source)
	if category, ok := classifyFromText(text); ok {
		confidence := 0.35
		return ClassificationResult{
			Category:   category,
			Source:     ClassificationSourceHeuristic,
			Confidence: &confidence,
			Reason:     "rule-heuristic",
		}
	}

	return ClassificationResult{}
}

// extractCategoryFromTags mirrors extractCategoryFromTags, including the
// first-valid-tag-wins rule.
func extractCategoryFromTags(tags []string) (Category, bool) {
	for _, tag := range tags {
		if !strings.HasPrefix(tag, "sm:") {
			continue
		}
		category := Category(strings.ToLower(strings.TrimSpace(strings.TrimPrefix(tag, "sm:"))))
		if category.valid() {
			return category, true
		}
	}
	return "", false
}

// mapLabelToCategory mirrors mapLabelToCategory.
func mapLabelToCategory(raw string) (Category, bool) {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	if normalized == "" {
		return "", false
	}
	category := Category(normalized)
	if category.valid() {
		return category, true
	}
	for _, mapping := range categoryLabelMappings {
		if mapping.pattern.MatchString(normalized) {
			return mapping.category, true
		}
	}
	return "", false
}

func findFirstCategory(values []string) (Category, bool) {
	for _, value := range values {
		if category, ok := mapLabelToCategory(value); ok {
			return category, true
		}
	}
	return "", false
}

func classifyFromText(text string) (Category, bool) {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return "", false
	}
	for _, rule := range textRules {
		if rule.pattern.MatchString(normalized) {
			return rule.category, true
		}
	}
	return "", false
}

// normalizeStringSlice trims strings and drops empty entries; it is the
// toStringArray helper used before every label lookup.
func normalizeStringSlice(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

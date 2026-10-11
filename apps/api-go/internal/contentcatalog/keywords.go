package contentcatalog

import (
	"regexp"
	"strings"
)

var (
	keywordCJK   = regexp.MustCompile(`[\x{3400}-\x{9fff}]{2,8}`)
	keywordLatin = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9.+-]{1,30}`)
	keywordASCII = regexp.MustCompile(`^[A-Za-z0-9.+-]+$`)
	keywordDigit = regexp.MustCompile(`\d`)
)

func extractKeywordTerms(result map[string]any) []string {
	if result == nil {
		return nil
	}
	terms := make([]string, 0, keywordMaxTermsPerDoc)
	seen := map[string]struct{}{}
	push := func(value any) {
		if len(terms) >= keywordMaxTermsPerDoc {
			return
		}
		term := normalizeKeywordTerm(value)
		if term == "" {
			return
		}
		key := strings.ToLower(term)
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		terms = append(terms, term)
	}
	pushText := func(value any) {
		text, ok := value.(string)
		if !ok {
			return
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		for _, match := range keywordCJK.FindAllString(text, -1) {
			push(match)
		}
		for _, match := range keywordLatin.FindAllString(text, -1) {
			push(match)
		}
	}
	for _, value := range unknownArray(result["topics"]) {
		push(value)
	}
	for _, value := range unknownArray(result["category_labels"]) {
		push(value)
	}
	for _, value := range unknownArray(result["entities"]) {
		if record, ok := value.(map[string]any); ok {
			push(record["name"])
		}
	}
	pushText(result["title"])
	pushText(result["headline"])
	pushText(result["subtitle"])
	pushText(result["summary"])
	pushText(result["abstract"])
	for _, value := range unknownArray(result["key_points"]) {
		pushText(value)
	}
	for _, value := range unknownArray(result["keyPoints"]) {
		pushText(value)
	}
	return terms
}

func normalizeKeywordTerm(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	display := cleanDisplay(text)
	if utf8Len(display) < 2 {
		return ""
	}
	key := strings.ToLower(display)
	if _, stop := keywordStopWords[key]; stop {
		return ""
	}
	if keywordASCII.MatchString(display) {
		if utf8Len(display) < 3 && !keywordDigit.MatchString(display) && key != "ai" {
			return ""
		}
	}
	return display
}

func utf8Len(value string) int {
	count := 0
	for range value {
		count++
	}
	return count
}

func unknownArray(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	case string:
		if typed == "" {
			return []any{typed}
		}
		return []any{typed}
	default:
		return nil
	}
}

func keywordMetadata() map[string]any {
	return map[string]any{"extractionSource": "text"}
}

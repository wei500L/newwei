package newspipeline

import "github.com/wei500L/newwei/apps/api-go/internal/archivereading"

// inferNewsContentTypeInput is the input of inferNewsContentType. Every text
// member follows the TypeScript optional/nullable convention: nil means the
// member was absent (or null).
type inferNewsContentTypeInput struct {
	Title   *string
	Summary *string
	Source  *string
	URL     *string
	Topics  []string
	Tags    []string
}

// normalizeNewsContentType ports normalizeNewsContentType. It sanitizes the
// token (trim, lowercase, whitespace -> "_", strip unsupported runes) and maps
// the alias table to one of news_fact/opinion/analysis/mixed. Unknown or empty
// input yields nil.
//
// The alias table itself already lives in internal/archivereading (the archive
// reading chain needed the same classification helpers), so this is a thin
// adapter instead of a second copy.
func normalizeNewsContentType(value *string) *string {
	if value == nil {
		return nil
	}
	normalized, ok := archivereading.NormalizeNewsContentTypeValue(*value)
	if !ok {
		return nil
	}
	return stringPointer(normalized)
}

// inferNewsContentType ports inferNewsContentType: URL hints and keyword scores
// decide the type, a score of two is required for a non-news_fact type and the
// fallback is always news_fact.
func inferNewsContentType(input inferNewsContentTypeInput) string {
	return archivereading.InferNewsContentTypeValue(
		stringOrEmpty(input.Title),
		stringOrEmpty(input.Summary),
		stringOrEmpty(input.Source),
		stringOrEmpty(input.URL),
		input.Topics,
		input.Tags,
	)
}

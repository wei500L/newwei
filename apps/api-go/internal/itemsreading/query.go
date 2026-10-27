package itemsreading

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// MaxPaginationOffset is the largest offset the database pagination layer
// accepts. It is the 31-bit signed integer ceiling, mirroring the IR2 policy.
const MaxPaginationOffset = 2_147_483_647

// ErrPaginationOffsetTooLarge is returned when (page-1)*pageSize leaves the
// supported range. The REST handler maps it to 400 with the exact message
// "Pagination offset is too large".
var ErrPaginationOffsetTooLarge = errors.New("Pagination offset is too large")

// ErrInvalidQueryParameter is returned when a REST query parameter does not
// satisfy the ListItemsDto contract. The handler maps it to the NestJS
// validation envelope (400 + "Bad Request").
var ErrInvalidQueryParameter = errors.New("invalid query parameter")

// Pagination is a normalized and range-checked page/pageSize/offset triple.
type Pagination struct {
	Page     int
	PageSize int
	Offset   int
}

// NormalizePagination mirrors ItemsListService.list for the interactive REST
// path: a non-finite pageSize falls back to 10 and is truncated; the page size
// is clamped to [1, cap] where cap = min(max(maxPageSize,1), 50000); a
// non-finite page falls back to 1 and is truncated with a lower bound of 1.
//
// IR2: the offset is validated before it is handed to SQL, the search recall
// or a cache loader. An out-of-range product fails with
// ErrPaginationOffsetTooLarge instead of wrapping, going negative or reaching
// the database.
func NormalizePagination(pageRaw, pageSizeRaw string, maxPageSize int) (Pagination, error) {
	cap := maxPageSize
	if cap <= 0 {
		cap = MaxCursorPageSize
	}
	if cap > 50_000 {
		cap = 50_000
	}
	if cap < 1 {
		cap = 1
	}

	pageSizeValue := 10.0
	if trimmed := strings.TrimSpace(pageSizeRaw); trimmed != "" {
		parsed, ok := parseJSNumber(trimmed)
		if !ok {
			return Pagination{}, ErrInvalidQueryParameter
		}
		pageSizeValue = parsed
	}
	normalizedPageSize := 10
	if isFinite(pageSizeValue) {
		normalizedPageSize = int(truncate(pageSizeValue))
	}
	take := normalizedPageSize
	if take < 1 {
		take = 1
	}
	if take > cap {
		take = cap
	}

	pageValue := 1.0
	if trimmed := strings.TrimSpace(pageRaw); trimmed != "" {
		parsed, ok := parseJSNumber(trimmed)
		if !ok {
			return Pagination{}, ErrInvalidQueryParameter
		}
		pageValue = parsed
	}
	normalizedPage := 1
	if isFinite(pageValue) {
		normalizedPage = int(truncate(pageValue))
	}
	safePage := normalizedPage
	if safePage < 1 {
		safePage = 1
	}

	offset, ok := checkedOffset(safePage, take)
	if !ok {
		return Pagination{}, ErrPaginationOffsetTooLarge
	}
	return Pagination{Page: safePage, PageSize: take, Offset: offset}, nil
}

// checkedOffset computes (page-1)*pageSize with overflow and range checks. It
// deliberately stays in int64 arithmetic so an enormous page number cannot
// wrap before the bound is applied.
func checkedOffset(page, pageSize int) (int, bool) {
	if page < 1 || pageSize < 1 {
		return 0, false
	}
	product := int64(page-1) * int64(pageSize)
	if product < 0 || product > int64(MaxPaginationOffset) {
		return 0, false
	}
	return int(product), true
}

// isNumericString reports whether a value satisfies validator.js isNumeric
// without the no_symbols option, which is what class-validator's
// @IsNumberString accepts: an optional sign, an optional decimal part, at least
// one digit, and no exponent, whitespace or empty string.
func isNumericString(value string) bool {
	if value == "" {
		return false
	}
	if value[0] == '+' || value[0] == '-' {
		value = value[1:]
	}
	if value == "" {
		return false
	}
	dot := strings.IndexByte(value, '.')
	if dot < 0 {
		for i := 0; i < len(value); i++ {
			if value[i] < '0' || value[i] > '9' {
				return false
			}
		}
		return true
	}
	intPart := value[:dot]
	fracPart := value[dot+1:]
	if strings.IndexByte(fracPart, '.') >= 0 {
		return false
	}
	for i := 0; i < len(intPart); i++ {
		if intPart[i] < '0' || intPart[i] > '9' {
			return false
		}
	}
	if fracPart == "" {
		return false
	}
	for i := 0; i < len(fracPart); i++ {
		if fracPart[i] < '0' || fracPart[i] > '9' {
			return false
		}
	}
	return true
}

// parseJSNumber parses an already valid numeric string using JavaScript
// Number() semantics.
func parseJSNumber(value string) (float64, bool) {
	if !isNumericString(value) {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func isFinite(value float64) bool {
	return !isNaN(value) && !isInf(value)
}

// parseQueryNumber validates a raw REST query parameter the way
// @IsNumberString plus Number() does.
func parseQueryNumber(value string) (float64, bool) {
	return parseJSNumber(strings.TrimSpace(value))
}

// parseTimeValue parses a date supplied by a GraphQL DateTime scalar or by the
// historical filters payload. JavaScript's Date constructor is far more
// permissive; the layouts below cover the ISO forms the API contracts use.
func parseTimeValue(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

// searchFiltersPrefix is the historical encoded filters envelope.
const searchFiltersPrefix = "__items_filters__:"

// ParseSearchPayload ports parseSearchPayload from items-search.helpers.ts. A
// payload that fails to decode falls back to treating the original normalized
// string as a plain search term, exactly like NestJS.
func ParseSearchPayload(search string) ParsedSearchPayload {
	normalized := strings.TrimSpace(search)
	if normalized == "" {
		return ParsedSearchPayload{}
	}
	if !strings.HasPrefix(normalized, searchFiltersPrefix) {
		return ParsedSearchPayload{Search: normalized}
	}
	payload := normalized[len(searchFiltersPrefix):]
	if payload == "" {
		return ParsedSearchPayload{}
	}
	decoded, err := url.PathUnescape(payload)
	if err != nil {
		return ParsedSearchPayload{Search: normalized}
	}
	var envelope struct {
		Q       json.RawMessage `json:"q"`
		Filters json.RawMessage `json:"filters"`
	}
	if err := json.Unmarshal([]byte(decoded), &envelope); err != nil {
		return ParsedSearchPayload{Search: normalized}
	}
	return ParsedSearchPayload{
		Search:  decodeEnvelopeQuery(envelope.Q),
		Filters: NormalizeFiltersJSON(envelope.Filters),
	}
}

// decodeEnvelopeQuery reads the `q` member: only a JSON string yields a search
// term, and a blank string yields none.
func decodeEnvelopeQuery(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// NormalizeFiltersJSON normalizes an untyped JSON filters object from the
// historical payload. A missing or non-object value yields nil.
func NormalizeFiltersJSON(raw json.RawMessage) *ItemFilters {
	if len(raw) == 0 {
		return nil
	}
	var record struct {
		SourceIDs         json.RawMessage `json:"sourceIds"`
		Regions           json.RawMessage `json:"regions"`
		Topics            json.RawMessage `json:"topics"`
		Sentiments        json.RawMessage `json:"sentiments"`
		ContentTypes      json.RawMessage `json:"contentTypes"`
		ExcludeDuplicates json.RawMessage `json:"excludeDuplicates"`
		DateRange         json.RawMessage `json:"dateRange"`
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil
	}
	filters := &ItemFilters{
		SourceIDs:    normalizeFilterList(record.SourceIDs, false),
		Regions:      normalizeFilterList(record.Regions, false),
		Topics:       normalizeFilterList(record.Topics, false),
		Sentiments:   normalizeFilterList(record.Sentiments, true),
		ContentTypes: normalizeFilterList(record.ContentTypes, true),
	}
	var exclude bool
	if len(record.ExcludeDuplicates) > 0 && json.Unmarshal(record.ExcludeDuplicates, &exclude) == nil {
		filters.ExcludeDuplicates = exclude
	}
	filters.DateRange = normalizeDateRangeJSON(record.DateRange)
	if !filters.Active() {
		return nil
	}
	return filters
}

// normalizeFilterList trims, drops blanks, optionally lowercases, and dedupes
// while preserving the first occurrence order.
func normalizeFilterList(raw json.RawMessage, lowerCase bool) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, entry := range values {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if lowerCase {
			trimmed = strings.ToLower(trimmed)
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeDateRangeJSON reads the historical payload's dateRange member.
func normalizeDateRangeJSON(raw json.RawMessage) *ItemDateRangeFilter {
	if len(raw) == 0 {
		return nil
	}
	var record struct {
		Start *string `json:"start"`
		End   *string `json:"end"`
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil
	}
	var start, end *time.Time
	if record.Start != nil {
		if parsed, ok := parseTimeValue(*record.Start); ok {
			start = &parsed
		}
	}
	if record.End != nil {
		if parsed, ok := parseTimeValue(*record.End); ok {
			end = &parsed
		}
	}
	if start == nil && end == nil {
		return nil
	}
	return &ItemDateRangeFilter{Start: start, End: end}
}

// NormalizeFilters applies the same normalization to an already typed filter
// set coming from a GraphQL input object.
func NormalizeFilters(filters *ItemFilters) *ItemFilters {
	if filters == nil {
		return nil
	}
	normalized := &ItemFilters{
		SourceIDs:         normalizeTypedList(filters.SourceIDs, false),
		Regions:           normalizeTypedList(filters.Regions, false),
		Topics:            normalizeTypedList(filters.Topics, false),
		Sentiments:        normalizeTypedList(filters.Sentiments, true),
		ContentTypes:      normalizeTypedList(filters.ContentTypes, true),
		ExcludeDuplicates: filters.ExcludeDuplicates,
		DateRange:         cloneDateRange(filters.DateRange),
	}
	if !normalized.Active() {
		return nil
	}
	return normalized
}

func normalizeTypedList(values []string, lowerCase bool) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, entry := range values {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if lowerCase {
			trimmed = strings.ToLower(trimmed)
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func cloneDateRange(value *ItemDateRangeFilter) *ItemDateRangeFilter {
	if value == nil {
		return nil
	}
	if value.Start == nil && value.End == nil {
		return nil
	}
	return &ItemDateRangeFilter{Start: value.Start, End: value.End}
}

// TokenizeSearch ports tokenizeSearch: split on whitespace, strip the boolean
// full-text operators, and keep tokens at least minLength long.
func TokenizeSearch(search string, minLength int) []string {
	fields := strings.Fields(search)
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		token := strings.Map(func(r rune) rune {
			switch r {
			case '+', '-', '>', '<', '(', ')', '~', '"', '*', '@':
				return -1
			default:
				return r
			}
		}, field)
		if len([]rune(token)) >= minLength {
			out = append(out, token)
		}
	}
	return out
}

// BuildFullTextQuery ports buildFullTextQuery (MySQL BOOLEAN MODE).
func BuildFullTextQuery(search string) (string, bool) {
	tokens := TokenizeSearch(search, FullTextMinTokenLength)
	if len(tokens) == 0 {
		return "", false
	}
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		parts = append(parts, token+"*")
	}
	return strings.Join(parts, " "), true
}

// BuildMongoTextSearchQuery ports buildMongoTextSearchQuery.
func BuildMongoTextSearchQuery(search string) (string, bool) {
	tokens := TokenizeSearch(search, FullTextMinTokenLength)
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		trimmed := strings.TrimRight(token, "*")
		trimmed = strings.TrimSpace(trimmed)
		if len([]rune(trimmed)) < FullTextMinTokenLength {
			continue
		}
		parts = append(parts, trimmed)
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, " "), true
}

// regexEscapeSpecial matches the character set escapeRegex replaces in
// items-search.helpers.ts.
var regexEscapeSpecial = regexp.MustCompile(`[.*+?^${}()|\[\]\\]`)

// EscapeRegex ports escapeRegex exactly (JavaScript's special set, not Go's
// wider regexp.QuoteMeta set).
func EscapeRegex(value string) string {
	return regexEscapeSpecial.ReplaceAllString(value, `\$0`)
}

// incrementFacetCount adds one to a trimmed, non-empty facet value.
func incrementFacetCount(target map[string]int, value string) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return
	}
	target[trimmed]++
}

// buildFacetOptions ports buildFacetOptions: count DESC, then localeCompare,
// capped at MaxFacetOptions.
func buildFacetOptions(target map[string]int) []FacetOption {
	options := make([]FacetOption, 0, len(target))
	for value, count := range target {
		options = append(options, FacetOption{Value: value, Count: count})
	}
	sort.SliceStable(options, func(i, j int) bool {
		if options[i].Count != options[j].Count {
			return options[i].Count > options[j].Count
		}
		return localeCompare(options[i].Value, options[j].Value) < 0
	})
	if len(options) > MaxFacetOptions {
		options = options[:MaxFacetOptions]
	}
	return options
}

// facetValueCollator is the ICU root collator used for the localeCompare
// tie-breaks below. It is the same root UCA collation that
// internal/newsnowhottest, internal/newssourcescheduler and
// internal/newspipeline use for String.prototype.localeCompare; one shared value
// guarded by a mutex avoids rebuilding the collation tables per comparison
// (collate.Collator is not safe for concurrent use).
var (
	facetValueCollatorMu sync.Mutex
	facetValueCollator   = collate.New(language.Und)
)

// localeCompare is a.localeCompare(b) under the default ICU root collation.
//
// NestJS orders every facet, suggestion, candidate and source list with
// String.prototype.localeCompare, which is not byte order: punctuation, case and
// non-ASCII text collate by UCA primary/secondary/tertiary weights. Comparing
// the raw or lower-cased bytes would order e.g. "a-b" versus "ab" and "A" versus
// "a" differently, so the sort keys would diverge from NestJS on the same rows.
func localeCompare(left, right string) int {
	if left == right {
		return 0
	}
	facetValueCollatorMu.Lock()
	defer facetValueCollatorMu.Unlock()
	return facetValueCollator.CompareString(left, right)
}

// DedupeItemMetaIDs ports dedupeItemMetaIds: trim, drop blanks, preserve the
// first occurrence order.
func DedupeItemMetaIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// nonEmptyString trims and reports whether a string has content.
func nonEmptyString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

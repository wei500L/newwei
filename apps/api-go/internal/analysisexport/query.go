// Package analysisexport serves POST /api/analysis/exports/items and
// POST /api/analysis/exports/events: the two CSV downloads that used to run in
// the NestJS AnalysisWorkspaceController.
//
// Both routes take only the optional ExportAnalysisQueryDto.queryString, derive
// the organization and user from the verified identity, and answer 201 with a
// text/csv attachment. The candidate selection and ranking are reused from
// itemsreading and newsevents through narrow typed ports; the CSV byte contract
// (LF separators, UTF-8 without BOM, no trailing newline, formula guard) lives
// here. POST /api/analysis/exports/search stays on NestJS because its headlines
// mode prepares archive digests, so any method or path outside these two exact
// routes is still proxied.
package analysisexport

import (
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// The events window parameter follows Number.parseInt: the default is 30 days
// and the upper clamp is 365, exactly like parsePositiveInt in
// analysis-workspace.service.ts.
const (
	defaultEventsWindowDays = 30
	maxEventsWindowDays     = 365
)

// queryPair is one decoded URLSearchParams entry.
type queryPair struct {
	key   string
	value string
}

// queryParams is an ordered view of the normalized export query string. Order
// and duplicates are preserved: every single-valued parameter takes the first
// occurrence while the item filters read repeated keys with all occurrences,
// and a comma inside a value is never split into several filter values.
type queryParams struct {
	pairs []queryPair
}

// parseQueryParams decodes an already-normalized query string. Empty segments
// are skipped the same way URLSearchParams ignores them.
func parseQueryParams(raw string) queryParams {
	if raw == "" {
		return queryParams{}
	}
	parts := strings.Split(raw, "&")
	pairs := make([]queryPair, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		pairs = append(pairs, queryPair{key: formDecode(key), value: formDecode(value)})
	}
	return queryParams{pairs: pairs}
}

// formDecode decodes one application/x-www-form-urlencoded component, the
// format URLSearchParams and analysiscollab.NormalizeQueryString share
// ("+" is a space).
func formDecode(value string) string {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

// first returns the first value of key, or "" when the key is absent.
func (p queryParams) first(key string) string {
	for _, pair := range p.pairs {
		if pair.key == key {
			return pair.value
		}
	}
	return ""
}

// all returns every value of key in order.
func (p queryParams) all(key string) []string {
	out := make([]string, 0, 1)
	for _, pair := range p.pairs {
		if pair.key == key {
			out = append(out, pair.value)
		}
	}
	return out
}

// allTrimmed returns the trimmed non-empty values of key.
func (p queryParams) allTrimmed(key string) []string {
	values := p.all(key)
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

// optional returns the trimmed non-empty value of key, or nil.
func (p queryParams) optional(key string) *string {
	trimmed := strings.TrimSpace(p.first(key))
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// token returns the trimmed lowercased value of key.
func (p queryParams) token(key string) string {
	return strings.ToLower(strings.TrimSpace(p.first(key)))
}

// itemsExportParams is the parsed items query string.
type itemsExportParams struct {
	search  string
	orderBy itemsreading.ItemsListOrderBy
	ranking itemsreading.ItemsRankingMode
	filters *itemsreading.ItemFilters
}

// parseItemsParams ports parseItemsOrderBy / parseItemsRankingMode /
// parseItemsFilters. It only reads the parameters the source reads; no filter
// is invented from the web console's other query keys.
func parseItemsParams(params queryParams) itemsExportParams {
	search := ""
	if value := params.optional("q"); value != nil {
		search = *value
	}

	orderBy := itemsreading.ItemsListOrderCreatedDesc
	switch params.token("order") {
	case "published":
		orderBy = itemsreading.ItemsListOrderPublishedDesc
	case "personalized":
		orderBy = itemsreading.ItemsListOrderPersonalized
	}

	// parseItemsRankingMode: without a search term the mode is RECENCY, and
	// with one RELEVANCE wins unless the caller explicitly asked for recency.
	// ItemsListService.list still downgrades RELEVANCE to RECENCY when the
	// decoded search term is blank.
	ranking := itemsreading.ItemsRankingRecency
	if search != "" {
		ranking = itemsreading.ItemsRankingRelevance
		if params.token("ranking") == "recency" {
			ranking = itemsreading.ItemsRankingRecency
		}
	}

	return itemsExportParams{
		search:  search,
		orderBy: orderBy,
		ranking: ranking,
		filters: parseItemsFilters(params),
	}
}

// parseItemsFilters ports parseItemsFilters: repeated region/topic/sentiment/
// contentType keys keep every trimmed non-empty value, from/to are parsed as
// dates and invalid values are ignored, and dedup recognises hide/1/true.
func parseItemsFilters(params queryParams) *itemsreading.ItemFilters {
	filters := &itemsreading.ItemFilters{
		Regions:      params.allTrimmed("region"),
		Topics:       params.allTrimmed("topic"),
		Sentiments:   params.allTrimmed("sentiment"),
		ContentTypes: params.allTrimmed("contentType"),
	}

	switch params.token("dedup") {
	case "hide", "1", "true":
		filters.ExcludeDuplicates = true
	}

	var from, to *time.Time
	if value := params.optional("from"); value != nil {
		if parsed, ok := itemsreading.ParseTimeValue(*value); ok {
			from = &parsed
		}
	}
	if value := params.optional("to"); value != nil {
		if parsed, ok := itemsreading.ParseTimeValue(*value); ok {
			to = &parsed
		}
	}
	if from != nil || to != nil {
		filters.DateRange = &itemsreading.ItemDateRangeFilter{Start: from, End: to}
	}
	return filters
}

// parseEventsParams ports the events filter parsing. window uses JavaScript
// parseInt semantics, entity is only trimmed, and the two score floors accept
// finite non-negative values as parseFloat would.
func parseEventsParams(params queryParams) newsevents.ExportQuery {
	query := newsevents.ExportQuery{
		WindowDays:          parsePositiveInt(params.first("window"), defaultEventsWindowDays, maxEventsWindowDays),
		Entity:              "",
		Sort:                "latest",
		SourceType:          "all",
		MinHeatScore:        parseNonNegativeFloat(params.first("minHeat")),
		MinCredibilityScore: parseNonNegativeFloat(params.first("minCredibility")),
	}
	switch params.token("status") {
	case "active", "archived":
		query.Status = params.token("status")
	}
	if entity := params.optional("entity"); entity != nil {
		query.Entity = *entity
	}
	switch params.token("sort") {
	case "heat", "credibility":
		query.Sort = params.token("sort")
	}
	switch params.token("sourceType") {
	case "authoritative", "mixed", "blog", "unknown":
		query.SourceType = params.token("sourceType")
	}
	return query
}

// parsePositiveInt ports parsePositiveInt: parseInt semantics, a non-finite or
// sub-one value falls back, and the result is clamped to max.
func parsePositiveInt(raw string, fallback, max int) int {
	parsed, ok := jsParseInt(raw)
	if !ok || parsed < 1 {
		return fallback
	}
	if parsed > max {
		return max
	}
	return parsed
}

// parseNonNegativeFloat ports parseNonNegativeFloat: parseFloat semantics, a
// non-finite or negative value is ignored.
func parseNonNegativeFloat(raw string) *float64 {
	parsed, ok := jsParseFloat(raw)
	if !ok || parsed < 0 {
		return nil
	}
	return &parsed
}

// jsWhitespace matches the JavaScript \s set so parseInt/parseFloat skip
// exactly the leading characters the source skips.
const jsWhitespace = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// jsParseInt mirrors Number.parseInt(value, 10): leading whitespace and an
// optional sign are skipped, then the longest decimal digit run is read
// ("10abc" -> 10, "1e3" -> 1, "+2" -> 2). A value without digits or one that
// overflows int is reported as not parseable, which callers treat as the
// fallback.
func jsParseInt(value string) (int, bool) {
	text := strings.TrimLeft(value, jsWhitespace)
	index := 0
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		index++
	}
	start := index
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
	}
	if index == start {
		return 0, false
	}
	parsed, err := strconv.Atoi(text[:index])
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// jsParseFloat mirrors Number.parseFloat: leading whitespace is skipped and the
// longest parseable prefix is read ("12abc" -> 12, "1e3" -> 1000). Not-a-number
// and non-finite values are reported as not parseable.
func jsParseFloat(value string) (float64, bool) {
	text := strings.TrimLeft(value, jsWhitespace)
	index := 0
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		index++
	}
	digits := 0
	dot := false
	for index < len(text) {
		ch := text[index]
		if ch >= '0' && ch <= '9' {
			digits++
			index++
			continue
		}
		if ch == '.' && !dot {
			dot = true
			index++
			continue
		}
		if (ch == 'e' || ch == 'E') && digits > 0 {
			exponent := index + 1
			if exponent < len(text) && (text[exponent] == '+' || text[exponent] == '-') {
				exponent++
			}
			expDigits := exponent
			for expDigits < len(text) && text[expDigits] >= '0' && text[expDigits] <= '9' {
				expDigits++
			}
			if expDigits > exponent {
				index = expDigits
			}
		}
		break
	}
	if digits == 0 {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(text[:index], 64)
	if err != nil {
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

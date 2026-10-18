package itemsreading

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
)

// This file holds the GraphQL items list contract: the cursor codec, the named
// order/ranking enums and the connection row types. The algorithm lives in
// listtime.go, relevance.go and personalized.go. The REST List contract stays on
// its own ItemsOrderBy type so PERSONALIZED can never leak into GET /api/items.

// ItemsListOrderBy is the GraphQL items(orderBy:) contract. It is a distinct
// type from ItemsOrderBy on purpose: the REST switch only accepts the first two
// values.
type ItemsListOrderBy string

const (
	// ItemsListOrderCreatedDesc orders by createdAt DESC, id DESC.
	ItemsListOrderCreatedDesc ItemsListOrderBy = "CREATED_DESC"
	// ItemsListOrderPublishedDesc orders by sortAt DESC, id DESC. sortAt is the
	// dedicated publish-time sort column; publishedAt remains an output-only
	// field and is never used to order rows.
	ItemsListOrderPublishedDesc ItemsListOrderBy = "PUBLISHED_DESC"
	// ItemsListOrderPersonalized orders by the per-user behavior profile score.
	ItemsListOrderPersonalized ItemsListOrderBy = "PERSONALIZED"
)

// ItemsRankingMode is the GraphQL items(rankingMode:) contract.
type ItemsRankingMode string

const (
	// ItemsRankingRecency keeps the natural time ordering.
	ItemsRankingRecency ItemsRankingMode = "RECENCY"
	// ItemsRankingRelevance re-ranks the recalled candidate set by relevance.
	ItemsRankingRelevance ItemsRankingMode = "RELEVANCE"
)

// ItemsCursorPayload is the decoded items connection cursor. The shape depends
// on the active ordering, exactly like the NestJS resolver: the time orderings
// carry the composite (time, id) boundary, while RELEVANCE and PERSONALIZED
// carry the rank offset plus the id used to relocate the window when the
// candidate set shifted between requests.
type ItemsCursorPayload struct {
	ID        string
	CreatedAt *string
	SortAt    *string
	Offset    *int
}

// EncodeItemsCursor renders a cursor as base64(JSON), the format the NestJS
// resolver writes with Buffer.from(JSON.stringify(value)).toString("base64").
func EncodeItemsCursor(payload ItemsCursorPayload) string {
	encoded, err := json.Marshal(struct {
		ID        string  `json:"id"`
		CreatedAt *string `json:"createdAt,omitempty"`
		SortAt    *string `json:"sortAt,omitempty"`
		Offset    *int    `json:"offset,omitempty"`
	}{
		ID:        payload.ID,
		CreatedAt: payload.CreatedAt,
		SortAt:    payload.SortAt,
		Offset:    payload.Offset,
	})
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(encoded)
}

// DecodeItemsCursor ports decodeCursor. A cursor that is absent, empty or not
// decodable yields nil, which callers treat as "start from the beginning"
// exactly like NestJS; an invalid cursor is deliberately not a 400.
//
// Two shapes are accepted: the JSON object written by EncodeItemsCursor and the
// legacy bare base64(id) cursor, whose decoded text does not start with "{".
func DecodeItemsCursor(cursor *string) *ItemsCursorPayload {
	if cursor == nil {
		return nil
	}
	raw := strings.TrimSpace(*cursor)
	if raw == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(decoded) == 0 {
		return nil
	}
	text := string(decoded)
	if text == "" {
		return nil
	}
	if !strings.HasPrefix(text, "{") {
		return &ItemsCursorPayload{ID: text}
	}
	var record struct {
		ID        *string  `json:"id"`
		CreatedAt *string  `json:"createdAt"`
		SortAt    *string  `json:"sortAt"`
		Offset    *float64 `json:"offset"`
	}
	if err := json.Unmarshal(decoded, &record); err != nil {
		return nil
	}
	if record.ID == nil || strings.TrimSpace(*record.ID) == "" {
		return nil
	}
	payload := &ItemsCursorPayload{ID: *record.ID, CreatedAt: record.CreatedAt, SortAt: record.SortAt}
	if record.Offset != nil && isFinite(*record.Offset) {
		offset := int(truncate(*record.Offset))
		payload.Offset = &offset
	}
	return payload
}

// ItemsListQuery is the fully typed GraphQL items(args:) input.
type ItemsListQuery struct {
	// First is the requested page size; the SDL default (10) is applied by the
	// executor. The business cap is MaxCursorPageSize.
	First int
	// After is the raw cursor argument.
	After *string
	// Page is the 1-based page argument. After and Page are mutually exclusive;
	// the resolver rejects the combination before this struct is built.
	Page *int
	// Search is the raw search argument, possibly a historical
	// __items_filters__ payload.
	Search *string
	// Filters is the decoded ItemsFiltersInput.
	Filters *ItemFilters
	// FiltersPresent distinguishes an explicit filters object (including {})
	// from an omitted or null one. An explicit object wins over the filters
	// embedded in a historical search payload; null/omitted falls back to them.
	FiltersPresent bool
	// OrderBy defaults to CREATED_DESC.
	OrderBy ItemsListOrderBy
	// RankingMode defaults to RELEVANCE when search is non-blank. The resolver
	// picks that default from the raw search argument before the historical
	// payload is decoded, so a payload carrying only old filters still ranks by
	// recency.
	RankingMode ItemsRankingMode
	// IncludeTotalCount is true when the operation selects totalCount. The time
	// orderings skip their COUNT when it is false; RELEVANCE and PERSONALIZED
	// always compute their candidate count because hasNextPage depends on it.
	IncludeTotalCount bool
}

// ItemListEdge is one connection edge before the GraphQL adapter projects it.
// SearchHighlights is nil when the page had no highlights for the row.
type ItemListEdge struct {
	Cursor           string
	Row              ItemMetaRow
	RelevanceScore   *float64
	RankOffset       *int
	SearchHighlights map[string][]string
}

// ItemConnectionResult is the items connection payload.
type ItemConnectionResult struct {
	Edges       []ItemListEdge
	HasNextPage bool
	EndCursor   *string
	TotalCount  int
}

// rankedEdge carries the ranking-side fields of one row.
type rankedEdge struct {
	RelevanceScore   *float64
	RankOffset       *int
	SearchHighlights map[string][]string
}

// pageRows is one resolved page: the rows in display order plus the ranking
// extras keyed by item id.
type pageRows struct {
	rows  []ItemMetaRow
	extra map[string]rankedEdge
	total int
}

// emptyConnection builds the contract-shaped empty page: edges is a non-nil
// empty slice, endCursor is null and hasNextPage is false.
func emptyConnection(totalCount int) ItemConnectionResult {
	return ItemConnectionResult{Edges: []ItemListEdge{}, HasNextPage: false, EndCursor: nil, TotalCount: totalCount}
}

// finishConnection fills endCursor from the last edge.
func finishConnection(result ItemConnectionResult) ItemConnectionResult {
	if len(result.Edges) == 0 {
		result.EndCursor = nil
		return result
	}
	cursor := result.Edges[len(result.Edges)-1].Cursor
	result.EndCursor = &cursor
	return result
}

// ListItems ports the resolver's items root. It resolves the effective filters
// (an explicit GraphQL filters object wins over the historical search payload),
// the effective ranking mode (RELEVANCE only when the decoded search term is
// non-blank), and then dispatches to the page or cursor branch.
func (s *Service) ListItems(ctx context.Context, orgID string, userID string, query ItemsListQuery) (ItemConnectionResult, error) {
	orderBy := query.OrderBy
	switch orderBy {
	case ItemsListOrderPublishedDesc, ItemsListOrderPersonalized, ItemsListOrderCreatedDesc:
	default:
		orderBy = ItemsListOrderCreatedDesc
	}

	take := ClampInt(query.First, 1, MaxCursorPageSize)
	parsed := ParseSearchPayload(derefString(query.Search))
	effectiveFilters := resolveListFilters(parsed, query.Filters, query.FiltersPresent)

	scopedIDs, restricted, err := s.search.ResolveScopedIDs(ctx, orgID, parsed.Search, effectiveFilters)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	effectiveRanking := resolveListRankingMode(query.RankingMode, parsed.Search)
	if restricted && len(scopedIDs) == 0 {
		return emptyConnection(0), nil
	}

	args := listArgs{
		orderBy:  orderBy,
		ranking:  effectiveRanking,
		search:   parsed.Search,
		scoped:   scopedIDs,
		scopedOK: restricted,
		take:     take,
	}
	if query.Page != nil {
		return s.listItemsPage(ctx, orgID, userID, args, *query.Page)
	}
	return s.listItemsCursor(ctx, orgID, userID, args, DecodeItemsCursor(query.After), query.IncludeTotalCount)
}

// resolveListFilters selects the effective filter set of the items root. An
// explicit GraphQL filters object — including {} — wins over the filters
// embedded in a historical search payload, because the caller stated its filters
// explicitly; a null or omitted filters argument falls back to the payload.
// NormalizeFilters collapses {} to nil, so an explicit empty object means "no
// filters" rather than "reuse the old ones".
func resolveListFilters(parsed ParsedSearchPayload, filters *ItemFilters, filtersPresent bool) *ItemFilters {
	if filtersPresent {
		return NormalizeFilters(filters)
	}
	return parsed.Filters
}

// listArgs carries the resolved inputs shared by the page and cursor branches.
type listArgs struct {
	orderBy ItemsListOrderBy
	ranking ItemsRankingMode
	search  string
	// scoped is the restricted candidate id set; scopedOK distinguishes "no
	// restriction" (false) from a restricted, possibly empty, set (true).
	scoped   []string
	scopedOK bool
	take     int
}

// listItemsPage ports the page branch of ItemsListService.list.
func (s *Service) listItemsPage(ctx context.Context, orgID string, userID string, args listArgs, page int) (ItemConnectionResult, error) {
	safePage := page
	if safePage < 1 {
		safePage = 1
	}
	// IR2: the offset is validated before any search, cache or database call so
	// an out-of-range product fails with the same message as NestJS instead of
	// wrapping into a negative skip.
	offset, ok := checkedOffset(safePage, args.take)
	if !ok {
		return ItemConnectionResult{}, ErrPaginationOffsetTooLarge
	}

	var (
		page1 pageRows
		err   error
	)
	switch {
	case args.ranking == ItemsRankingRelevance && args.search != "" && args.scopedOK:
		page1, err = s.relevancePage(ctx, orgID, args, offset)
	case args.orderBy == ItemsListOrderPersonalized && userID != "":
		page1, err = s.personalizedPage(ctx, orgID, userID, args, offset)
	default:
		page1, err = s.timeOrderedPage(ctx, orgID, args, offset)
	}
	if err != nil {
		return ItemConnectionResult{}, err
	}

	edges := make([]ItemListEdge, 0, len(page1.rows))
	for index, row := range page1.rows {
		rankOffset := offset + index
		edge := ItemListEdge{Row: row, Cursor: encodeRowCursor(args.ranking, args.orderBy, row, &rankOffset)}
		if extras, ok := page1.extra[row.ID]; ok {
			edge.RelevanceScore = extras.RelevanceScore
			edge.RankOffset = extras.RankOffset
			edge.SearchHighlights = extras.SearchHighlights
		}
		edges = append(edges, edge)
	}
	result := ItemConnectionResult{Edges: edges, HasNextPage: safePage*args.take < page1.total, TotalCount: page1.total}
	return finishConnection(result), nil
}

// listItemsCursor ports the cursor branch of ItemsListService.listWithCursor.
func (s *Service) listItemsCursor(
	ctx context.Context,
	orgID string,
	userID string,
	args listArgs,
	cursor *ItemsCursorPayload,
	includeTotalCount bool,
) (ItemConnectionResult, error) {
	switch {
	case args.ranking == ItemsRankingRelevance && args.search != "" && args.scopedOK:
		return s.relevanceCursor(ctx, orgID, args, cursor)
	case args.orderBy == ItemsListOrderPersonalized && userID != "":
		return s.personalizedCursor(ctx, orgID, userID, args, cursor)
	default:
		return s.timeOrderedCursor(ctx, orgID, args, cursor, includeTotalCount)
	}
}

// encodeRowCursor encodes the per-row cursor for the active ordering.
//
// RELEVANCE and PERSONALIZED cursors carry the rank offset plus the id: the id
// lets a later request relocate the window when the candidate set changed, and
// the offset is the fallback. The two orderings are encoded with the same shape
// but consumed by different relocation rules, so they are never merged.
func encodeRowCursor(ranking ItemsRankingMode, orderBy ItemsListOrderBy, row ItemMetaRow, rankOffset *int) string {
	if ranking == ItemsRankingRelevance || orderBy == ItemsListOrderPersonalized {
		payload := ItemsCursorPayload{ID: row.ID}
		if rankOffset != nil {
			offset := *rankOffset
			payload.Offset = &offset
		}
		return EncodeItemsCursor(payload)
	}
	if orderBy == ItemsListOrderPublishedDesc {
		value := FormatISOTime(row.SortAt.Time)
		return EncodeItemsCursor(ItemsCursorPayload{ID: row.ID, SortAt: &value})
	}
	value := FormatISOTime(row.CreatedAt.Time)
	return EncodeItemsCursor(ItemsCursorPayload{ID: row.ID, CreatedAt: &value})
}

// resolveListRankingMode ports resolveRankingMode: RELEVANCE is honoured only
// when the decoded search term is non-blank.
func resolveListRankingMode(mode ItemsRankingMode, search string) ItemsRankingMode {
	if mode == ItemsRankingRelevance && strings.TrimSpace(search) != "" {
		return ItemsRankingRelevance
	}
	return ItemsRankingRecency
}

// derefString unwraps an optional string argument.
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

package itemsreading

import (
	"context"
	"time"
)

// This file implements the CREATED_DESC / PUBLISHED_DESC branches: the
// page/offset path and the composite (time, id) cursor path, for both
// ITEMS_READ_MODEL_ENABLED modes.

// timeOrderedPage ports the read-model and Prisma page branches: an offset page
// ordered by createdAt or sortAt with the id as tie-break, plus the full count.
func (s *Service) timeOrderedPage(ctx context.Context, orgID string, args listArgs, offset int) (pageRows, error) {
	orderBy := timeOrderValue(args.orderBy)
	candidates := scopedCandidates(args)

	if s.readModelEnabled {
		docs, err := s.mongo.ListReadModelMetaRows(ctx, orgID, candidates, orderBy, offset, args.take)
		if err != nil {
			return pageRows{}, err
		}
		total, err := s.mongo.CountReadModelMetaRows(ctx, orgID, candidates)
		if err != nil {
			return pageRows{}, err
		}
		rows := make([]ItemMetaRow, 0, len(docs))
		for _, doc := range docs {
			rows = append(rows, ItemMetaRowFromReadModel(doc))
		}
		return pageRows{rows: rows, total: total}, nil
	}

	rows, err := s.mysql.ListItemMeta(ctx, orgID, candidates, orderBy, offset, args.take)
	if err != nil {
		return pageRows{}, err
	}
	total, err := s.mysql.CountItemMeta(ctx, orgID, candidates)
	if err != nil {
		return pageRows{}, err
	}
	return pageRows{rows: rows, total: total}, nil
}

// timeOrderedCursor ports the read-model and Prisma cursor branches.
//
// The time orderings page on the composite (time, id) boundary and fetch
// take+1 rows to decide hasNextPage; a plain offset would repeat or skip rows
// whenever several rows share a timestamp. A cursor whose timestamp is missing
// is resolved through an organization-scoped lookup of the cursor row, and a
// missing row returns the empty page instead of silently restarting at the
// first page.
func (s *Service) timeOrderedCursor(
	ctx context.Context,
	orgID string,
	args listArgs,
	cursor *ItemsCursorPayload,
	includeTotalCount bool,
) (ItemConnectionResult, error) {
	orderBy := timeOrderValue(args.orderBy)
	cursorID := ""
	if cursor != nil {
		cursorID = cursor.ID
	}

	if s.readModelEnabled {
		if args.scopedOK && cursorID != "" && !stringInSlice(args.scoped, cursorID) {
			// The cursor points outside the restricted candidate set: there is
			// no further page. The read-model branch gates the reported total on
			// the selected totalCount, unlike the Prisma branch.
			if includeTotalCount {
				return emptyConnection(len(args.scoped)), nil
			}
			return emptyConnection(0), nil
		}
		return s.readModelTimeCursor(ctx, orgID, args, orderBy, cursor, cursorID, includeTotalCount)
	}
	return s.mySQLTimeCursor(ctx, orgID, args, orderBy, cursor, cursorID)
}

// readModelTimeCursor pages the denormalized read model.
func (s *Service) readModelTimeCursor(
	ctx context.Context,
	orgID string,
	args listArgs,
	orderBy ItemsOrderBy,
	cursor *ItemsCursorPayload,
	cursorID string,
	includeTotalCount bool,
) (ItemConnectionResult, error) {
	candidates := scopedCandidates(args)
	cursorTime, resolved, err := s.resolveReadModelCursorTime(ctx, orgID, orderBy, cursor, cursorID)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	if !resolved {
		if includeTotalCount {
			return emptyConnection(len(args.scoped)), nil
		}
		return emptyConnection(0), nil
	}

	var docs []ReadModelDocument
	if cursorTime != nil {
		docs, err = s.mongo.ListReadModelMetaRowsAfterCursor(ctx, orgID, candidates, orderBy, *cursorTime, cursorID, args.take+1)
	} else {
		docs, err = s.mongo.ListReadModelMetaRows(ctx, orgID, candidates, orderBy, 0, args.take+1)
	}
	if err != nil {
		return ItemConnectionResult{}, err
	}
	hasNextPage := len(docs) > args.take
	if hasNextPage {
		docs = docs[:args.take]
	}
	totalCount := 0
	if includeTotalCount {
		totalCount, err = s.mongo.CountReadModelMetaRows(ctx, orgID, candidates)
		if err != nil {
			return ItemConnectionResult{}, err
		}
	}
	edges := make([]ItemListEdge, 0, len(docs))
	for _, doc := range docs {
		row := ItemMetaRowFromReadModel(doc)
		edges = append(edges, ItemListEdge{Row: row, Cursor: encodeRowCursor(ItemsRankingRecency, args.orderBy, row, nil)})
	}
	return ItemConnectionResult{Edges: edges, HasNextPage: hasNextPage, TotalCount: totalCount}, nil
}

// resolveReadModelCursorTime returns the cursor timestamp and whether the query
// may proceed. resolved is false only when the cursor row itself is missing.
// A present row with a null ordering column yields a nil timestamp, which
// matches the NestJS branch that then reads the first page.
func (s *Service) resolveReadModelCursorTime(
	ctx context.Context,
	orgID string,
	orderBy ItemsOrderBy,
	cursor *ItemsCursorPayload,
	cursorID string,
) (*time.Time, bool, error) {
	if cursorID == "" {
		return nil, true, nil
	}
	if cursor != nil {
		timestamp := cursor.CreatedAt
		if orderBy == ItemsOrderByPublishedDesc {
			timestamp = cursor.SortAt
		}
		if timestamp != nil {
			if parsed, ok := parseTimeValue(*timestamp); ok {
				value := parsed
				return &value, true, nil
			}
		}
	}
	keys, err := s.mongo.FindReadModelSortKeys(ctx, orgID, cursorID)
	if err != nil {
		return nil, false, err
	}
	if keys == nil {
		return nil, false, nil
	}
	if orderBy == ItemsOrderByPublishedDesc {
		return keys.SortAt, true, nil
	}
	return keys.CreatedAt, true, nil
}

// mySQLTimeCursor pages the MySQL ItemMeta table. It deliberately counts the
// base range unconditionally: the NestJS Prisma branch always issues the count,
// unlike the read-model branch which gates it on the selected totalCount.
func (s *Service) mySQLTimeCursor(
	ctx context.Context,
	orgID string,
	args listArgs,
	orderBy ItemsOrderBy,
	cursor *ItemsCursorPayload,
	cursorID string,
) (ItemConnectionResult, error) {
	candidates := scopedCandidates(args)
	if args.scopedOK && cursorID != "" && !stringInSlice(args.scoped, cursorID) {
		return emptyConnection(len(args.scoped)), nil
	}

	cursorTime, resolved, err := s.resolveMySQLCursorTime(ctx, orgID, orderBy, cursor, cursorID)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	if !resolved {
		total := 0
		if args.scopedOK {
			total = len(args.scoped)
		}
		return emptyConnection(total), nil
	}

	var rows []ItemMetaRow
	if cursorTime != nil {
		rows, err = s.mysql.ListItemMetaAfterCursor(ctx, orgID, candidates, orderBy, *cursorTime, cursorID, args.take+1)
	} else {
		rows, err = s.mysql.ListItemMeta(ctx, orgID, candidates, orderBy, 0, args.take+1)
	}
	if err != nil {
		return ItemConnectionResult{}, err
	}
	hasNextPage := len(rows) > args.take
	if hasNextPage {
		rows = rows[:args.take]
	}
	totalCount, err := s.mysql.CountItemMeta(ctx, orgID, candidates)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	edges := make([]ItemListEdge, 0, len(rows))
	for _, row := range rows {
		edges = append(edges, ItemListEdge{Row: row, Cursor: encodeRowCursor(ItemsRankingRecency, args.orderBy, row, nil)})
	}
	return ItemConnectionResult{Edges: edges, HasNextPage: hasNextPage, TotalCount: totalCount}, nil
}

// resolveMySQLCursorTime is the Prisma twin of resolveReadModelCursorTime.
func (s *Service) resolveMySQLCursorTime(
	ctx context.Context,
	orgID string,
	orderBy ItemsOrderBy,
	cursor *ItemsCursorPayload,
	cursorID string,
) (*time.Time, bool, error) {
	if cursorID == "" {
		return nil, true, nil
	}
	if cursor != nil {
		timestamp := cursor.CreatedAt
		if orderBy == ItemsOrderByPublishedDesc {
			timestamp = cursor.SortAt
		}
		if timestamp != nil {
			if parsed, ok := parseTimeValue(*timestamp); ok {
				value := parsed
				return &value, true, nil
			}
		}
	}
	rows, err := s.mysql.FindItemMetaRows(ctx, orgID, []string{cursorID})
	if err != nil {
		return nil, false, err
	}
	row, ok := rows[cursorID]
	if !ok {
		return nil, false, nil
	}
	if orderBy == ItemsOrderByPublishedDesc {
		value := row.SortAt.Time
		return &value, true, nil
	}
	value := row.CreatedAt.Time
	return &value, true, nil
}

// fetchItemMetaRowsByIDs ports ItemsReadModelService.fetchItemMetaRowsByIds: the
// lookup is organization scoped in both modes, and the non-read-model variant
// also excludes the duplicate status like buildBaseWhere.
func (s *Service) fetchItemMetaRowsByIDs(ctx context.Context, orgID string, ids []string) (map[string]ItemMetaRow, error) {
	ordered := DedupeItemMetaIDs(ids)
	if len(ordered) == 0 {
		return map[string]ItemMetaRow{}, nil
	}
	if s.readModelEnabled {
		docs, err := s.readModel.loadItemReadModelsByIDs(ctx, orgID, ordered)
		if err != nil {
			return nil, err
		}
		out := make(map[string]ItemMetaRow, len(docs))
		for id, doc := range docs {
			out[id] = ItemMetaRowFromReadModel(doc)
		}
		return out, nil
	}
	return s.mysql.FindListableItemMetaRows(ctx, orgID, ordered)
}

// timeOrderValue maps the GraphQL ordering onto the REST order column type. A
// non-personalized value passes through; anything else falls back to
// CREATED_DESC, mirroring `effectiveOrderBy` in NestJS.
func timeOrderValue(orderBy ItemsListOrderBy) ItemsOrderBy {
	if orderBy == ItemsListOrderPublishedDesc {
		return ItemsOrderByPublishedDesc
	}
	return ItemsOrderByCreatedDesc
}

// scopedCandidates returns the restricted id set or nil when unrestricted.
func scopedCandidates(args listArgs) []string {
	if args.scopedOK {
		return args.scoped
	}
	return nil
}

// stringInSlice reports whether values contains needle.
func stringInSlice(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

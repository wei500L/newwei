package itemsreading

import (
	"context"
	"database/sql"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// This file owns the narrow read surface the analysis CSV export needs. The
// candidate selection reuses the existing page branches (time, relevance,
// personalized) through listItemsPage, so the export keeps the interactive
// filters, ranking and ordering semantics while taking ExportMaxRows rows
// instead of the interactive MaxCursorPageSize cap. The two field-completion
// reads are plain batch projections: they mirror the NestJS export queries
// rather than the hydrating read-model lookups, so a CSV request never writes
// Mongo and never issues a query per row.

// ExportMaxRows is the CSV export row cap. It mirrors MAX_EXPORT_ROWS in
// analysis-workspace.service.ts; the interactive REST cap stays 50.
const ExportMaxRows = 5000

// ExportItemsQuery is the typed input of the items CSV export.
type ExportItemsQuery struct {
	// Search is the raw q parameter. It may be a plain term or a historical
	// __items_filters__ payload, exactly like ItemsListService.list.
	Search string
	// Filters is the explicit filter set built from the export query string.
	// The NestJS export always passes an object (possibly empty), so an
	// explicit object wins over the filters embedded in a historical search
	// payload.
	Filters *ItemFilters
	// OrderBy is the parsed order value.
	OrderBy ItemsListOrderBy
	// RankingMode is the parsed ranking value. The effective mode still
	// downgrades to RECENCY when the decoded search term is blank.
	RankingMode ItemsRankingMode
	// UserID is the authenticated caller. The PERSONALIZED ordering always
	// reads this caller's behavior profile and never degrades silently.
	UserID string
}

// ListForExport selects up to ExportMaxRows candidates with the same page
// semantics as the interactive list, but with page=1 and the export page size.
// It deliberately does not widen the REST or GraphQL interactive caps and does
// not loop over 50-row pages: the source export issues a single page=1,
// maxPageSize=5000 selection.
func (s *Service) ListForExport(ctx context.Context, orgID string, query ExportItemsQuery) ([]ItemMetaRow, error) {
	orderBy := query.OrderBy
	switch orderBy {
	case ItemsListOrderPublishedDesc, ItemsListOrderPersonalized, ItemsListOrderCreatedDesc:
	default:
		orderBy = ItemsListOrderCreatedDesc
	}

	parsed := ParseSearchPayload(query.Search)
	scopedIDs, restricted, err := s.search.ResolveScopedIDs(ctx, orgID, parsed.Search, query.Filters)
	if err != nil {
		return nil, err
	}
	if restricted && len(scopedIDs) == 0 {
		return []ItemMetaRow{}, nil
	}

	args := listArgs{
		orderBy:  orderBy,
		ranking:  resolveListRankingMode(query.RankingMode, parsed.Search),
		search:   parsed.Search,
		scoped:   scopedIDs,
		scopedOK: restricted,
		take:     ExportMaxRows,
	}
	result, err := s.listItemsPage(ctx, orgID, query.UserID, args, 1)
	if err != nil {
		return nil, err
	}
	rows := make([]ItemMetaRow, 0, len(result.Edges))
	for _, edge := range result.Edges {
		rows = append(rows, edge.Row)
	}
	return rows, nil
}

// ExportReadModelRow is the named read-model projection the items CSV needs. A
// missing document leaves the optional fields nil so the caller falls back to
// the ItemMeta row or an empty cell, exactly like the NestJS export. Title is
// optional on purpose: the source `readModel?.title ?? item.name` falls back
// only when the stored value is null or absent, while an explicit empty string
// is kept.
type ExportReadModelRow struct {
	ItemMetaID  string
	Title       *string
	PublishedAt *ISOTime
	SourceName  *string
	Domain      *string
	Language    *string
	Region      *string
	Sentiment   *string
	ContentType *string
	URL         *string
	// ProcessedID is readModel.processed.id and is empty when the document
	// carries no processed snapshot.
	ProcessedID string
}

// exportReadModelProcessed is the nested processed.id projection.
type exportReadModelProcessed struct {
	ID string `bson:"id"`
}

// exportReadModelDoc decodes the projected itemreadmodels document.
type exportReadModelDoc struct {
	ItemMetaID  string                    `bson:"itemMetaId"`
	Title       *string                   `bson:"title"`
	PublishedAt *ISOTime                  `bson:"publishedAt"`
	SourceName  *string                   `bson:"sourceName"`
	Domain      *string                   `bson:"domain"`
	Language    *string                   `bson:"language"`
	Region      *string                   `bson:"region"`
	Sentiment   *string                   `bson:"sentiment"`
	ContentType *string                   `bson:"contentType"`
	URL         *string                   `bson:"url"`
	Processed   *exportReadModelProcessed `bson:"processed"`
}

// FindExportReadModels is the batch field-completion read of the items export.
//
// It mirrors ItemReadModelModel.find({ orgId, itemMetaId: { $in: ids } }) in
// analysis-workspace.service.ts: the match is organization scoped, the status
// column is deliberately not filtered (the source query has no status
// condition), and the first document seen per itemMetaId wins. Unlike
// loadItemReadModelsByIDs it never hydrates a missing document, so the request
// has no Mongo write side effect.
func (s *Service) FindExportReadModels(ctx context.Context, orgID string, itemMetaIDs []string) (map[string]ExportReadModelRow, error) {
	out := make(map[string]ExportReadModelRow, len(itemMetaIDs))
	ordered := DedupeItemMetaIDs(itemMetaIDs)
	if len(ordered) == 0 {
		return out, nil
	}
	opts := options.Find().SetProjection(bson.D{
		{Key: "itemMetaId", Value: 1},
		{Key: "title", Value: 1},
		{Key: "publishedAt", Value: 1},
		{Key: "sourceName", Value: 1},
		{Key: "domain", Value: 1},
		{Key: "language", Value: 1},
		{Key: "region", Value: 1},
		{Key: "sentiment", Value: 1},
		{Key: "contentType", Value: 1},
		{Key: "url", Value: 1},
		{Key: "processed.id", Value: 1},
	})
	cursor, err := s.mongo.readModels().Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: ordered}}},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc exportReadModelDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		itemMetaID := strings.TrimSpace(doc.ItemMetaID)
		if itemMetaID == "" {
			continue
		}
		if _, exists := out[itemMetaID]; exists {
			continue
		}
		row := ExportReadModelRow{
			ItemMetaID:  itemMetaID,
			Title:       doc.Title,
			PublishedAt: doc.PublishedAt,
			SourceName:  doc.SourceName,
			Domain:      doc.Domain,
			Language:    doc.Language,
			Region:      doc.Region,
			Sentiment:   doc.Sentiment,
			ContentType: doc.ContentType,
			URL:         doc.URL,
		}
		if doc.Processed != nil {
			row.ProcessedID = strings.TrimSpace(doc.Processed.ID)
		}
		out[itemMetaID] = row
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ExportEventLink is the event one processed item is attached to, as the items
// CSV needs it. EventTitle is empty when the event has no title.
type ExportEventLink struct {
	ProcessedItemID string
	EventID         string
	EventTitle      string
}

// FindExportEventLinks batches the NewsEventItem -> NewsEvent lookup of the
// items export.
//
// It mirrors prisma.newsEventItem.findMany({ where: { orgId, processedItemId:
// { in: ids } }, orderBy: [{ createdAt: "desc" }], include: { event: { id,
// title } } }) plus the first-row-per-processedItemId loop. Both the join row
// and the event are organization scoped, so a processed id from another tenant
// can never contribute a foreign event. The id tie-break only makes rows that
// share a createdAt deterministic; it cannot change which events are visible.
func (s *Service) FindExportEventLinks(ctx context.Context, orgID string, processedItemIDs []string) (map[string]ExportEventLink, error) {
	out := make(map[string]ExportEventLink, len(processedItemIDs))
	ordered := DedupeItemMetaIDs(processedItemIDs)
	if len(ordered) == 0 {
		return out, nil
	}
	query := "SELECT nei.`processedItemId`, e.`id`, e.`title` FROM `NewsEventItem` nei" +
		" JOIN `NewsEvent` e ON e.`id` = nei.`eventId`" +
		" WHERE nei.`orgId` = ? AND e.`orgId` = ?" +
		mySQLInPredicate("nei.`processedItemId`", len(ordered)) +
		" ORDER BY nei.`createdAt` DESC, nei.`id` DESC"
	args := make(mySQLArgs, 0, len(ordered)+2)
	args = append(args, orgID, orgID)
	for _, id := range ordered {
		args = append(args, id)
	}
	rows, err := s.mysql.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var processedID, eventID, eventTitle sql.NullString
		if err := rows.Scan(&processedID, &eventID, &eventTitle); err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(processedID.String)
		if normalized == "" {
			continue
		}
		if _, exists := out[normalized]; exists {
			continue
		}
		out[normalized] = ExportEventLink{
			ProcessedItemID: normalized,
			EventID:         strings.TrimSpace(eventID.String),
			EventTitle:      eventTitle.String,
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

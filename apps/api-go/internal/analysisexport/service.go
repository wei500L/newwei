package analysisexport

import (
	"context"
	"io"
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// Service runs the two CSV exports. The item and event readers are the same
// business services the other Go entry points use, so the export shares the
// search scope, read-model projection, personalization, heat and authority
// formulas instead of carrying a second implementation.
type Service struct {
	items  *itemsreading.Service
	events *newsevents.Exporter
}

// NewService wires the export service.
func NewService(items *itemsreading.Service, events *newsevents.Exporter) *Service {
	return &Service{items: items, events: events}
}

// ExportItemsCSV runs the items export and streams the CSV into w.
//
// Every query, ranking and projection completes before the first byte is
// written, so a rerank/vector/database failure is still reported as an error
// projection with no CSV headers committed, while a genuinely empty result
// writes the header line alone.
func (s *Service) ExportItemsCSV(ctx context.Context, orgID string, userID string, queryString string, w io.Writer) error {
	params := parseItemsParams(parseQueryParams(analysiscollab.NormalizeQueryString(queryString)))
	rows, err := s.items.ListForExport(ctx, orgID, itemsreading.ExportItemsQuery{
		Search:      params.search,
		Filters:     params.filters,
		OrderBy:     params.orderBy,
		RankingMode: params.ranking,
		UserID:      userID,
	})
	if err != nil {
		return err
	}

	itemIDs := make([]string, len(rows))
	for index, row := range rows {
		itemIDs[index] = row.ID
	}
	readModels, err := s.items.FindExportReadModels(ctx, orgID, itemIDs)
	if err != nil {
		return err
	}
	processedIDs := make([]string, 0, len(readModels))
	for _, row := range rows {
		if readModel, ok := readModels[row.ID]; ok && readModel.ProcessedID != "" {
			processedIDs = append(processedIDs, readModel.ProcessedID)
		}
	}
	links, err := s.items.FindExportEventLinks(ctx, orgID, processedIDs)
	if err != nil {
		return err
	}

	writer := newCSVRowWriter(w)
	writer.writeRow(itemsHeader)
	for _, row := range rows {
		var readModel *itemsreading.ExportReadModelRow
		if found, ok := readModels[row.ID]; ok {
			readModel = &found
		}
		var link *itemsreading.ExportEventLink
		if readModel != nil && readModel.ProcessedID != "" {
			if found, ok := links[readModel.ProcessedID]; ok {
				link = &found
			}
		}
		writer.writeRow(buildItemsRow(row, readModel, link))
	}
	return writer.err
}

// ExportEventsCSV runs the events export and streams the CSV into w. The events
// port already performs the candidate selection, heat/authority completion,
// filtering, sorting and dedupe; the writer is only touched afterwards.
func (s *Service) ExportEventsCSV(ctx context.Context, orgID string, queryString string, w io.Writer) error {
	query := parseEventsParams(parseQueryParams(analysiscollab.NormalizeQueryString(queryString)))
	rows, err := s.events.ExportEvents(ctx, orgID, query)
	if err != nil {
		return err
	}
	writer := newCSVRowWriter(w)
	writer.writeRow(eventsHeader)
	for _, row := range rows {
		writer.writeRow(buildEventsRow(row))
	}
	return writer.err
}

// buildItemsRow ports the row projection of buildItemsExportRows. The title is
// `readModel.title ?? item.name`: an existing read model keeps its title even
// when it is an empty string, and only a missing document falls back. The other
// read-model fields default to an empty cell, publishedAt falls back to the
// ItemMeta timestamp, and the linked event defaults to empty.
func buildItemsRow(
	row itemsreading.ItemMetaRow,
	readModel *itemsreading.ExportReadModelRow,
	link *itemsreading.ExportEventLink,
) []string {
	title := row.Name
	publishedAt := ""
	source, domain, language, region, sentiment, contentType, url := "", "", "", "", "", "", ""
	if readModel != nil {
		title = readModel.Title
		if readModel.PublishedAt != nil {
			publishedAt = formatISOTime(readModel.PublishedAt.Time)
		}
		source = derefExportString(readModel.SourceName)
		domain = derefExportString(readModel.Domain)
		language = derefExportString(readModel.Language)
		region = derefExportString(readModel.Region)
		sentiment = derefExportString(readModel.Sentiment)
		contentType = derefExportString(readModel.ContentType)
		url = derefExportString(readModel.URL)
	}
	if publishedAt == "" && row.PublishedAt != nil {
		publishedAt = formatISOTime(row.PublishedAt.Time)
	}
	eventID, eventTitle := "", ""
	if link != nil {
		eventID = link.EventID
		eventTitle = link.EventTitle
	}
	return []string{
		row.ID, title, source, domain, publishedAt, language, region,
		sentiment, contentType, eventID, eventTitle, url,
	}
}

// buildEventsRow ports the row projection of buildEventsExportRows. Text fields
// keep the stored value (the title is already the resolved fallback chain) and
// the numeric fields use the JavaScript number rendering of the export ranges.
func buildEventsRow(row newsevents.ExportEventRow) []string {
	return []string{
		row.ID,
		row.Title,
		row.Status,
		row.PrimaryTopic,
		row.PrimaryEntity,
		formatISOTime(row.StartAt),
		formatISOTime(row.LastAt),
		formatJSNumber(row.HeatScore),
		formatJSNumber(row.CredibilityScore),
		strconv.Itoa(row.ItemCount),
		strconv.Itoa(row.AuthoritativeSourceCount),
		strconv.Itoa(row.UniqueSourceCount),
	}
}

// formatISOTime renders Date.toISOString (UTC milliseconds) and maps a missing
// timestamp to an empty cell.
func formatISOTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return itemsreading.FormatISOTime(value)
}

// derefExportString unwraps an optional stored string; a missing value is an
// empty cell.
func derefExportString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

package newsevents

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// This file owns the narrow news-event read surface of the events CSV export.
// It reuses the private candidate/heat/authority helpers of the GraphQL root so
// both entry points share one formula, but it never calls the root itself: the
// root caps candidates at 300, clips the entity to 120 UTF-16 units and applies
// the GraphQL min-credibility clamp, none of which the CSV export contract
// carries. The export candidate query is separate for the same reason (the
// GraphQL root matches primaryEntity exactly while the export uses contains).

// ExportMaxRows is the candidate and row cap of the events CSV export. It
// mirrors MAX_EXPORT_ROWS in analysis-workspace.service.ts.
const ExportMaxRows = 5000

// ExportQuery is the typed input of the events CSV export. Every value is
// already parsed by the caller (status/sort/sourceType accept exactly the
// documented tokens; the two floors are nil when absent or invalid).
type ExportQuery struct {
	// WindowDays filters lastAt >= now-window and is also the authority
	// statistics window (never the GraphQL root's 45-day default).
	WindowDays int
	// Status is "active", "archived" or "" (no status filter).
	Status string
	// Entity is the trimmed primaryEntity contains term; "" means no filter.
	Entity string
	// Sort is "latest", "heat" or "credibility".
	Sort string
	// SourceType is "all", "authoritative", "mixed", "blog" or "unknown".
	SourceType string
	// MinHeatScore and MinCredibilityScore are the optional inclusive floors.
	MinHeatScore        *float64
	MinCredibilityScore *float64
}

// ExportEventRow is the named CSV row model. Title already carries the resolved
// title -> summary -> primaryTopic -> primaryEntity -> id fallback chain.
type ExportEventRow struct {
	ID                       string
	Title                    string
	Status                   string
	PrimaryTopic             string
	PrimaryEntity            string
	StartAt                  time.Time
	LastAt                   time.Time
	HeatScore                float64
	CredibilityScore         float64
	ItemCount                int
	AuthoritativeSourceCount int
	UniqueSourceCount        int
}

// Exporter is the narrow read port the analysis export package consumes. It
// deliberately exposes only the MySQL handle the export reads need; the
// GraphQL registration keeps its own service instance.
type Exporter struct {
	svc *service
}

// NewExporter wires the events CSV export reader.
func NewExporter(db *sql.DB) *Exporter {
	return &Exporter{svc: &service{db: db}}
}

// ExportEvents runs the full export pipeline in the source order: candidate
// selection, batched heat/authority completion, business filters, stable sort,
// greedy similarity dedupe, then the row cap. A database or settings read
// failure is returned as an error; only the settings read is tolerated as
// absent, exactly like the NestJS try/catch around getSettings.
func (e *Exporter) ExportEvents(ctx context.Context, orgID string, query ExportQuery) ([]ExportEventRow, error) {
	if e == nil || e.svc == nil || e.svc.db == nil {
		return nil, errors.New("newsevents: events export requires mysql")
	}
	windowDays := clampInt(query.WindowDays, 1, 365)
	entity := strings.TrimSpace(query.Entity)
	rows, err := e.svc.listEventRowsForExport(ctx, orgID, ExportMaxRows, windowDays, query.Status, entity)
	if err != nil {
		return nil, err
	}

	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	heat, err := e.svc.heatMap(ctx, orgID, ids, rows)
	if err != nil {
		return nil, err
	}
	authority, err := e.svc.authorityMap(ctx, orgID, ids, windowDays)
	if err != nil {
		return nil, err
	}

	sourceType := query.SourceType
	if sourceType == "" {
		sourceType = "all"
	}
	// The forced authoritative mode overrides the requested sourceType and
	// applies the stored minimum source count. loadSettings already mirrors
	// normalizeSettings (1..5 fallback 1), and the export re-clamps to the
	// source Math.max(1, Math.min(10, value)) range so a wider stored value can
	// never pass through.
	var minAuthoritative *int
	settings := e.svc.loadSettings(ctx, orgID)
	if settings.Force {
		sourceType = "authoritative"
		forced := clampInt(settings.ForceMin, 1, 10)
		minAuthoritative = &forced
	}

	enriched := make([]scoredEvent, 0, len(rows))
	for _, row := range rows {
		entry := scoredEvent{row: row, heat: heat[row.ID], authority: authority[row.ID]}
		if sourceType != "all" && entry.authority.SourceType != sourceType {
			continue
		}
		if query.MinHeatScore != nil && entry.heat.Score < *query.MinHeatScore {
			continue
		}
		if query.MinCredibilityScore != nil && entry.authority.Credibility < *query.MinCredibilityScore {
			continue
		}
		if minAuthoritative != nil && entry.authority.Evidence.AuthoritativeSourceCount < *minAuthoritative {
			continue
		}
		enriched = append(enriched, entry)
	}

	sortEvents(enriched, query.Sort)
	enriched = dedupeExportEvents(enriched)
	if len(enriched) > ExportMaxRows {
		enriched = enriched[:ExportMaxRows]
	}

	out := make([]ExportEventRow, 0, len(enriched))
	for _, entry := range enriched {
		out = append(out, ExportEventRow{
			ID:                       entry.row.ID,
			Title:                    resolveExportEventTitle(entry.row),
			Status:                   entry.row.Status,
			PrimaryTopic:             deref(entry.row.PrimaryTopic),
			PrimaryEntity:            deref(entry.row.PrimaryEntity),
			StartAt:                  entry.row.StartAt,
			LastAt:                   entry.row.LastAt,
			HeatScore:                entry.heat.Score,
			CredibilityScore:         entry.authority.Credibility,
			ItemCount:                entry.row.ItemCount,
			AuthoritativeSourceCount: entry.authority.Evidence.AuthoritativeSourceCount,
			UniqueSourceCount:        entry.authority.Evidence.UniqueSourceCount,
		})
	}
	return out, nil
}

// listEventRowsForExport is the export candidate query. It mirrors the NestJS
// prisma.newsEvent.findMany filter (orgId, optional status, primaryEntity
// contains, lastAt >= now-window), the item count and the
// (lastAt DESC, startAt DESC) order, but applies neither the GraphQL root's
// 300-candidate cap nor its 120-character entity clip.
func (s *service) listEventRowsForExport(
	ctx context.Context,
	orgID string,
	limit int,
	windowDays int,
	status string,
	entity string,
) ([]eventRow, error) {
	since := s.clock().Add(-time.Duration(windowDays) * day)
	query := `
SELECT id, status, language, primaryTopic, primaryEntity, title, summary,
       startAt, lastAt,
       (SELECT COUNT(*) FROM NewsEventItem i WHERE i.eventId = NewsEvent.id),
       representativeProcessedArticleId, representativeProcessedItemId,
       metadata, createdAt, updatedAt
FROM NewsEvent
WHERE orgId = ? AND lastAt >= ?`
	args := []any{orgID, since}
	if status != "" {
		query += " AND status = ?"
		args = append(args, status)
	}
	if entity != "" {
		query += " AND primaryEntity LIKE ?"
		args = append(args, likeContains(entity))
	}
	query += " ORDER BY lastAt DESC, startAt DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]eventRow, 0, limit)
	for rows.Next() {
		row, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// likeContains renders a Prisma `contains` term as a LIKE pattern. Prisma
// treats % and _ as literals, so the pattern escapes the backslash itself and
// the two LIKE wildcards; MySQL's default backslash escape character then makes
// them literal without an explicit ESCAPE clause. This mirrors likeContains in
// the crawl-profile and news-source stores.
func likeContains(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}

// resolveExportEventTitle ports resolveEventTitle: the first trimmed non-empty
// value of title, summary, primaryTopic, primaryEntity, then the raw id.
func resolveExportEventTitle(row eventRow) string {
	for _, candidate := range []*string{row.Title, row.Summary, row.PrimaryTopic, row.PrimaryEntity} {
		if candidate == nil {
			continue
		}
		if trimmed := strings.TrimSpace(*candidate); trimmed != "" {
			return trimmed
		}
	}
	return row.ID
}

// dedupeExportEvents ports the greedy duplicate filter of dedupeEvents with a
// token inverted index.
//
// The source loop compares every candidate against every kept event, but two
// token sets whose intersection is empty can never reach the 0.74 Jaccard
// floor (the score is 0), and an empty token set never matches either. The
// index therefore only offers the kept events that share at least one token
// with the candidate; the 5-day OR time condition, the >= 0.74 boundary, the
// kept order and the rule that a discarded event never joins the index are all
// unchanged, so the kept id sequence is identical to the reference loop. This
// is a constant-factor reduction in the number of exact comparisons for a
// 5000-row export; it is not a claim of linear worst-case complexity.
func dedupeExportEvents(rows []scoredEvent) []scoredEvent {
	type kept struct {
		entry  scoredEvent
		tokens map[string]struct{}
		start  time.Time
		last   time.Time
	}
	out := make([]kept, 0, len(rows))
	postings := make(map[string][]int)
	// marks dedupes the kept events reached through several shared tokens
	// without allocating a per-candidate set; the generation counter is bumped
	// once per candidate that has tokens.
	marks := make([]int, 0, len(rows))
	generation := 0
	for _, entry := range rows {
		tokens := eventTokens(entry.row)
		duplicate := false
		if len(tokens) > 0 {
			generation++
			for token := range tokens {
				for _, position := range postings[token] {
					if marks[position] == generation {
						continue
					}
					marks[position] = generation
					existing := out[position]
					closeByTime := within(entry.row.StartAt, existing.start) || within(entry.row.LastAt, existing.last)
					if closeByTime && jaccard(tokens, existing.tokens) >= 0.74 {
						duplicate = true
						break
					}
				}
				if duplicate {
					break
				}
			}
		}
		if duplicate {
			continue
		}
		out = append(out, kept{
			entry:  entry,
			tokens: tokens,
			start:  entry.row.StartAt,
			last:   entry.row.LastAt,
		})
		marks = append(marks, 0)
		position := len(out) - 1
		for token := range tokens {
			postings[token] = append(postings[token], position)
		}
	}

	result := make([]scoredEvent, len(out))
	for i, item := range out {
		result[i] = item.entry
	}
	return result
}

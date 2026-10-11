package history

import (
	"context"
	"database/sql"
	"strings"
)

const seriesSQL = `
SELECT slug, displayName, description, sourceDocUrl
FROM EconomicDataItem
WHERE isActive = 1
  AND (slug LIKE ? ESCAPE '\\' OR displayName LIKE ? ESCAPE '\\')
LIMIT ?`

func (s *service) searchSeries(ctx context.Context, term string, limit int) ([]EconomicSeriesSuggestion, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	normalized := jsTrim(term)
	if normalized == "" {
		return []EconomicSeriesSuggestion{}, nil
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 20 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, seriesSQL, likeContains(strings.ToLower(normalized)), likeContains(normalized), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := make(map[string]struct{}, limit)
	out := make([]EconomicSeriesSuggestion, 0, limit)
	for rows.Next() {
		var slug, displayName string
		var description, docURL sql.NullString
		if err := rows.Scan(&slug, &displayName, &description, &docURL); err != nil {
			return nil, err
		}
		if _, ok := seen[slug]; ok {
			continue
		}
		seen[slug] = struct{}{}
		out = append(out, EconomicSeriesSuggestion{
			Description: nullStringPtr(description),
			DisplayName: displayName,
			DocURL:      nullStringPtr(docURL),
			Slug:        slug,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func likeContains(term string) string {
	var builder strings.Builder
	builder.Grow(len(term) + 2)
	builder.WriteByte('%')
	for _, r := range term {
		switch r {
		case '\\', '%', '_':
			builder.WriteByte('\\')
		}
		builder.WriteRune(r)
	}
	builder.WriteByte('%')
	return builder.String()
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return stringPtr(value.String)
}

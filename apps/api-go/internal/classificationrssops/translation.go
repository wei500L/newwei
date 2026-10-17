package classificationrssops

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// translationMetricsQuery is the typed input of GET rss-translation/metrics.
type translationMetricsQuery struct {
	OrgID          string
	From           *string
	To             *string
	Provider       *string
	TargetLanguage *string
}

// RSSTranslationMetrics mirrors RssTranslationMetricsService.getDailyMetrics:
// the window defaults to the last 14 UTC days, is capped at 180 days and is
// always filtered by the caller's orgId.
func (s *Service) RSSTranslationMetrics(ctx context.Context, query translationMetricsQuery) (rssTranslationMetricsResponse, error) {
	from, to, err := resolveTranslationWindow(query.From, query.To, time.Now().UTC())
	if err != nil {
		return rssTranslationMetricsResponse{}, err
	}

	provider := ""
	if query.Provider != nil {
		provider = strings.ToLower(strings.TrimSpace(*query.Provider))
	}
	targetLanguage := ""
	if query.TargetLanguage != nil {
		targetLanguage = strings.ToLower(strings.TrimSpace(*query.TargetLanguage))
	}

	documents, err := s.queryTranslationRows(ctx, query.OrgID, provider, targetLanguage, from, to)
	if err != nil {
		// A missing table or column means the migration has not run yet; the
		// reader reports an empty result exactly like the Prisma error mapping.
		if isMissingTableError(err) {
			return emptyTranslationMetricsResponse(from, to), nil
		}
		return rssTranslationMetricsResponse{}, err
	}

	rows := make([]rssTranslationMetricsRow, 0, len(documents))
	for _, document := range documents {
		requestCount := maxInt(document.RequestCount, 0)
		cacheHitCount := maxInt(document.CacheHitCount, 0)
		cacheMissCount := maxInt(document.CacheMissCount, 0)
		failureCount := maxInt(document.FailureCount, 0)
		totalLatencyMs := maxInt(document.TotalLatencyMs, 0)
		maxLatencyMs := maxInt(document.MaxLatencyMs, 0)
		cacheTotal := cacheHitCount + cacheMissCount
		row := rssTranslationMetricsRow{
			Date:             document.Date,
			Provider:         document.Provider,
			TargetLanguage:   document.TargetLanguage,
			RequestCount:     requestCount,
			ItemCount:        maxInt(document.ItemCount, 0),
			TextCount:        maxInt(document.TextCount, 0),
			CacheHitCount:    cacheHitCount,
			CacheMissCount:   cacheMissCount,
			TranslatedCount:  maxInt(document.TranslatedCount, 0),
			FailureCount:     failureCount,
			SkipTooLongCount: maxInt(document.SkipTooLongCount, 0),
			TotalLatencyMs:   totalLatencyMs,
			MaxLatencyMs:     maxLatencyMs,
		}
		if requestCount > 0 {
			row.AvgLatencyMs = int(math.Round(float64(totalLatencyMs) / float64(requestCount)))
		}
		if cacheTotal > 0 {
			row.CacheHitRate = float64(cacheHitCount) / float64(cacheTotal)
		}
		if requestCount > 0 {
			row.FailureRate = float64(failureCount) / float64(requestCount)
		}
		rows = append(rows, row)
	}

	summary := rssTranslationMetricsSummary{}
	for _, row := range rows {
		summary.RequestCount += row.RequestCount
		summary.ItemCount += row.ItemCount
		summary.TextCount += row.TextCount
		summary.CacheHitCount += row.CacheHitCount
		summary.CacheMissCount += row.CacheMissCount
		summary.TranslatedCount += row.TranslatedCount
		summary.FailureCount += row.FailureCount
		summary.SkipTooLongCount += row.SkipTooLongCount
		summary.TotalLatencyMs += row.TotalLatencyMs
		summary.MaxLatencyMs = maxInt(summary.MaxLatencyMs, row.MaxLatencyMs)
	}
	cacheTotal := summary.CacheHitCount + summary.CacheMissCount
	if summary.RequestCount > 0 {
		summary.AvgLatencyMs = int(math.Round(float64(summary.TotalLatencyMs) / float64(summary.RequestCount)))
	}
	if cacheTotal > 0 {
		summary.CacheHitRate = float64(summary.CacheHitCount) / float64(cacheTotal)
	}
	if summary.RequestCount > 0 {
		summary.FailureRate = float64(summary.FailureCount) / float64(summary.RequestCount)
	}

	return rssTranslationMetricsResponse{
		From:    formatUTCDate(from),
		To:      formatUTCDate(to),
		Rows:    rows,
		Summary: summary,
	}, nil
}

// resolveTranslationWindow mirrors the private getDailyMetrics date handling:
// from defaults to 13 days before today, to defaults to today, both are
// normalized to UTC midnight, from > to is a 400 and a span wider than 180 days
// is a 400.
func resolveTranslationWindow(fromRaw, toRaw *string, now time.Time) (time.Time, time.Time, error) {
	nowDay := startOfUTCDay(now)
	defaultFrom := nowDay.AddDate(0, 0, -(translationDefaultDays - 1))
	from, err := normalizeDateInput(fromRaw, defaultFrom)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	to, err := normalizeDateInput(toRaw, nowDay)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if from.After(to) {
		return time.Time{}, time.Time{}, newStatus(400, "'from' must be earlier than or equal to 'to'")
	}
	daysWindow := int((to.UnixMilli()-from.UnixMilli())/(24*60*60*1000)) + 1
	if daysWindow > translationMaxDays {
		return time.Time{}, time.Time{}, newStatus(400, "Date range exceeds 180 days")
	}
	return from, to, nil
}

// queryTranslationRows reads the daily rows. The optional provider and
// targetLanguage filters each get their own fixed-arity statement, so no dynamic
// placeholder list or untyped argument slice is ever built.
func (s *Service) queryTranslationRows(
	ctx context.Context,
	orgID, provider, targetLanguage string,
	from, to time.Time,
) ([]rssTranslationMetricsDocument, error) {
	if err := s.requireDB(); err != nil {
		return nil, err
	}
	const selectClause = "SELECT `date`, provider, targetLanguage, requestCount, itemCount, textCount, " +
		"cacheHitCount, cacheMissCount, translatedCount, failureCount, skipTooLongCount, " +
		"totalLatencyMs, maxLatencyMs FROM RssTranslationMetricsDaily WHERE orgId = ?"
	const windowClause = " AND `date` >= ? AND `date` <= ?"
	const orderClause = " ORDER BY `date` ASC, provider ASC, targetLanguage ASC"

	var (
		sqlRows *sql.Rows
		err     error
	)
	switch {
	case provider != "" && targetLanguage != "":
		sqlRows, err = s.db.QueryContext(ctx,
			selectClause+windowClause+" AND provider = ? AND targetLanguage = ?"+orderClause,
			orgID, from, to, provider, targetLanguage)
	case provider != "":
		sqlRows, err = s.db.QueryContext(ctx,
			selectClause+windowClause+" AND provider = ?"+orderClause,
			orgID, from, to, provider)
	case targetLanguage != "":
		sqlRows, err = s.db.QueryContext(ctx,
			selectClause+windowClause+" AND targetLanguage = ?"+orderClause,
			orgID, from, to, targetLanguage)
	default:
		sqlRows, err = s.db.QueryContext(ctx, selectClause+windowClause+orderClause, orgID, from, to)
	}
	if err != nil {
		return nil, err
	}
	defer sqlRows.Close()

	out := make([]rssTranslationMetricsDocument, 0, 64)
	for sqlRows.Next() {
		var date time.Time
		var row rssTranslationMetricsDocument
		if err := sqlRows.Scan(&date, &row.Provider, &row.TargetLanguage, &row.RequestCount,
			&row.ItemCount, &row.TextCount, &row.CacheHitCount, &row.CacheMissCount,
			&row.TranslatedCount, &row.FailureCount, &row.SkipTooLongCount,
			&row.TotalLatencyMs, &row.MaxLatencyMs); err != nil {
			return nil, err
		}
		row.Date = formatUTCDate(date)
		out = append(out, row)
	}
	return out, sqlRows.Err()
}

// emptyTranslationMetricsResponse mirrors the missing-table fallback: the
// requested window with no rows and an all-zero summary.
func emptyTranslationMetricsResponse(from, to time.Time) rssTranslationMetricsResponse {
	return rssTranslationMetricsResponse{
		From:    formatUTCDate(from),
		To:      formatUTCDate(to),
		Rows:    []rssTranslationMetricsRow{},
		Summary: rssTranslationMetricsSummary{},
	}
}

// startOfUTCDay mirrors the private startOfUtcDay helper.
func startOfUTCDay(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}

// formatUTCDate mirrors the private formatUtcDate helper.
func formatUTCDate(value time.Time) string {
	return value.UTC().Format(translationDateLayout)
}

// normalizeDateInput mirrors the private normalizeDateInput helper: an empty
// value falls back, a malformed value is a 400 with the exact NestJS message.
func normalizeDateInput(raw *string, fallback time.Time) (time.Time, error) {
	value := ""
	if raw != nil {
		value = strings.TrimSpace(*raw)
	}
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.Parse(translationDateLayout, value)
	if err != nil {
		return time.Time{}, newStatus(400, "Invalid date '"+value+"', expected YYYY-MM-DD")
	}
	return startOfUTCDay(parsed), nil
}

// isMissingTableError mirrors isPrismaMissingTableError: MySQL error 1146 (table
// does not exist) and 1054 (unknown column) mean the migration has not run yet.
func isMissingTableError(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	if !errors.As(err, &mysqlErr) {
		return false
	}
	switch mysqlErr.Number {
	case 1146, 1054:
		return true
	}
	return false
}

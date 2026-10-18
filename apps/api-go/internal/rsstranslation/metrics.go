package rsstranslation

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// metricsInsertSQL mirrors RssTranslationMetricsService.recordDaily: one row
// per orgId/date/provider/targetLanguage, counters accumulated atomically and
// maxLatencyMs kept with GREATEST so a concurrent request can never lose a
// count by reading and overwriting the row.
const metricsInsertSQL = "INSERT INTO `RssTranslationMetricsDaily` (" +
	"`id`, `orgId`, `date`, `provider`, `targetLanguage`, `requestCount`, `itemCount`, `textCount`, " +
	"`cacheHitCount`, `cacheMissCount`, `translatedCount`, `failureCount`, `skipTooLongCount`, " +
	"`totalLatencyMs`, `maxLatencyMs`, `createdAt`, `updatedAt`) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)) " +
	"ON DUPLICATE KEY UPDATE " +
	"`requestCount` = `requestCount` + VALUES(`requestCount`), " +
	"`itemCount` = `itemCount` + VALUES(`itemCount`), " +
	"`textCount` = `textCount` + VALUES(`textCount`), " +
	"`cacheHitCount` = `cacheHitCount` + VALUES(`cacheHitCount`), " +
	"`cacheMissCount` = `cacheMissCount` + VALUES(`cacheMissCount`), " +
	"`translatedCount` = `translatedCount` + VALUES(`translatedCount`), " +
	"`failureCount` = `failureCount` + VALUES(`failureCount`), " +
	"`skipTooLongCount` = `skipTooLongCount` + VALUES(`skipTooLongCount`), " +
	"`totalLatencyMs` = `totalLatencyMs` + VALUES(`totalLatencyMs`), " +
	"`maxLatencyMs` = GREATEST(`maxLatencyMs`, VALUES(`maxLatencyMs`)), " +
	"`updatedAt` = CURRENT_TIMESTAMP(3)"

// recordMetricsBestEffort ports recordMetricsBestEffort: the daily row is a
// best-effort side effect, so a missing table/column or any other write failure
// only logs and never changes the translation result.
func (s *Service) recordMetricsBestEffort(ctx context.Context, orgID string, provider Provider, targetLanguage string, metrics *metricsAccumulator, latencyMs int) {
	if s == nil || s.db == nil || metrics == nil {
		return
	}
	normalizedOrgID := strings.TrimSpace(orgID)
	normalizedProvider := strings.ToLower(strings.TrimSpace(string(provider)))
	normalizedLanguage := strings.ToLower(strings.TrimSpace(targetLanguage))
	if normalizedOrgID == "" || normalizedProvider == "" || normalizedLanguage == "" {
		return
	}
	requestCount := safeNonNegativeInt(metrics.requestCount)
	if requestCount <= 0 {
		return
	}
	rowID, err := newMetricsRowID()
	if err != nil {
		log.Printf("api-go: RSS translation metrics row id failed")
		return
	}
	_, err = s.db.ExecContext(ctx, metricsInsertSQL,
		rowID,
		normalizedOrgID,
		startOfUTCDay(time.Now().UTC()),
		normalizedProvider,
		normalizedLanguage,
		requestCount,
		safeNonNegativeInt(metrics.itemCount),
		safeNonNegativeInt(metrics.textCount),
		safeNonNegativeInt(metrics.cacheHitCount),
		safeNonNegativeInt(metrics.cacheMissCount),
		safeNonNegativeInt(metrics.translatedCount),
		safeNonNegativeInt(metrics.failureCount),
		safeNonNegativeInt(metrics.skipTooLongCount),
		safeNonNegativeInt(latencyMs),
		safeNonNegativeInt(latencyMs),
	)
	if err != nil {
		if isMissingMetricsTableError(err) {
			log.Printf("api-go: RssTranslationMetricsDaily table is missing; run database migrations to enable RSS translation metrics")
			return
		}
		log.Printf("api-go: RSS translation metrics write failed")
	}
}

// newMetricsRowID builds a Prisma-cuid-shaped primary key (c + 24 hex), the
// same shape the other Go batches insert into String @id columns.
func newMetricsRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// safeNonNegativeInt mirrors toSafeInt: a non-finite value is 0 and a finite
// value is truncated and floored at 0.
func safeNonNegativeInt(value int) int {
	if value < 0 {
		return 0
	}
	return value
}

// startOfUTCDay mirrors startOfUtcDay.
func startOfUTCDay(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}

// isMissingMetricsTableError mirrors isPrismaMissingTableError: MySQL 1146
// (unknown table) and 1054 (unknown column) mean the migration has not run.
func isMissingMetricsTableError(err error) bool {
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

//go:build integration

package runtimediagnostics

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

type stubRealtimeSettings struct {
	runtime *dataruntimesettings.RealtimeRuntimeSettings
	source  string
}

func (s stubRealtimeSettings) EffectiveRealtimeRuntime(context.Context) (*dataruntimesettings.RealtimeRuntimeSettings, error) {
	return s.runtime, nil
}

func (s stubRealtimeSettings) EnvRealtimeRuntime() *dataruntimesettings.RealtimeRuntimeSettings {
	return s.runtime
}

func (s stubRealtimeSettings) RealtimeSettingsSource(context.Context) (string, error) {
	return s.source, nil
}

func integrationRuntime(t *testing.T) (*realtimeStore, *realtimeStore) {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	rdb := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = rdb.Close() })
	pool, err := usersettings.OpenMySQLFromURL(url)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	store := newRealtimeStore(rdb, pool, nil)
	return store, store
}

const createProcessedArticle = "CREATE TABLE IF NOT EXISTS ProcessedArticle (" +
	"id VARCHAR(191) NOT NULL," +
	"orgId VARCHAR(191) NOT NULL," +
	"status VARCHAR(32) NOT NULL," +
	"processedAt DATETIME(3) NULL," +
	"hasLocation TINYINT(1) NOT NULL DEFAULT 0," +
	"PRIMARY KEY (id)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

// TestRealtimeDiagnosticsIntegration covers the Redis fixtures, the MySQL marker
// readiness counters and the source status resolution. Mongo is intentionally
// absent: the Mongo half degrades to zeros and is covered by unit fakes in the PR
// note instead of a new CI service.
func TestRealtimeDiagnosticsIntegration(t *testing.T) {
	store, _ := integrationRuntime(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := store.db.ExecContext(ctx, createProcessedArticle); err != nil {
		t.Fatalf("create ProcessedArticle: %v", err)
	}
	const orgID = "org-rt-it"
	if _, err := store.db.ExecContext(ctx, "DELETE FROM ProcessedArticle WHERE orgId = ?", orgID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	rows := []struct {
		id          string
		processedAt time.Time
		hasLocation bool
	}{
		{"ra-1", now.Add(-time.Hour), true},
		{"ra-2", now.Add(-2 * time.Hour), false},
		{"ra-3", now.Add(-30 * 24 * time.Hour), true},
	}
	for _, row := range rows {
		if _, err := store.db.ExecContext(ctx,
			"INSERT INTO ProcessedArticle (id, orgId, status, processedAt, hasLocation) VALUES (?, ?, 'completed', ?, ?)",
			row.id, orgID, row.processedAt, row.hasLocation); err != nil {
			t.Fatal(err)
		}
	}

	// Redis fixtures use the exact keys the NestJS store writes. Only this
	// organization's keys are removed so the other integration packages can run
	// against the same Redis instance.
	for _, key := range []string{
		"realtime-signals:insights:" + orgID,
		"realtime-signals:series:" + orgID + ":realtime.ais.disruptions",
		"realtime-signals:last-run:" + orgID + ":ais",
		"realtime-signals:source-state:" + orgID + ":ais",
	} {
		_ = store.redis.Del(ctx, key).Err()
	}
	insight, _ := json.Marshal(map[string]any{"keywordSpikes": []any{}, "predictionLeads": []any{}, "tensions": []any{}})
	if err := store.redis.Set(ctx, "realtime-signals:insights:"+orgID, insight, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	series, _ := json.Marshal(map[string]any{
		"metricSlug": "realtime.ais.disruptions",
		"points": []map[string]any{
			{"ts": now.Add(-2 * time.Minute).Format(time.RFC3339Nano), "value": 3},
			{"ts": now.Add(-time.Minute).Format(time.RFC3339Nano), "value": 5},
		},
	})
	if err := store.redis.Set(ctx, "realtime-signals:series:"+orgID+":realtime.ais.disruptions", series, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	if err := store.redis.Set(ctx, "realtime-signals:last-run:"+orgID+":ais", now.UnixMilli(), time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	state, _ := json.Marshal(map[string]any{
		"source": "ais", "status": "success",
		"lastAttemptAt": now.Add(-time.Minute).Format("2006-01-02T15:04:05.000Z"),
		"lastSuccessAt": now.Add(-time.Minute).Format("2006-01-02T15:04:05.000Z"),
	})
	if err := store.redis.Set(ctx, "realtime-signals:source-state:"+orgID+":ais", state, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	dateHKT := now.In(hktZone).Format("2006-01-02")
	if err := store.redis.HSet(ctx, "realtime-signals:opensky:credits:"+dateHKT,
		"usedCredits", 100, "militaryCalls", 2, "allCalls", 3, "requestCount", 3).Err(); err != nil {
		t.Fatal(err)
	}

	runtime := &dataruntimesettings.RealtimeRuntimeSettings{
		Enabled:                     true,
		OpenskyEnabled:              true,
		OpenskyIntervalSec:          600,
		OpenskyDailyCreditBudget:    4000,
		OpenskyDayIntervalSec:       600,
		OpenskyNightIntervalSec:     1800,
		OpenskyDayStartHourHKT:      8,
		OpenskyNightStartHourHKT:    22,
		OpenskyWarningRemainingPct:  20,
		OpenskyCriticalRemainingPct: 10,
		AisEnabled:                  true,
		AisIntervalSec:              300,
		UnrestEnabled:               true,
		UnrestIntervalSec:           600,
		OutagesEnabled:              true,
		OutagesIntervalSec:          900,
	}
	service := NewRealtimeService(stubRealtimeSettings{runtime: runtime, source: "db"}, store.redis, store.db, nil)
	service.now = func() time.Time { return now }
	result, err := service.Run(ctx, orgID)
	if err != nil {
		t.Fatal(err)
	}
	if result.SettingsSource != "db" || !result.RuntimeEnabled {
		t.Fatalf("settings = %+v", result)
	}
	if len(result.Sources) != len(realtimeSources) {
		t.Fatalf("sources = %d", len(result.Sources))
	}
	if result.MarkerReadiness.RecentProcessedArticles != 2 ||
		result.MarkerReadiness.RecentProcessedArticlesWithLocation != 1 ||
		!result.MarkerReadiness.NewsMarkersReady {
		t.Fatalf("marker readiness = %+v", result.MarkerReadiness)
	}
	if result.OpenSkyBudget.DailyBudget != 4000 || result.OpenSkyBudget.UsedCredits != 100 {
		t.Fatalf("budget = %+v", result.OpenSkyBudget)
	}
	if len(result.OpenSkyBudget.RecentDays) != openskyBudgetRecentDays {
		t.Fatalf("recent days = %d", len(result.OpenSkyBudget.RecentDays))
	}
	var aisSource *sourceDiagnostics
	for index := range result.Sources {
		if result.Sources[index].Source == "ais" {
			aisSource = &result.Sources[index]
		}
	}
	if aisSource == nil || aisSource.LatestValue == nil || *aisSource.LatestValue != 5 {
		t.Fatalf("ais source = %+v", aisSource)
	}
	if aisSource.PreviousValue == nil || *aisSource.PreviousValue != 3 {
		t.Fatalf("ais previous = %+v", aisSource.PreviousValue)
	}
	if aisSource.Status != "ok" || aisSource.AisDiagnostics == nil {
		t.Fatalf("ais status = %s diagnostics=%+v", aisSource.Status, aisSource.AisDiagnostics)
	}
	if string(result.Insight) == "" {
		t.Fatal("insight is empty")
	}
}

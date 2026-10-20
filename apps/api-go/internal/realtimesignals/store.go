package realtimesignals

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// errNoDatabase is returned when the MySQL pool is not configured.
var errNoDatabase = errors.New("realtimesignals: mysql is not configured")

// Store owns the Redis documents of the collector. Every key, TTL and JSON shape
// matches RealtimeSignalsSnapshotStore, so the NestJS diagnostics and alert
// readers keep working while Go collects (and after a rollback).
type Store struct {
	redis *redis.Client
	db    *sql.DB
}

func NewStore(redisClient *redis.Client, db *sql.DB) *Store {
	return &Store{redis: redisClient, db: db}
}

// metricPoint is one stored point. Context stays raw because the writer produced
// it from a typed struct and the reader treats it as an open JSON object.
type metricPoint struct {
	TS      string          `json:"ts"`
	Value   float64         `json:"value"`
	Context json.RawMessage `json:"context,omitempty"`
}

// metricSeries is the stored series document.
type metricSeries struct {
	MetricSlug string        `json:"metricSlug"`
	Points     []metricPoint `json:"points"`
}

func seriesKey(orgID, metricSlug string) string {
	return seriesKeyFmt + orgID + ":" + metricSlug
}

func lastRunKey(orgID string, source SignalSource) string {
	return lastRunKeyFmt + orgID + ":" + string(source)
}

func insightKey(orgID string) string { return insightKeyFmt + orgID }

func sourceStateKey(orgID string, source SignalSource) string {
	return sourceStateKeyFmt + orgID + ":" + string(source)
}

func adsbLatestKey(orgID string) string { return adsbLatestKeyFmt + orgID }

func aisLatestKey(orgID string) string { return aisLatestKeyFmt + orgID }

// appendPoint reproduces appendPoint: read the whole series, append, keep the
// last 2000 entries, then sort by ts and write with the two-day TTL.
//
// The slice happens BEFORE the sort, exactly like NestJS. Q3 in the pull request
// records the consequence: a back-dated point can be dropped even though sorting
// first would have kept it. Changing the order would change the stored series, so
// the original sequence is preserved.
//
// ts is always an ISO-8601 string with fixed punctuation, so ICU's
// localeCompare and a UTF-16 code-unit comparison agree: every difference is in
// a digit and every digit has the same collation weight. The sort is stable to
// match Array.prototype.sort for equal timestamps.
func (s *Store) appendPoint(ctx context.Context, orgID, metricSlug string, point metricPoint) error {
	key := seriesKey(orgID, metricSlug)
	current, found, err := rediscache.GetJSON[metricSeries](ctx, s.redis, key)
	if err != nil {
		return err
	}
	if !found {
		current = metricSeries{MetricSlug: metricSlug, Points: []metricPoint{}}
	}
	if current.MetricSlug == "" {
		current.MetricSlug = metricSlug
	}
	points := append(current.Points, point)
	if len(points) > seriesMaxPoints {
		points = points[len(points)-seriesMaxPoints:]
	}
	sort.SliceStable(points, func(left, right int) bool {
		return compareUTF16(points[left].TS, points[right].TS) < 0
	})
	return rediscache.SetJSON(ctx, s.redis, key, metricSeries{MetricSlug: metricSlug, Points: points},
		seriesTTLSeconds*time.Second)
}

// getSeries is the read half used by tests and by evaluateMetric.
func (s *Store) getSeries(ctx context.Context, orgID, metricSlug string) ([]metricPoint, error) {
	current, found, err := rediscache.GetJSON[metricSeries](ctx, s.redis, seriesKey(orgID, metricSlug))
	if err != nil || !found {
		return nil, err
	}
	points := make([]metricPoint, 0, len(current.Points))
	for _, point := range current.Points {
		if point.TS == "" {
			continue
		}
		points = append(points, point)
	}
	sort.SliceStable(points, func(left, right int) bool {
		return compareUTF16(points[left].TS, points[right].TS) < 0
	})
	return points, nil
}

// getLatestAdsbSnapshot returns nil when no snapshot is stored.
func (s *Store) getLatestAdsbSnapshot(ctx context.Context, orgID string) (*AdsbSnapshot, error) {
	snapshot, found, err := rediscache.GetJSON[AdsbSnapshot](ctx, s.redis, adsbLatestKey(orgID))
	if err != nil || !found {
		return nil, err
	}
	return &snapshot, nil
}

func (s *Store) setLatestAdsbSnapshot(ctx context.Context, orgID string, snapshot AdsbSnapshot, ttlSeconds int) error {
	if ttlSeconds < 60 {
		ttlSeconds = 60
	}
	return rediscache.SetJSON(ctx, s.redis, adsbLatestKey(orgID), snapshot, time.Duration(ttlSeconds)*time.Second)
}

func (s *Store) clearLatestAdsbSnapshot(ctx context.Context, orgID string) error {
	if s.redis == nil {
		return rediscache.ErrNoClient
	}
	return s.redis.Del(ctx, adsbLatestKey(orgID)).Err()
}

func (s *Store) getLatestAisSnapshot(ctx context.Context, orgID string) (*AisSnapshot, error) {
	snapshot, found, err := rediscache.GetJSON[AisSnapshot](ctx, s.redis, aisLatestKey(orgID))
	if err != nil || !found {
		return nil, err
	}
	return &snapshot, nil
}

func (s *Store) setLatestAisSnapshot(ctx context.Context, orgID string, snapshot AisSnapshot, ttlSeconds int) error {
	if ttlSeconds < 60 {
		ttlSeconds = 60
	}
	return rediscache.SetJSON(ctx, s.redis, aisLatestKey(orgID), snapshot, time.Duration(ttlSeconds)*time.Second)
}

func (s *Store) clearLatestAisSnapshot(ctx context.Context, orgID string) error {
	if s.redis == nil {
		return rediscache.ErrNoClient
	}
	return s.redis.Del(ctx, aisLatestKey(orgID)).Err()
}

// setLastRun stores a millisecond timestamp as a JSON number with the seven-day
// TTL.
func (s *Store) setLastRun(ctx context.Context, orgID string, source SignalSource, tsMs int64) error {
	return rediscache.SetJSON(ctx, s.redis, lastRunKey(orgID, source), tsMs, sourceLastRunTTL*time.Second)
}

// getLastRun reproduces `typeof value === "number" && Number.isFinite(value)`:
// anything else (including a quoted number) reads as no previous run.
func (s *Store) getLastRun(ctx context.Context, orgID string, source SignalSource) (*float64, error) {
	if s.redis == nil {
		return nil, rediscache.ErrNoClient
	}
	raw, err := s.redis.Get(ctx, lastRunKey(orgID, source)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if raw == "" || raw == "null" {
		return nil, nil
	}
	var value float64
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, nil
	}
	return &value, nil
}

func (s *Store) getInsightSnapshot(ctx context.Context, orgID string) (*InsightSnapshot, error) {
	snapshot, found, err := rediscache.GetJSON[InsightSnapshot](ctx, s.redis, insightKey(orgID))
	if err != nil || !found {
		return nil, err
	}
	return &snapshot, nil
}

func (s *Store) setInsightSnapshot(ctx context.Context, orgID string, snapshot InsightSnapshot) error {
	return rediscache.SetJSON(ctx, s.redis, insightKey(orgID), snapshot, insightTTLSeconds*time.Second)
}

func (s *Store) getSourceState(ctx context.Context, orgID string, source SignalSource) (*SourceState, error) {
	if s.redis == nil {
		return nil, rediscache.ErrNoClient
	}
	raw, err := s.redis.Get(ctx, sourceStateKey(orgID, source)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var state SourceState
	if unmarshalErr := json.Unmarshal(raw, &state); unmarshalErr != nil {
		// A non-object state is truthy in JavaScript but every member reads as
		// undefined. Treating it as "no state" reproduces that observation and
		// lets the next write repair it.
		return nil, nil
	}
	return &state, nil
}

func (s *Store) setSourceState(ctx context.Context, orgID string, state SourceState) error {
	return rediscache.SetJSON(ctx, s.redis, sourceStateKey(orgID, state.Source), state, sourceStateTTL*time.Second)
}

// ---- active organizations ----

const (
	activeOrgCacheKey   = "org:active:list:v1"
	activeOrgCacheTTL   = 15 * time.Second
	activeOrgLockTTL    = 2 * time.Second
	activeOrgRetryDelay = 50 * time.Millisecond
	activeOrgMaxWait    = 500 * time.Millisecond
)

// activeOrgEntry is one entry of the active-organization cache.
type activeOrgEntry struct {
	ID string `json:"id"`
}

// listActiveOrgIDs reproduces ActiveOrgRegistryService.listActiveOrgs: the cached
// list first (cached by a short wrap lease), then MySQL ordered by id ascending.
// Any cache or lock failure falls back to the database instead of failing the
// tick.
func (s *Store) listActiveOrgIDs(ctx context.Context) ([]string, error) {
	entries, err := rediscache.Wrap[[]activeOrgEntry](ctx, s.redis, activeOrgCacheKey, activeOrgCacheTTL,
		rediscache.WrapOptions{LockTTL: activeOrgLockTTL, RetryDelay: activeOrgRetryDelay, MaxWait: activeOrgMaxWait},
		func([]activeOrgEntry) bool { return true },
		func(ctx context.Context) ([]activeOrgEntry, error) {
			ids, loadErr := s.loadActiveOrgIDs(ctx)
			if loadErr != nil {
				return nil, loadErr
			}
			return activeOrgEntries(ids), nil
		})
	if err != nil {
		return s.loadActiveOrgIDs(ctx)
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids, nil
}

func (s *Store) loadActiveOrgIDs(ctx context.Context) ([]string, error) {
	if s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = true ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
}

// ---- org concurrency ----

// readOrgConcurrency reads realtimeSignalsOrgConcurrency from the multi-tenant
// scheduler SystemSetting. The NestJS service returns the stored/default value
// and the tick only needs a positive worker count, so a missing or unreadable row
// falls back to the default 4.
func (s *Store) readOrgConcurrency(ctx context.Context) (int, error) {
	if s.db == nil {
		return 4, nil
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
		"multi_tenant_scheduler_runtime_settings").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 4, nil
	}
	if err != nil {
		return 0, err
	}
	var stored struct {
		RealtimeSignalsOrgConcurrency json.RawMessage `json:"realtimeSignalsOrgConcurrency"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		return 0, err
	}
	value, ok := toFiniteNumber(stored.RealtimeSignalsOrgConcurrency)
	if !ok {
		return 4, nil
	}
	truncated := int(jsTrunc(value))
	if truncated < 1 || truncated > 16 {
		return 0, errors.New("realtimesignals: realtimeSignalsOrgConcurrency must be between 1 and 16")
	}
	return truncated, nil
}

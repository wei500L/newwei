package situationsignalsworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// Redis cache keys and TTLs, copied verbatim from
// apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.constants.ts
// and situation-monitor-signals.service.ts.
const (
	telegramStateCacheKey = "situation-monitor:signals:telegram:state:v1"
	orefAlertsCacheKey    = "situation-monitor:signals:oref:alerts:v1"
	orefHistoryCacheKey   = "situation-monitor:signals:oref:history:v1"
	orefMetricsCacheKey   = "situation-monitor:signals:metrics:oref:v1"

	telegramStateCacheTTL = 24 * 60 * 60 * time.Second
	orefAlertsCacheTTL    = 60 * 60 * time.Second
	orefHistoryCacheTTL   = 7 * 24 * 60 * 60 * time.Second

	// orefPollLockKey is the Redis lease that serializes the OREF poll across
	// processes (B1). Its physical name is prefixed with "lock:" by
	// CacheService.withLock semantics (rediscache.WithLock).
	orefPollLockKey = "situation-monitor:signals:oref:poll"
	// orefPollLockTTL must cover one whole OREF cycle: one upstream request
	// capped by OREF_CURL_TIMEOUT_SEC (15s default), the history bootstrap with
	// up to OREF_BOOTSTRAP_MAX_RETRIES attempts (3s/6s backoff) and the alert
	// rule maintenance queries. 120s leaves a wide margin while still bounding
	// how long a crashed owner blocks the other process.
	orefPollLockTTL = 120 * time.Second

	// clearBroadcastChannel is the cross-instance Telegram clear broadcast.
	clearBroadcastChannel = "situation-monitor:telegram-clear:v1"
)

// stateStore is the small Redis surface the cache documents need. It is an
// interface so the pollers can be tested with an in-memory store instead of a
// live Redis; production wires redisStateStore over the shared client.
type stateStore interface {
	// Get returns the raw value. A missing key reports found=false and a nil
	// error.
	Get(ctx context.Context, key string) (value string, found bool, err error)
	// Set writes a value with a TTL.
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// Del removes a key; a missing key is not an error.
	Del(ctx context.Context, key string) error
}

// redisStateStore is stateStore over the shared go-redis client.
type redisStateStore struct {
	client *redis.Client
}

// Get reads one key; redis.Nil is the normal miss.
func (s redisStateStore) Get(ctx context.Context, key string) (string, bool, error) {
	if s.client == nil {
		return "", false, errors.New("situationsignalsworker: redis client is not configured")
	}
	value, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// Set writes one key with its NestJS TTL.
func (s redisStateStore) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if s.client == nil {
		return errors.New("situationsignalsworker: redis client is not configured")
	}
	return s.client.Set(ctx, key, value, ttl).Err()
}

// Del deletes one key.
func (s redisStateStore) Del(ctx context.Context, key string) error {
	if s.client == nil {
		return errors.New("situationsignalsworker: redis client is not configured")
	}
	return s.client.Del(ctx, key).Err()
}

// cycleLocker is the shared lease used for the OREF poll (B1). The
// implementation mirrors CacheService.withLock so NestJS and Go contend for the
// same physical key.
type cycleLocker interface {
	WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error)
}

// redisCycleLocker is cycleLocker over the shared rediscache primitive.
type redisCycleLocker struct {
	client *redis.Client
}

// WithLock runs runner once per Redis lease window.
func (l redisCycleLocker) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	return rediscache.WithLock(ctx, l.client, key, ttl, runner)
}

// telegramState is the in-process scratch buffer of the Telegram poller. B1:
// it is rebuilt from the Redis document at the start of every job and written
// back at the end; the process never treats it as authoritative between jobs.
type telegramState struct {
	ChannelSet             *string
	CursorByHandle         map[string]int64
	Items                  []TelegramItem
	LastPollAt             int64
	LastError              string
	PermanentlyDisabled    bool
	CredentialsFingerprint string
}

// emptyTelegramState mirrors the initial NestJS TelegramState minus the client
// (owned by telegramclient.Manager) and the channels list (reloaded from the
// embedded catalog, never cached).
func emptyTelegramState() telegramState {
	return telegramState{
		CursorByHandle: map[string]int64{},
		Items:          []TelegramItem{},
	}
}

// OrefHistoryEntry is one OREF alert wave. Key order alerts, timestamp is the
// order both implementations write.
type OrefHistoryEntry struct {
	Alerts    []json.RawMessage `json:"alerts"`
	Timestamp string            `json:"timestamp"`
}

// orefState is the in-process scratch buffer of the OREF poller. B1: rebuilt
// from the two cached documents at the start of every job.
type orefState struct {
	LastAlerts        []json.RawMessage
	LastAlertsJSON    string
	LastPollAt        int64
	LastError         string
	HistoryCount24h   int
	TotalHistoryCount int
	History           []OrefHistoryEntry
	BootstrapSource   string
}

// emptyOrefState mirrors the initial NestJS OrefState. lastAlertsJson starts as
// "[]" so the first poll with no active alerts counts as unchanged only when
// the cached state also holds an empty list.
func emptyOrefState() orefState {
	return orefState{
		LastAlerts:     []json.RawMessage{},
		LastAlertsJSON: "[]",
		History:        []OrefHistoryEntry{},
	}
}

// telegramStateDocument is the cached Telegram state document.
// Key order: channelSet, cursorByHandle, items, lastPollAt, lastError.
type telegramStateDocument struct {
	ChannelSet     *string                `json:"channelSet"`
	CursorByHandle map[string]json.Number `json:"cursorByHandle"`
	Items          []TelegramItem         `json:"items"`
	LastPollAt     int64                  `json:"lastPollAt"`
	LastError      *string                `json:"lastError"`
}

// orefAlertsDocument is the cached OREF alerts document.
// Key order: scope, configured, alerts, historyCount24h, totalHistoryCount,
// timestamp, error (omitted when nil).
type orefAlertsDocument struct {
	Scope             string            `json:"scope"`
	Configured        bool              `json:"configured"`
	Alerts            []json.RawMessage `json:"alerts"`
	HistoryCount24h   int               `json:"historyCount24h"`
	TotalHistoryCount int               `json:"totalHistoryCount"`
	Timestamp         string            `json:"timestamp"`
	Error             *string           `json:"error,omitempty"`
}

// orefHistoryDocument is the cached OREF history document.
type orefHistoryDocument struct {
	Scope             string             `json:"scope"`
	Configured        bool               `json:"configured"`
	History           []OrefHistoryEntry `json:"history"`
	HistoryCount24h   int                `json:"historyCount24h"`
	TotalHistoryCount int                `json:"totalHistoryCount"`
	Timestamp         string             `json:"timestamp"`
}

// orefMetricsDocument is the cached OREF metrics document.
type orefMetricsDocument struct {
	ActiveAlerts    int    `json:"activeAlerts"`
	HistoryCount24h int    `json:"historyCount24h"`
	UpdatedAt       string `json:"updatedAt"`
}

// loadTelegramState reads the cached Telegram state (B1). A Redis error is
// returned so the caller can skip the cycle instead of overwriting the cache
// with an empty state; a missing key or a malformed document yields the empty
// state, exactly like the best-effort NestJS restore.
func (s *Service) loadTelegramState(ctx context.Context) (telegramState, error) {
	state := emptyTelegramState()
	raw, found, err := s.store.Get(ctx, telegramStateCacheKey)
	if err != nil {
		return state, err
	}
	if !found || raw == "" {
		return state, nil
	}
	var document telegramStateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		s.logf("situationsignalsworker: telegram state cache is not valid JSON: %v", err)
		return state, nil
	}
	if document.Items == nil {
		// NestJS leaves the state untouched when cached.items is not an array.
		return state, nil
	}
	if document.ChannelSet != nil {
		trimmed := strings.TrimSpace(*document.ChannelSet)
		if trimmed != "" {
			state.ChannelSet = &trimmed
		}
	}
	for handle, number := range document.CursorByHandle {
		normalizedHandle := strings.TrimSpace(handle)
		if normalizedHandle == "" {
			continue
		}
		cursor, err := number.Float64()
		if err != nil || math.IsNaN(cursor) || math.IsInf(cursor, 0) || cursor <= 0 {
			continue
		}
		state.CursorByHandle[normalizedHandle] = int64(math.Trunc(cursor))
	}
	state.Items = document.Items
	state.LastPollAt = document.LastPollAt
	if document.LastError != nil {
		state.LastError = *document.LastError
	}
	return state, nil
}

// persistTelegramState writes the Telegram state document with the NestJS key,
// shape and 24h TTL. A write failure is logged and never fails the poll, which
// is the best-effort semantics of the NestJS CacheService.set call.
func (s *Service) persistTelegramState(ctx context.Context, state telegramState) {
	document := telegramStateDocument{
		ChannelSet:     state.ChannelSet,
		CursorByHandle: make(map[string]json.Number, len(state.CursorByHandle)),
		Items:          state.Items,
		LastPollAt:     state.LastPollAt,
	}
	for handle, cursor := range state.CursorByHandle {
		document.CursorByHandle[handle] = json.Number(strconv.FormatInt(cursor, 10))
	}
	if document.Items == nil {
		document.Items = []TelegramItem{}
	}
	if state.LastError != "" {
		message := state.LastError
		document.LastError = &message
	}
	encoded, err := marshalJSONNoEscape(document)
	if err != nil {
		s.logf("situationsignalsworker: encode telegram state failed: %v", err)
		return
	}
	if err := s.store.Set(ctx, telegramStateCacheKey, encoded, telegramStateCacheTTL); err != nil {
		s.logf("situationsignalsworker: persist telegram state failed: %v", err)
	}
}

// deleteTelegramState removes the shared state document (A2 clear).
func (s *Service) deleteTelegramState(ctx context.Context) {
	if err := s.store.Del(ctx, telegramStateCacheKey); err != nil {
		s.logf("situationsignalsworker: delete telegram state failed: %v", err)
	}
}

// loadOrefState reads both cached OREF documents (B1).
//
// The alert fingerprint is rebuilt from the cached raw alert objects so a
// change comparison against a fresh upstream body sees the same compact JSON
// JSON.stringify would produce. A Redis error is returned so the caller can
// skip the cycle instead of overwriting the cache.
func (s *Service) loadOrefState(ctx context.Context) (orefState, error) {
	state := emptyOrefState()

	rawAlerts, foundAlerts, err := s.store.Get(ctx, orefAlertsCacheKey)
	if err != nil {
		return state, err
	}
	if foundAlerts && rawAlerts != "" {
		var document orefAlertsDocument
		if err := json.Unmarshal([]byte(rawAlerts), &document); err != nil {
			s.logf("situationsignalsworker: oref alerts cache is not valid JSON: %v", err)
		} else {
			if document.Alerts != nil {
				state.LastAlerts = document.Alerts
				state.LastAlertsJSON = marshalAlerts(document.Alerts)
			}
			// Date.parse(alerts.timestamp) || 0: an unparseable timestamp is 0,
			// which the read side renders as "now".
			if parsed, ok := parseJSTimeString(document.Timestamp); ok {
				state.LastPollAt = parsed
			}
			if document.Error != nil {
				state.LastError = *document.Error
			}
		}
	}

	rawHistory, foundHistory, err := s.store.Get(ctx, orefHistoryCacheKey)
	if err != nil {
		return state, err
	}
	if foundHistory && rawHistory != "" {
		var document orefHistoryDocument
		if err := json.Unmarshal([]byte(rawHistory), &document); err != nil {
			s.logf("situationsignalsworker: oref history cache is not valid JSON: %v", err)
		} else if document.History != nil {
			state.History = document.History
			state.HistoryCount24h = document.HistoryCount24h
			state.TotalHistoryCount = document.TotalHistoryCount
		}
	}
	return state, nil
}

// persistedOrefHistory reads only the cached history document and reports
// whether it exists, which is the bootstrapOrefHistoryWithRetry cache check.
func (s *Service) persistedOrefHistory(ctx context.Context) (orefHistoryDocument, bool, error) {
	raw, found, err := s.store.Get(ctx, orefHistoryCacheKey)
	if err != nil {
		return orefHistoryDocument{}, false, err
	}
	if !found || raw == "" {
		return orefHistoryDocument{}, false, nil
	}
	var document orefHistoryDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return orefHistoryDocument{}, false, nil
	}
	if document.History == nil {
		return orefHistoryDocument{}, false, nil
	}
	return document, true, nil
}

// persistOrefAlerts writes the alerts document (1h TTL).
func (s *Service) persistOrefAlerts(ctx context.Context, state orefState, configured bool, timestamp string) {
	document := orefAlertsDocument{
		Scope:             "global",
		Configured:        configured,
		Alerts:            state.LastAlerts,
		HistoryCount24h:   state.HistoryCount24h,
		TotalHistoryCount: state.TotalHistoryCount,
		Timestamp:         timestamp,
	}
	if document.Alerts == nil {
		document.Alerts = []json.RawMessage{}
	}
	if state.LastError != "" {
		message := state.LastError
		document.Error = &message
	}
	encoded, err := marshalJSONNoEscape(document)
	if err != nil {
		s.logf("situationsignalsworker: encode oref alerts failed: %v", err)
		return
	}
	if err := s.store.Set(ctx, orefAlertsCacheKey, encoded, orefAlertsCacheTTL); err != nil {
		s.logf("situationsignalsworker: persist oref alerts failed: %v", err)
	}
}

// persistOrefHistory writes the history document (7d TTL), keeping only the
// last maxWaves entries like persistOrefHistory.
func (s *Service) persistOrefHistory(ctx context.Context, state orefState, configured bool, timestamp string, maxWaves int) {
	document := orefHistoryDocument{
		Scope:             "global",
		Configured:        configured,
		History:           tailHistory(state.History, maxWaves),
		HistoryCount24h:   state.HistoryCount24h,
		TotalHistoryCount: state.TotalHistoryCount,
		Timestamp:         timestamp,
	}
	if document.History == nil {
		document.History = []OrefHistoryEntry{}
	}
	encoded, err := marshalJSONNoEscape(document)
	if err != nil {
		s.logf("situationsignalsworker: encode oref history failed: %v", err)
		return
	}
	if err := s.store.Set(ctx, orefHistoryCacheKey, encoded, orefHistoryCacheTTL); err != nil {
		s.logf("situationsignalsworker: persist oref history failed: %v", err)
	}
}

// persistOrefMetrics writes the metrics snapshot (7d TTL).
func (s *Service) persistOrefMetrics(ctx context.Context, state orefState, updatedAt string) {
	document := orefMetricsDocument{
		ActiveAlerts:    len(state.LastAlerts),
		HistoryCount24h: state.HistoryCount24h,
		UpdatedAt:       updatedAt,
	}
	encoded, err := marshalJSONNoEscape(document)
	if err != nil {
		s.logf("situationsignalsworker: encode oref metrics failed: %v", err)
		return
	}
	if err := s.store.Set(ctx, orefMetricsCacheKey, encoded, orefHistoryCacheTTL); err != nil {
		s.logf("situationsignalsworker: persist oref metrics failed: %v", err)
	}
}

// marshalAlerts renders the change-detection fingerprint: the compact JSON
// array JSON.stringify(alerts) produces. The raw elements of a json.RawMessage
// keep their original key order while insignificant whitespace is removed, and
// HTML characters are not escaped (JSON.stringify leaves them as-is).
func marshalAlerts(alerts []json.RawMessage) string {
	if alerts == nil {
		return "[]"
	}
	encoded, err := marshalJSONNoEscape(alerts)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

// jsonValueIsNull reports whether the raw JSON value is absent or null.
func jsonValueIsNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || string(trimmed) == "null"
}

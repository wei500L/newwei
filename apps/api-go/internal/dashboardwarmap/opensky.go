package dashboardwarmap

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type openskyViewport interface {
	Viewport(ctx context.Context, bbox *[4]float64, now time.Time) (openskyResult, error)
}

type openskyResult struct {
	Configured     bool
	RequiresZoom   bool
	BudgetLimited  bool
	Endpoint       string
	Code           string
	Reason         string
	Remaining      *float64
	Daily          *float64
	DateHKT        string
	Degradation    string
	Snapshot       *adsbSnapshot
}

type requestError struct{ message string }

func (e *requestError) Error() string { return e.message }

type openskyEnv struct {
	SignalsEnabled bool
	TimeoutMs      int
	Enabled        bool
	Daily          int
	DayInterval    int
	NightInterval  int
	DayStart       int
	NightStart     int
	Warning        int
	Critical       int
	BaseURL        string
	TokenURL       string
	ClientID       string
	Secret         string
	EncryptionKey  string
}

type liveOpensky struct {
	redis  *redis.Client
	cache  blobCache
	db     settingsDB
	env    openskyEnv
	http   *http.Client
}

func newLiveOpensky(rdb *redis.Client, cache blobCache, db settingsDB, env openskyEnv) *liveOpensky {
	return &liveOpensky{redis: rdb, cache: cache, db: db, env: env, http: &http.Client{}}
}

const openskyBudgetLua = `
local key = KEYS[1]
local daily_budget = tonumber(ARGV[1]) or 0
local credits = tonumber(ARGV[2]) or 0
local request_count = tonumber(ARGV[3]) or 0
local calls_field = ARGV[4]
local credits_field = ARGV[5]
local ttl_seconds = tonumber(ARGV[6]) or 0

local used_credits = tonumber(redis.call('HGET', key, 'usedCredits') or '0')
local remaining_credits = math.max(0, daily_budget - used_credits)

if credits > 0 and used_credits + credits > daily_budget then
  return {0, used_credits, remaining_credits}
end

if credits > 0 then
  redis.call('HINCRBY', key, 'usedCredits', credits)
end
if request_count > 0 then
  redis.call('HINCRBY', key, 'requestCount', request_count)
  if calls_field and calls_field ~= '' then
    redis.call('HINCRBY', key, calls_field, request_count)
  end
end
if credits > 0 and credits_field and credits_field ~= '' then
  redis.call('HINCRBY', key, credits_field, credits)
end
if ttl_seconds > 0 then
  redis.call('EXPIRE', key, ttl_seconds)
end

local next_used = used_credits + credits
local next_remaining = math.max(0, daily_budget - next_used)
return {1, next_used, next_remaining}
`

var hktZone = time.FixedZone("Asia/Hong_Kong", 8*60*60)

func (o *liveOpensky) Viewport(ctx context.Context, bbox *[4]float64, now time.Time) (openskyResult, error) {
	cfg, err := o.runtime(ctx)
	if err != nil {
		return openskyResult{}, err
	}
	endpoint := cfg.base + "/states/all"
	if bbox != nil {
		endpoint = openskyEndpoint(cfg.base, *bbox)
	}
	if !cfg.signals || !cfg.enabled || cfg.clientID == "" || cfg.secret == "" {
		return openskyResult{Endpoint: endpoint}, nil
	}
	if bbox == nil {
		return openskyResult{Configured: true, RequiresZoom: true, Endpoint: endpoint}, nil
	}
	summary, err := o.budget(ctx, cfg, now)
	if err != nil {
		return openskyResult{}, err
	}
	if summary.degradation != "normal" {
		_ = o.bump(ctx, summary.date, "blockedAllModeCount", now)
		code, reason := budgetMessage(summary.degradation, "")
		return limitedResult(endpoint, summary, code, reason), nil
	}
	vectors, err := o.cachedStates(ctx, cfg, *bbox, now)
	if err != nil {
		if limited, ok := err.(*budgetReserveError); ok {
			_ = o.bump(ctx, summary.date, "blockedAllModeCount", now)
			again, againErr := o.budget(ctx, cfg, time.Now())
			if againErr != nil {
				return openskyResult{}, againErr
			}
			code, reason := budgetMessage(again.degradation, "opensky_budget_insufficient_credits")
			_ = limited
			return limitedResult(endpoint, again, code, reason), nil
		}
		return openskyResult{}, err
	}
	stale := staleThreshold(effectiveInterval(cfg, summary))
	snap := buildAdsb(endpoint, vectors, now, stale)
	return openskyResult{Configured: true, Endpoint: endpoint, Snapshot: snap}, nil
}

type budgetReserveError struct{}

func (budgetReserveError) Error() string { return "opensky budget reserve denied" }

type skyConfig struct {
	signals                              bool
	enabled                              bool
	timeoutMs                            int
	daily, dayInterval, nightInterval    int
	dayStart, nightStart, warning, critical int
	retries                              int
	base, token, clientID, secret        string
}

func (o *liveOpensky) runtime(ctx context.Context) (skyConfig, error) {
	stored := o.stored(ctx)
	cfg := skyConfig{
		signals: o.env.SignalsEnabled, enabled: o.env.Enabled, timeoutMs: clampInt(o.env.TimeoutMs, 1000, 120000),
		daily: clampInt(o.env.Daily, 1, 100000), dayInterval: clampInt(o.env.DayInterval, 30, 86400),
		nightInterval: clampInt(o.env.NightInterval, 30, 86400), dayStart: clampInt(o.env.DayStart, 0, 23),
		nightStart: clampInt(o.env.NightStart, 0, 23), warning: clampInt(o.env.Warning, 1, 99),
		critical: clampInt(o.env.Critical, 0, 98), retries: 2, base: stripSlash(o.env.BaseURL), token: stripSlash(o.env.TokenURL),
		clientID: strings.TrimSpace(o.env.ClientID), secret: strings.TrimSpace(o.env.Secret),
	}
	if cfg.base == "" {
		cfg.base = "https://opensky-network.org/api"
	}
	if cfg.token == "" {
		cfg.token = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
	}
	if stored != nil {
		cfg.signals = asBool(coalesce(stored, "enabled"), cfg.signals)
		cfg.timeoutMs = pickInt(stored, "requestTimeoutMs", cfg.timeoutMs, 1000, 120000)
		cfg.enabled = asBool(coalesce(stored, "openskyEnabled", "adsbEnabled"), cfg.enabled)
		cfg.daily = pickInt(stored, "openskyDailyCreditBudget", cfg.daily, 1, 100000)
		cfg.dayInterval = pickInt(stored, "openskyDayIntervalSec", cfg.dayInterval, 30, 86400)
		cfg.nightInterval = pickInt(stored, "openskyNightIntervalSec", cfg.nightInterval, 30, 86400)
		cfg.dayStart = pickInt(stored, "openskyDayStartHourHkt", cfg.dayStart, 0, 23)
		cfg.nightStart = pickInt(stored, "openskyNightStartHourHkt", cfg.nightStart, 0, 23)
		cfg.warning = pickInt(stored, "openskyWarningRemainingPct", cfg.warning, 1, 99)
		cfg.critical = pickInt(stored, "openskyCriticalRemainingPct", cfg.critical, 0, 98)
		cfg.retries = pickInt(stored, "maxRetries", 2, 0, 6)
		if text := firstURL(stored, "openskyBaseUrl", "adsbBaseUrl"); text != "" {
			cfg.base = text
		}
		if text := firstURL(stored, "openskyTokenUrl"); text != "" {
			cfg.token = text
		}
		if text := storedString(stored["openskyClientId"]); text != "" {
			cfg.clientID = text
		}
		if text := o.secret(stored["openskyClientSecret"]); text != "" {
			cfg.secret = text
		}
	}
	if cfg.dayStart >= cfg.nightStart {
		return skyConfig{}, &requestError{message: "openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt"}
	}
	if cfg.critical >= cfg.warning {
		return skyConfig{}, &requestError{message: "openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct"}
	}
	if cfg.dayInterval > cfg.nightInterval {
		return skyConfig{}, &requestError{message: "openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec"}
	}
	return cfg, nil
}

func (o *liveOpensky) stored(ctx context.Context) map[string]any {
	if o.cache != nil {
		if raw, ok, err := o.cache.Get(ctx, "realtime-signals:settings"); err == nil && ok && len(raw) > 0 {
			var cached map[string]any
			if json.Unmarshal(raw, &cached) == nil {
				if cached["exists"] == false {
					return nil
				}
				if value, ok := cached["value"].(map[string]any); ok {
					return value
				}
				if _, present := cached["exists"]; present {
					return nil
				}
			}
		}
	}
	if o.db == nil {
		return nil
	}
	raw, ok, err := o.db.Setting(ctx, "realtime_signals_settings")
	if err != nil || !ok {
		return nil
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	return doc
}

func (o *liveOpensky) secret(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	payload, ok := value.(map[string]any)
	if !ok || o.env.EncryptionKey == "" {
		return ""
	}
	text, err := decryptSetting(payload, o.env.EncryptionKey)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(text)
}

type budgetView struct {
	date, degradation, period string
	remaining, daily          float64
}

func (o *liveOpensky) budget(ctx context.Context, cfg skyConfig, now time.Time) (budgetView, error) {
	date := hktDate(now)
	used := 0.0
	if o.redis != nil {
		payload, err := o.redis.HGetAll(ctx, "realtime-signals:opensky:credits:"+date).Result()
		if err != nil && err != redis.Nil {
			return budgetView{}, err
		}
		if text := payload["usedCredits"]; text != "" {
			if parsed, err := strconv.ParseFloat(text, 64); err == nil {
				used = parsed
			}
		}
	}
	daily := float64(max(1, cfg.daily))
	remaining := math.Max(0, daily-used)
	remainingPct := (remaining / daily) * 100
	level := "normal"
	switch {
	case remaining <= 0:
		level = "exhausted"
	case remainingPct <= float64(cfg.critical):
		level = "critical"
	case remainingPct <= float64(cfg.warning):
		level = "warning"
	}
	hour := now.In(hktZone).Hour()
	period := "night"
	if hour >= cfg.dayStart && hour < cfg.nightStart {
		period = "day"
	}
	return budgetView{date: date, degradation: level, period: period, remaining: remaining, daily: daily}, nil
}

func (o *liveOpensky) cachedStates(ctx context.Context, cfg skyConfig, bbox [4]float64, now time.Time) ([][]any, error) {
	key := "realtime-signals:opensky:viewport:" + jsFixed3(bbox[0]) + "," + jsFixed3(bbox[1]) + "," + jsFixed3(bbox[2]) + "," + jsFixed3(bbox[3])
	if raw, ok := o.cacheGet(ctx, key); ok {
		return decodeVectors(raw)
	}
	lockKey := "lock:" + key
	token := randomToken()
	locked := false
	if o.redis != nil {
		ok, err := o.redis.SetNX(ctx, lockKey, token, 20*time.Second).Result()
		if err != nil {
			return nil, err
		}
		locked = ok
		if !locked {
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(100 * time.Millisecond):
				}
				if raw, ok := o.cacheGet(ctx, key); ok {
					return decodeVectors(raw)
				}
				ok, err := o.redis.SetNX(ctx, lockKey, token, 20*time.Second).Result()
				if err != nil {
					return nil, err
				}
				if ok {
					locked = true
					break
				}
			}
		}
	}
	if locked {
		defer o.unlock(ctx, lockKey, token)
	}
	if raw, ok := o.cacheGet(ctx, key); ok {
		return decodeVectors(raw)
	}
	vectors, err := o.fetchStates(ctx, cfg, bbox, now)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(vectors)
	if err == nil && o.cache != nil {
		_ = o.cache.Set(ctx, key, encoded, 15*time.Second)
	}
	return rawOnly(vectors), nil
}

func (o *liveOpensky) fetchStates(ctx context.Context, cfg skyConfig, bbox [4]float64, now time.Time) ([]map[string]any, error) {
	token, err := o.token(ctx, cfg)
	if err != nil {
		_ = o.noteError(ctx, err, now)
		return nil, err
	}
	credits := estimateCredits(bbox)
	allowed, err := o.reserve(ctx, cfg, credits, now)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, &budgetReserveError{}
	}
	payload, err := o.getJSON(ctx, openskyEndpoint(cfg.base, bbox), token, cfg.timeoutMs)
	if err != nil {
		_ = o.noteError(ctx, err, now)
		return nil, err
	}
	return readVectors(payload), nil
}

func (o *liveOpensky) token(ctx context.Context, cfg skyConfig) (string, error) {
	cacheKey := "realtime-signals:opensky:oauth:" + encodeURIComponent(cfg.token+"|"+cfg.clientID)
	if raw, ok := o.cacheGet(ctx, cacheKey); ok {
		var doc map[string]any
		if json.Unmarshal(raw, &doc) == nil {
			if text := cleanString(doc["accessToken"]); text != "" {
				return text, nil
			}
		}
	}
	body := url.Values{}
	body.Set("grant_type", "client_credentials")
	body.Set("client_id", cfg.clientID)
	body.Set("client_secret", cfg.secret)
	timeout := cfg.timeoutMs
	if timeout < 1000 {
		timeout = 1000
	}
	var last error
	attempts := cfg.retries
	if attempts < 0 {
		attempts = 0
	}
	for attempt := 0; attempt <= attempts; attempt++ {
		reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, cfg.token, strings.NewReader(body.Encode()))
		if err != nil {
			cancel()
			return "", err
		}
		req.Header.Set("content-type", "application/x-www-form-urlencoded")
		resp, err := o.http.Do(req)
		if err != nil {
			cancel()
			last = err
			if attempt < attempts && retryable(err, 0) {
				time.Sleep(time.Duration(300*(attempt+1)) * time.Millisecond)
				continue
			}
			return "", err
		}
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		if resp.StatusCode >= 400 {
			last = &httpStatusError{status: resp.StatusCode, body: string(payload)}
			if attempt < attempts && retryable(last, resp.StatusCode) {
				time.Sleep(time.Duration(300*(attempt+1)) * time.Millisecond)
				continue
			}
			return "", last
		}
		var doc map[string]any
		if json.Unmarshal(payload, &doc) != nil {
			return "", errString("OpenSky OAuth token response did not include access_token")
		}
		access := cleanString(doc["access_token"])
		if access == "" {
			return "", errString("OpenSky OAuth token response did not include access_token")
		}
		expires := 300
		if value, ok := finite(doc["expires_in"]); ok {
			expires = int(value)
		}
		if expires < 60 {
			expires = 60
		}
		ttl := expires - 60
		if ttl < 30 {
			ttl = 30
		}
		encoded, _ := json.Marshal(map[string]any{"accessToken": access})
		if o.cache != nil {
			_ = o.cache.Set(ctx, cacheKey, encoded, time.Duration(ttl)*time.Second)
		}
		return access, nil
	}
	if last == nil {
		last = errString("OpenSky OAuth token response did not include access_token")
	}
	return "", last
}

type httpStatusError struct {
	status int
	body   string
}

func (e *httpStatusError) Error() string {
	return "HTTP " + strconv.Itoa(e.status)
}

func (o *liveOpensky) getJSON(ctx context.Context, endpoint, token string, timeoutMs int) (map[string]any, error) {
	if timeoutMs < 1000 {
		timeoutMs = 1000
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+token)
	resp, err := o.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 400 {
		return nil, &httpStatusError{status: resp.StatusCode, body: string(payload)}
	}
	var doc map[string]any
	if err := json.Unmarshal(payload, &doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func (o *liveOpensky) reserve(ctx context.Context, cfg skyConfig, credits int, now time.Time) (bool, error) {
	if o.redis == nil {
		return false, errString("redis is not configured")
	}
	date := hktDate(now)
	key := "realtime-signals:opensky:credits:" + date
	result, err := o.redis.Eval(ctx, openskyBudgetLua, []string{key}, max(1, cfg.daily), credits, 1, "allCalls", "allCredits", 14*24*60*60).Result()
	if err != nil {
		return false, err
	}
	rows, _ := result.([]any)
	if len(rows) == 0 {
		return false, nil
	}
	return numberValue(rows[0]) == 1, nil
}

func (o *liveOpensky) bump(ctx context.Context, date, field string, now time.Time) error {
	if o.redis == nil {
		return nil
	}
	if date == "" {
		date = hktDate(now)
	}
	key := "realtime-signals:opensky:credits:" + date
	if err := o.redis.HIncrBy(ctx, key, field, 1).Err(); err != nil {
		return err
	}
	return o.redis.Expire(ctx, key, 14*24*time.Hour).Err()
}

func (o *liveOpensky) noteError(ctx context.Context, cause error, now time.Time) error {
	field := "unknownErrorCalls"
	switch openskyKind(cause) {
	case "auth":
		field = "authErrorCalls"
	case "rate_limited":
		field = "rateLimitedErrorCalls"
	case "server":
		field = "serverErrorCalls"
	case "timeout":
		field = "timeoutErrorCalls"
	case "network":
		field = "networkErrorCalls"
	}
	if o.redis == nil {
		return nil
	}
	key := "realtime-signals:opensky:credits:" + hktDate(now)
	_ = o.redis.HIncrBy(ctx, key, "errorCalls", 1).Err()
	_ = o.redis.HIncrBy(ctx, key, field, 1).Err()
	return o.redis.Expire(ctx, key, 14*24*time.Hour).Err()
}

func (o *liveOpensky) cacheGet(ctx context.Context, key string) ([]byte, bool) {
	if o.cache == nil {
		return nil, false
	}
	raw, ok, err := o.cache.Get(ctx, key)
	if err != nil || !ok || len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	return raw, true
}

func (o *liveOpensky) unlock(ctx context.Context, key, token string) {
	if o.redis == nil {
		return
	}
	const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`
	_, _ = o.redis.Eval(ctx, script, []string{key}, token).Result()
}

func limitedResult(endpoint string, summary budgetView, code, reason string) openskyResult {
	remaining := summary.remaining
	daily := summary.daily
	return openskyResult{
		Configured: true, BudgetLimited: true, Endpoint: endpoint, Code: code, Reason: reason,
		Remaining: &remaining, Daily: &daily, DateHKT: summary.date, Degradation: summary.degradation,
	}
}

func budgetMessage(level, code string) (string, string) {
	if code == "opensky_budget_insufficient_credits" {
		return code, "OpenSky does not have enough remaining daily credits for this request."
	}
	switch level {
	case "critical":
		return "opensky_budget_critical", "OpenSky all-flight mode is limited and military polling is running at the night interval to preserve the daily credit budget."
	case "exhausted":
		return "opensky_budget_exhausted", "OpenSky daily credit budget is exhausted; all-flight mode is paused until the next Hong Kong day begins."
	default:
		return "opensky_budget_warning", "OpenSky all-flight mode is temporarily limited to preserve the daily credit budget."
	}
}

func effectiveInterval(cfg skyConfig, summary budgetView) int {
	configured := cfg.nightInterval
	if summary.period == "day" {
		configured = cfg.dayInterval
	}
	if summary.degradation == "critical" || summary.degradation == "exhausted" {
		if cfg.nightInterval > configured {
			return cfg.nightInterval
		}
	}
	return configured
}

func staleThreshold(interval int) int {
	if interval < 60 {
		interval = 60
	}
	value := interval * 6
	if value < 600 {
		value = 600
	}
	if value > 1800 {
		value = 1800
	}
	return value
}

func estimateCredits(bbox [4]float64) int {
	area := math.Abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
	switch {
	case area <= 25:
		return 1
	case area <= 100:
		return 2
	case area <= 400:
		return 3
	default:
		return 4
	}
}

func openskyEndpoint(base string, bbox [4]float64) string {
	return strings.TrimRight(base, "/") + "/states/all?lamin=" + jsNumber(bbox[1]) + "&lomin=" + jsNumber(bbox[0]) + "&lamax=" + jsNumber(bbox[3]) + "&lomax=" + jsNumber(bbox[2])
}

func hktDate(now time.Time) string {
	return now.In(hktZone).Format("2006-01-02")
}

func jsFixed3(value float64) string {
	return strconv.FormatFloat(value, 'f', 3, 64)
}

func jsNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func decodeVectors(raw []byte) ([][]any, error) {
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	return rawOnly(rows), nil
}

func rawOnly(rows []map[string]any) [][]any {
	out := make([][]any, 0, len(rows))
	for _, row := range rows {
		raw, _ := row["raw"].([]any)
		if raw == nil {
			continue
		}
		out = append(out, raw)
	}
	return out
}

func readVectors(payload map[string]any) []map[string]any {
	states, _ := payload["states"].([]any)
	out := make([]map[string]any, 0, len(states))
	for _, entry := range states {
		raw, ok := entry.([]any)
		if !ok {
			continue
		}
		vector := parseVector(raw)
		if vector != nil {
			out = append(out, vector)
		}
	}
	return out
}

func parseVector(entry []any) map[string]any {
	icao := strings.ToLower(cleanString(at(entry, 0)))
	if icao == "" {
		return nil
	}
	last := finiteOr(at(entry, 4), finiteOr(at(entry, 3), 0))
	lastMs := int64(math.Max(0, math.Trunc(last*1000)))
	vector := map[string]any{"icao24": icao, "lastContactMs": lastMs, "raw": entry}
	if text := cleanString(at(entry, 1)); text != "" {
		vector["callsign"] = text
	}
	if text := cleanString(at(entry, 2)); text != "" {
		vector["countryName"] = text
	}
	if lastMs > 0 {
		vector["lastContactAt"] = time.UnixMilli(lastMs).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return vector
}

func buildAdsb(endpoint string, raws [][]any, now time.Time, staleSec int) *adsbSnapshot {
	type scored struct {
		craft adsbCraft
		score int
		at    int64
	}
	chosen := map[string]scored{}
	for _, raw := range raws {
		craft, ok, stale, missing := normalizeCraft(raw, now, staleSec)
		if !ok {
			_ = stale
			_ = missing
			continue
		}
		next := scored{craft: craft, score: craftScore(craft), at: parseMillis(craft.ObservedAt)}
		if current, exists := chosen[craft.ID]; exists {
			if next.at > current.at || (next.at == current.at && next.score >= current.score) {
				chosen[craft.ID] = next
			}
			continue
		}
		chosen[craft.ID] = next
	}
	list := make([]adsbCraft, 0, len(chosen))
	for _, item := range chosen {
		list = append(list, item.craft)
	}
	sort.SliceStable(list, func(i, j int) bool {
		left, right := parseMillis(list[i].ObservedAt), parseMillis(list[j].ObservedAt)
		if left != right {
			return left > right
		}
		return list[i].ID < list[j].ID
	})
	snap := &adsbSnapshot{Endpoint: endpoint, UpdatedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"), Total: len(raws), Valid: len(list), StaleSec: staleSec}
	if len(list) > 0 {
		snap.LatestObserved = list[0].ObservedAt
	}
	snap.Aircraft = list
	return snap
}

func normalizeCraft(raw []any, now time.Time, staleSec int) (adsbCraft, bool, bool, bool) {
	vector := parseVector(raw)
	if vector == nil {
		return adsbCraft{}, false, false, false
	}
	lat, latOK := finite(at(raw, 6))
	lng, lngOK := finite(at(raw, 5))
	if !latOK || !lngOK || lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return adsbCraft{}, false, false, false
	}
	observed := now.UTC()
	if text, ok := vector["lastContactAt"].(string); ok {
		if parsed := parseAnyTime(text); parsed != nil {
			observed = parsed.UTC()
		}
	}
	if now.UnixMilli()-observed.UnixMilli() > int64(staleSec)*1000 {
		return adsbCraft{}, false, true, false
	}
	craft := adsbCraft{
		ID: vector["icao24"].(string), ICAO24: vector["icao24"].(string), Lat: lat, Lng: lng,
		ObservedAt: observed.Format("2006-01-02T15:04:05.000Z"), Source: "opensky",
		Callsign: cleanString(vector["callsign"]),
	}
	if heading, ok := finite(at(raw, 10)); ok {
		craft.Heading = &heading
	}
	if alt, ok := finite(at(raw, 13)); ok {
		feet := float64(jsRound(alt * 3.28084))
		craft.AltitudeFt = &feet
	} else if alt, ok := finite(at(raw, 7)); ok {
		feet := float64(jsRound(alt * 3.28084))
		craft.AltitudeFt = &feet
	}
	if speed, ok := finite(at(raw, 9)); ok {
		knots := float64(jsRound(speed * 1.94384))
		craft.GroundSpeedKt = &knots
	}
	if country := cleanString(vector["countryName"]); country != "" {
		craft.CountryName = country
		if code := resolveCountry(country); code != "" {
			craft.CountryCode = code
		}
	}
	return craft, true, false, false
}

func resolveCountry(name string) string {
	if code := countryAlpha2(extractCountryCodeFromText(name)); code != "" {
		return code
	}
	if code := countryAlpha2(normalizeCountryCode(name)); code != "" {
		return code
	}
	return countryAlpha2(name)
}

func craftScore(craft adsbCraft) int {
	score := 0
	if craft.Callsign != "" {
		score++
	}
	if craft.Registration != "" {
		score++
	}
	if craft.AircraftType != "" {
		score++
	}
	if craft.CountryCode != "" {
		score++
	}
	if craft.Heading != nil {
		score++
	}
	if craft.AltitudeFt != nil {
		score++
	}
	if craft.GroundSpeedKt != nil {
		score++
	}
	return score
}

func at(entry []any, index int) any {
	if index < 0 || index >= len(entry) {
		return nil
	}
	return entry[index]
}

func finiteOr(value any, fallback float64) float64 {
	if parsed, ok := finite(value); ok {
		return parsed
	}
	if text, ok := value.(string); ok {
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed
		}
	}
	return fallback
}

func openskyKind(err error) string {
	var status *httpStatusError
	if errors.As(err, &status) {
		switch {
		case status.status == 401 || status.status == 403:
			return "auth"
		case status.status == 429:
			return "rate_limited"
		case status.status >= 500:
			return "server"
		}
	}
	if err == context.DeadlineExceeded || (err != nil && strings.Contains(strings.ToLower(err.Error()), "timeout")) {
		return "timeout"
	}
	if err != nil {
		text := strings.ToLower(err.Error())
		switch {
		case strings.Contains(text, "access_token") || strings.Contains(text, "unauthorized") || strings.Contains(text, "forbidden"):
			return "auth"
		case strings.Contains(text, "429") || strings.Contains(text, "rate limit"):
			return "rate_limited"
		case strings.Contains(text, "network") || strings.Contains(text, "connection"):
			return "network"
		}
	}
	return "unknown"
}

func retryable(err error, status int) bool {
	kind := openskyKind(err)
	if status == 429 || status >= 500 {
		return true
	}
	return kind == "rate_limited" || kind == "server" || kind == "timeout" || kind == "network"
}

func coalesce(doc map[string]any, keys ...string) any {
	for _, key := range keys {
		value, ok := doc[key]
		if !ok || value == nil {
			continue
		}
		return value
	}
	return nil
}

func asBool(value any, fallback bool) bool {
	parsed, ok := value.(bool)
	if !ok {
		return fallback
	}
	return parsed
}

func pickInt(doc map[string]any, key string, fallback, min, max int) int {
	value, ok := doc[key]
	if !ok {
		return clampInt(fallback, min, max)
	}
	if value == nil {
		return clampInt(0, min, max)
	}
	parsed, ok := finite(value)
	if !ok {
		if text, isString := value.(string); isString {
			number, convErr := strconv.ParseFloat(strings.TrimSpace(text), 64)
			if convErr != nil || math.IsNaN(number) || math.IsInf(number, 0) {
				return clampInt(fallback, min, max)
			}
			parsed = number
			ok = true
		}
	}
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return clampInt(fallback, min, max)
	}
	return clampInt(int(math.Trunc(parsed)), min, max)
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func storedString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func firstURL(doc map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := doc[key]
		if !ok || value == nil {
			continue
		}
		if text := stripSlash(storedString(value)); text != "" {
			return text
		}
	}
	return ""
}

func stripSlash(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func encodeURIComponent(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || strings.ContainsRune("-_.!~*'()", rune(ch)) {
			b.WriteByte(ch)
			continue
		}
		b.WriteString("%")
		b.WriteString(strings.ToUpper(hex.EncodeToString([]byte{ch})))
	}
	return b.String()
}

func randomToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "opensky-lock"
	}
	return hex.EncodeToString(buf)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

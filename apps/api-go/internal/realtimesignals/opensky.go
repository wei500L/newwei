package realtimesignals

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// OpenSky: OAuth token cache, the daily credit ledger, the conservative military
// region batch and the global all-flight capture. The budget key, the Lua reserve
// script and the ledger fields are shared with NestJS and with the diagnostics
// reader, so the script below is the same text the NestJS service executes.
const openSkyBudgetReserveLua = `
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

// budgetMarkable is the Go equivalent of the `__openskyBudgetErrorRecorded` flag
// NestJS sets on an error object: a token failure recorded in getAccessToken must
// not be counted again by an outer catch.
type budgetMarkable interface {
	markBudgetErrorRecorded() bool
}

type budgetExhaustedError struct {
	message  string
	recorded bool
}

func (e *budgetExhaustedError) Error() string { return e.message }

func (e *budgetExhaustedError) markBudgetErrorRecorded() bool {
	if e.recorded {
		return true
	}
	e.recorded = true
	return false
}

type budgetReserveError struct {
	message  string
	recorded bool
}

func (e *budgetReserveError) Error() string { return e.message }

func (e *budgetReserveError) markBudgetErrorRecorded() bool {
	if e.recorded {
		return true
	}
	e.recorded = true
	return false
}

// openSkyCredentialError is the missing-credentials failure. It is classified as
// "auth" by the message rule, exactly like the NestJS Error.
type openSkyCredentialError struct {
	message  string
	recorded bool
}

func (e *openSkyCredentialError) Error() string { return e.message }

func (e *openSkyCredentialError) markBudgetErrorRecorded() bool {
	if e.recorded {
		return true
	}
	e.recorded = true
	return false
}

func (e *upstreamError) markBudgetErrorRecorded() bool {
	if e.budgetRecorded {
		return true
	}
	e.budgetRecorded = true
	return false
}

// openSkyService owns the OpenSky calls. It is stateless apart from the store and
// the shared HTTP client.
type openSkyService struct {
	store     *Store
	http      *httpClient
	transport *TransportPersistence
	now       func() time.Time
}

func newOpenSkyService(store *Store, httpClient *httpClient, transport *TransportPersistence) *openSkyService {
	return &openSkyService{store: store, http: httpClient, transport: transport, now: time.Now}
}

func (o *openSkyService) clockMillis() int64 {
	if o != nil && o.now != nil {
		return o.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

func hasOpenSkyCredentials(runtime *dataruntimesettings.RealtimeCronRuntime) bool {
	return jsTrim(runtime.Opensky.ClientID) != "" && jsTrim(runtime.Opensky.ClientSecret) != ""
}

func openSkyBaseURL(runtime *dataruntimesettings.RealtimeCronRuntime) string {
	return normalizeURL(runtime.Opensky.BaseURL, openskyDefaultBaseURL)
}

func openSkyTokenURL(runtime *dataruntimesettings.RealtimeCronRuntime) string {
	return normalizeURL(runtime.Opensky.TokenURL, openskyDefaultTokenURL)
}

// normalizeURL mirrors normalizeUrl plus the `?? default` fallback.
func normalizeURL(value, fallback string) string {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return fallback
	}
	return strings.TrimRight(trimmed, "/")
}

// openSkyEndpoint mirrors buildOpenskyStatesEndpoint: the four bbox parameters in
// lamin, lomin, lamax, lomax order, formatted with JavaScript String(number).
func openSkyEndpoint(baseURL string, bbox [4]float64) string {
	minLng, minLat, maxLng, maxLat := bbox[0], bbox[1], bbox[2], bbox[3]
	return strings.TrimRight(baseURL, "/") + "/states/all?lamin=" + jsNumberString(minLat) +
		"&lomin=" + jsNumberString(minLng) +
		"&lamax=" + jsNumberString(maxLat) +
		"&lomax=" + jsNumberString(maxLng)
}

// estimateOpenSkyCreditsForBBox mirrors estimateOpenskyCreditsForBbox.
func estimateOpenSkyCreditsForBBox(bbox [4]float64) int {
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

// hktDate renders the Hong Kong ledger date.
func hktDate(millis int64) string {
	return time.UnixMilli(millis).In(hktZone).Format("2006-01-02")
}

func hktHour(millis int64) int {
	return time.UnixMilli(millis).In(hktZone).Hour()
}

func budgetPeriod(runtime *dataruntimesettings.RealtimeCronRuntime, millis int64) string {
	hour := hktHour(millis)
	if hour >= runtime.Opensky.DayStartHourHKT && hour < runtime.Opensky.NightStartHourHKT {
		return "day"
	}
	return "night"
}

func configuredMilitaryInterval(runtime *dataruntimesettings.RealtimeCronRuntime, period string) int {
	if period == "day" {
		return runtime.Opensky.DayIntervalSec
	}
	return runtime.Opensky.NightIntervalSec
}

func budgetDegradation(runtime *dataruntimesettings.RealtimeCronRuntime, remaining, remainingPct float64) string {
	if remaining <= 0 {
		return "exhausted"
	}
	if remainingPct <= float64(runtime.Opensky.CriticalRemainingPct) {
		return "critical"
	}
	if remainingPct <= float64(runtime.Opensky.WarningRemainingPct) {
		return "warning"
	}
	return "normal"
}

func effectiveMilitaryInterval(runtime *dataruntimesettings.RealtimeCronRuntime, period, degradation string) int {
	configured := configuredMilitaryInterval(runtime, period)
	if degradation == "critical" || degradation == "exhausted" {
		if configured < runtime.Opensky.NightIntervalSec {
			return runtime.Opensky.NightIntervalSec
		}
	}
	return configured
}

// getBudgetDay reads the ledger hash. Every counter defaults to 0 when the field
// is absent or unparseable.
func (o *openSkyService) getBudgetDay(ctx context.Context, dateHKT string) (budgetDay, error) {
	day := budgetDay{DateHKT: dateHKT}
	if o.store.redis == nil {
		return day, rediscache.ErrNoClient
	}
	payload, err := o.store.redis.HGetAll(ctx, openskyCreditsKeyFmt+dateHKT).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return day, err
	}
	read := func(field string) float64 {
		value, ok := payload[field]
		if !ok || value == "" {
			return 0
		}
		parsed, parseErr := strconv.ParseFloat(value, 64)
		if parseErr != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0
		}
		return parsed
	}
	day.UsedCredits = read("usedCredits")
	day.RequestCount = read("requestCount")
	day.MilitaryCredits = read("militaryCredits")
	day.AllCredits = read("allCredits")
	day.MilitaryCalls = read("militaryCalls")
	day.AllCalls = read("allCalls")
	day.ErrorCalls = read("errorCalls")
	day.AuthErrorCalls = read("authErrorCalls")
	day.RateLimitedErrorCalls = read("rateLimitedErrorCalls")
	day.ServerErrorCalls = read("serverErrorCalls")
	day.TimeoutErrorCalls = read("timeoutErrorCalls")
	day.NetworkErrorCalls = read("networkErrorCalls")
	day.UnknownErrorCalls = read("unknownErrorCalls")
	day.BlockedAllModeCount = read("blockedAllModeCount")
	day.SkippedMilitaryCount = read("skippedMilitaryCount")
	return day, nil
}

// getBudgetSummary mirrors getOpenskyBudgetSummary for the members the collector
// consumes. The recent-day history is a diagnostics-only field and is not read
// here, which avoids six extra HGETALL round trips per organization per tick.
func (o *openSkyService) getBudgetSummary(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime, nowMs int64) (budgetSummary, error) {
	dateHKT := hktDate(nowMs)
	today, err := o.getBudgetDay(ctx, dateHKT)
	if err != nil {
		return budgetSummary{}, err
	}
	dailyBudget := runtime.Opensky.DailyCreditBudget
	if dailyBudget < 1 {
		dailyBudget = 1
	}
	remaining := math.Max(0, float64(dailyBudget)-today.UsedCredits)
	usagePct := jsFixedNumber(today.UsedCredits/float64(dailyBudget)*100, 2)
	remainingPct := jsFixedNumber(remaining/float64(dailyBudget)*100, 2)
	period := budgetPeriod(runtime, nowMs)
	degradation := budgetDegradation(runtime, remaining, remainingPct)
	effective := effectiveMilitaryInterval(runtime, period, degradation)
	return budgetSummary{
		DateHKT:                      dateHKT,
		DailyBudget:                  dailyBudget,
		UsedCredits:                  today.UsedCredits,
		RemainingCredits:             remaining,
		UsagePct:                     usagePct,
		RemainingPct:                 remainingPct,
		CurrentPeriod:                period,
		EffectiveMilitaryIntervalSec: effective,
		DegradationLevel:             degradation,
		AllModeBlocked:               degradation != "normal",
		MilitaryPaused:               degradation == "exhausted",
	}, nil
}

// buildBudgetContext is buildOpenskyBudgetContext.
func buildBudgetContext(summary budgetSummary) openSkyBudgetContext {
	return openSkyBudgetContext{
		DateHKT:              summary.DateHKT,
		DailyCreditBudget:    summary.DailyBudget,
		UsedCredits:          summary.UsedCredits,
		RemainingCredits:     summary.RemainingCredits,
		UsagePct:             summary.UsagePct,
		CurrentPeriod:        summary.CurrentPeriod,
		EffectiveIntervalSec: summary.EffectiveMilitaryIntervalSec,
		BudgetDegradation:    summary.DegradationLevel,
		AllModeBlocked:       summary.AllModeBlocked,
		MilitaryPaused:       summary.MilitaryPaused,
	}
}

func callsField(scope string) string {
	if scope == "military" {
		return "militaryCalls"
	}
	return "allCalls"
}

func creditsField(scope string) string {
	if scope == "military" {
		return "militaryCredits"
	}
	return "allCredits"
}

// reserveOpenSkyCredits mirrors reserveOpenskyCredits.
func (o *openSkyService) reserveOpenSkyCredits(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime, scope string, credits, requestCount int, occurredAtMs int64) (bool, float64, float64, error) {
	if o.store.redis == nil {
		return false, 0, 0, rediscache.ErrNoClient
	}
	dateHKT := hktDate(occurredAtMs)
	key := openskyCreditsKeyFmt + dateHKT
	dailyBudget := runtime.Opensky.DailyCreditBudget
	if dailyBudget < 1 {
		dailyBudget = 1
	}
	if credits < 0 {
		credits = 0
	}
	if requestCount < 0 {
		requestCount = 0
	}
	result, err := o.store.redis.Eval(ctx, openSkyBudgetReserveLua, []string{key},
		dailyBudget, credits, requestCount, callsField(scope), creditsField(scope),
		openskyBudgetRetentionDay*24*60*60).Result()
	if err != nil {
		return false, 0, 0, err
	}
	rows, ok := result.([]any)
	if !ok || len(rows) < 3 {
		return false, 0, 0, nil
	}
	allowed := numberFromRedis(rows[0]) == 1
	return allowed, numberFromRedis(rows[1]), numberFromRedis(rows[2]), nil
}

func numberFromRedis(value any) float64 {
	switch typed := value.(type) {
	case int64:
		return float64(typed)
	case int:
		return float64(typed)
	case float64:
		return typed
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

// recordOpenSkyBudgetEvent mirrors recordOpenskyBudgetEvent.
func (o *openSkyService) recordOpenSkyBudgetEvent(ctx context.Context, field string, occurredAtMs int64) error {
	if o.store.redis == nil {
		return rediscache.ErrNoClient
	}
	key := openskyCreditsKeyFmt + hktDate(occurredAtMs)
	if err := o.store.redis.HIncrBy(ctx, key, field, 1).Err(); err != nil {
		return err
	}
	return o.store.redis.Expire(ctx, key, openskyBudgetRetentionDay*24*time.Hour).Err()
}

// recordOpenSkyError mirrors recordOpenskyError, including the once-per-error
// marker.
func (o *openSkyService) recordOpenSkyError(ctx context.Context, err error, occurredAtMs int64) error {
	if err == nil {
		return nil
	}
	if markable, ok := err.(budgetMarkable); ok && markable.markBudgetErrorRecorded() {
		return nil
	}
	if o.store.redis == nil {
		return rediscache.ErrNoClient
	}
	details := diagnosticErrorDetails(err)
	kind := details.Kind
	if kind == "" {
		kind = kindUnknown
	}
	key := openskyCreditsKeyFmt + hktDate(occurredAtMs)
	pipe := o.store.redis.Pipeline()
	pipe.HIncrBy(ctx, key, "errorCalls", 1)
	pipe.HIncrBy(ctx, key, openSkyErrorBudgetField(kind), 1)
	pipe.Expire(ctx, key, openskyBudgetRetentionDay*24*time.Hour)
	_, runErr := pipe.Exec(ctx)
	return runErr
}

func openSkyErrorBudgetField(kind string) string {
	switch kind {
	case kindAuth:
		return "authErrorCalls"
	case kindRateLimited:
		return "rateLimitedErrorCalls"
	case kindServer:
		return "serverErrorCalls"
	case kindTimeout:
		return "timeoutErrorCalls"
	case kindNetwork:
		return "networkErrorCalls"
	default:
		return "unknownErrorCalls"
	}
}

// getAccessToken mirrors getOpenskyAccessToken: the cache key is
// `realtime-signals:opensky:oauth:` plus encodeURIComponent(tokenUrl|clientId).
func (o *openSkyService) getAccessToken(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime) (string, error) {
	clientID := jsTrim(runtime.Opensky.ClientID)
	clientSecret := jsTrim(runtime.Opensky.ClientSecret)
	if clientID == "" || clientSecret == "" {
		return "", &openSkyCredentialError{message: "OpenSky OAuth client credentials are not configured"}
	}
	tokenURL := openSkyTokenURL(runtime)
	cacheKey := openskyOAuthKeyFmt + encodeURIComponentJS(tokenURL+"|"+clientID)
	if cached, found, err := rediscache.GetJSON[openSkyTokenCache](ctx, o.store.redis, cacheKey); err == nil && found && cached.AccessToken != "" {
		return cached.AccessToken, nil
	}
	body := encodeFormPairs(
		[2]string{"grant_type", "client_credentials"},
		[2]string{"client_id", clientID},
		[2]string{"client_secret", clientSecret},
	)
	payload, err := o.http.fetchJSON(ctx, runtime, tokenURL, fetchOptions{
		Method:  "POST",
		RawBody: body,
		Headers: map[string]string{"content-type": "application/x-www-form-urlencoded"},
		ShouldRetry: func(err error) bool {
			switch classifyOpenskyKind(err, readHTTPStatus(err)) {
			case kindRateLimited, kindServer, kindTimeout, kindNetwork:
				return true
			default:
				return false
			}
		},
	})
	if err != nil {
		_ = o.recordOpenSkyError(ctx, err, o.clockMillis())
		return "", err
	}
	var response struct {
		AccessToken jsonRawMessage `json:"access_token"`
		ExpiresIn   jsonRawMessage `json:"expires_in"`
	}
	if err := decodeJSONPayload(payload, &response); err != nil {
		wrapped := &upstreamError{message: "OpenSky OAuth token response did not include access_token", code: codeFetchError, kind: kindAuth}
		_ = o.recordOpenSkyError(ctx, wrapped, o.clockMillis())
		return "", wrapped
	}
	accessToken := normalizeStringRaw(response.AccessToken)
	if accessToken == "" {
		wrapped := &upstreamError{message: "OpenSky OAuth token response did not include access_token", code: codeFetchError, kind: kindAuth}
		_ = o.recordOpenSkyError(ctx, wrapped, o.clockMillis())
		return "", wrapped
	}
	expiresInSec := 300
	if value, ok := toFiniteNumber(response.ExpiresIn); ok {
		expiresInSec = int(jsTrunc(value))
	}
	if expiresInSec < 60 {
		expiresInSec = 60
	}
	ttl := expiresInSec - 60
	if ttl < 30 {
		ttl = 30
	}
	if err := rediscache.SetJSON(ctx, o.store.redis, cacheKey, openSkyTokenCache{AccessToken: accessToken}, time.Duration(ttl)*time.Second); err != nil {
		return "", err
	}
	return accessToken, nil
}

// openSkyFetchOptions is one fetchOpenSkyStates request.
type openSkyFetchOptions struct {
	Scope         string
	BBox          [4]float64
	CacheKey      string
	CacheTTL      time.Duration
	ReserveBudget bool
	AccessToken   string
}

// fetchOpenSkyStates mirrors fetchOpenSkyStates: a single-flight cache.wrap with a
// 20 second lock, a 100ms retry and a 10 second wait budget.
func (o *openSkyService) fetchOpenSkyStates(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime, options openSkyFetchOptions) ([]OpenSkyStateVector, error) {
	credits := estimateOpenSkyCreditsForBBox(options.BBox)
	return rediscache.Wrap[[]OpenSkyStateVector](ctx, o.store.redis, options.CacheKey, options.CacheTTL,
		rediscache.WrapOptions{LockTTL: openskyLockTTL, RetryDelay: openskyLockRetryDelay, MaxWait: openskyLockWait},
		func(value []OpenSkyStateVector) bool { return true },
		func(ctx context.Context) ([]OpenSkyStateVector, error) {
			accessToken := options.AccessToken
			if accessToken == "" {
				token, err := o.getAccessToken(ctx, runtime)
				if err != nil {
					return nil, err
				}
				accessToken = token
			}
			endpoint := openSkyEndpoint(openSkyBaseURL(runtime), options.BBox)
			if options.ReserveBudget {
				allowed, _, _, err := o.reserveOpenSkyCredits(ctx, runtime, options.Scope, credits, 1, o.clockMillis())
				if err != nil {
					return nil, err
				}
				if !allowed {
					return nil, &budgetReserveError{message: "OpenSky daily credit budget does not have enough remaining credits for this viewport request."}
				}
			}
			payload, err := o.http.fetchJSON(ctx, runtime, endpoint, fetchOptions{
				Headers:    map[string]string{"Authorization": "Bearer " + accessToken},
				MaxRetries: intPointer(0),
			})
			if err != nil {
				_ = o.recordOpenSkyError(ctx, err, o.clockMillis())
				return nil, err
			}
			vectors, err := readOpenSkyStateVectors(payload)
			if err != nil {
				_ = o.recordOpenSkyError(ctx, err, o.clockMillis())
				return nil, err
			}
			return vectors, nil
		})
}

// fetchConservativeMilitaryStates mirrors
// fetchConservativeMilitaryOpenSkyStates. This is the B1 shared operation: the
// caller memoizes it for the whole round, so the region cache check, the credit
// reservation and the HTTP requests happen once instead of once per organization.
func (o *openSkyService) fetchConservativeMilitaryStates(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime, budget *budgetSummary) ([]OpenSkyStateVector, error) {
	regionKeys := make([]string, 0, len(openskyMilitaryRegions))
	for _, region := range openskyMilitaryRegions {
		regionKeys = append(regionKeys, openskyRegionKeyFmt+region.Key)
	}
	cachedRegions := make([][]OpenSkyStateVector, len(openskyMilitaryRegions))
	missing := make([]int, 0, len(openskyMilitaryRegions))
	for index, key := range regionKeys {
		vectors, found, err := rediscache.GetJSON[[]OpenSkyStateVector](ctx, o.store.redis, key)
		if err != nil {
			return nil, err
		}
		if found {
			cachedRegions[index] = vectors
			continue
		}
		missing = append(missing, index)
	}

	effectiveBudget := budget
	if effectiveBudget == nil {
		summary, err := o.getBudgetSummary(ctx, runtime, o.clockMillis())
		if err != nil {
			return nil, err
		}
		effectiveBudget = &summary
	}
	if effectiveBudget.MilitaryPaused && len(missing) > 0 {
		_ = o.recordOpenSkyBudgetEvent(ctx, "skippedMilitaryCount", o.clockMillis())
		return nil, &budgetExhaustedError{message: "OpenSky military polling is paused because the daily credit budget is exhausted."}
	}
	if len(missing) == 0 {
		flat := make([]OpenSkyStateVector, 0)
		for _, region := range cachedRegions {
			flat = append(flat, region...)
		}
		return dedupeOpenSkyStateVectors(filterConservativeMilitary(flat)), nil
	}

	accessToken, err := o.getAccessToken(ctx, runtime)
	if err != nil {
		return nil, err
	}
	missingCredits := 0
	for _, index := range missing {
		missingCredits += openskyMilitaryRegions[index].Credits
	}
	allowed, _, _, err := o.reserveOpenSkyCredits(ctx, runtime, "military", missingCredits, len(missing), o.clockMillis())
	if err != nil {
		return nil, err
	}
	if !allowed {
		_ = o.recordOpenSkyBudgetEvent(ctx, "skippedMilitaryCount", o.clockMillis())
		return nil, &budgetReserveError{message: "OpenSky military polling skipped because there are not enough remaining daily credits for the next region batch."}
	}

	regionStates := make([][]OpenSkyStateVector, len(openskyMilitaryRegions))
	for index, region := range openskyMilitaryRegions {
		if cachedRegions[index] != nil {
			regionStates[index] = cachedRegions[index]
			continue
		}
		states, err := o.fetchOpenSkyStates(ctx, runtime, openSkyFetchOptions{
			Scope:       "military",
			BBox:        region.BBox,
			CacheKey:    regionKeys[index],
			CacheTTL:    openskyRegionCacheTTL * time.Second,
			AccessToken: accessToken,
		})
		if err != nil {
			return nil, err
		}
		regionStates[index] = states
	}
	flat := make([]OpenSkyStateVector, 0)
	for _, region := range regionStates {
		flat = append(flat, region...)
	}
	return dedupeOpenSkyStateVectors(filterConservativeMilitary(flat)), nil
}

// filterConservativeMilitary mirrors isConservativeMilitaryState filtering.
func filterConservativeMilitary(states []OpenSkyStateVector) []OpenSkyStateVector {
	out := make([]OpenSkyStateVector, 0, len(states))
	for _, state := range states {
		if isConservativeMilitaryState(state) {
			out = append(out, state)
		}
	}
	return out
}

func isConservativeMilitaryState(state OpenSkyStateVector) bool {
	callsign := strings.ToUpper(jsTrim(state.Callsign))
	hasMilitaryCallsign := callsign != "" &&
		(militaryCallsignPatternA.MatchString(callsign) || militaryCallsignPatternB.MatchString(callsign))
	return hasMilitaryCallsign || strings.HasPrefix(state.ICAO24, "ae")
}

// dedupeOpenSkyStateVectors mirrors dedupeOpenskyStateVectors: the later contact
// wins, and an equal contact keeps the later entry (>=).
func dedupeOpenSkyStateVectors(states []OpenSkyStateVector) []OpenSkyStateVector {
	order := make([]string, 0, len(states))
	deduped := make(map[string]OpenSkyStateVector, len(states))
	for _, state := range states {
		current, exists := deduped[state.ICAO24]
		if !exists {
			order = append(order, state.ICAO24)
			deduped[state.ICAO24] = state
			continue
		}
		if state.LastContactMs >= current.LastContactMs {
			deduped[state.ICAO24] = state
		}
	}
	out := make([]OpenSkyStateVector, 0, len(order))
	for _, key := range order {
		out = append(out, deduped[key])
	}
	return out
}

// readOpenSkyStateVectors mirrors readOpenskyStateVectors.
func readOpenSkyStateVectors(payload jsonRawMessage) ([]OpenSkyStateVector, error) {
	var response struct {
		States jsonRawMessage `json:"states"`
	}
	if err := decodeJSONPayload(payload, &response); err != nil {
		return nil, &upstreamError{message: "invalid JSON response body", code: codeFetchError, kind: kindUnknown}
	}
	rawStates := readArray(response.States)
	vectors := make([]OpenSkyStateVector, 0, len(rawStates))
	for _, entry := range rawStates {
		vector, ok := parseOpenSkyStateVector(entry)
		if ok {
			vectors = append(vectors, vector)
		}
	}
	return vectors, nil
}

// parseOpenSkyStateVector mirrors parseOpenskyStateVector. Raw keeps the original
// entry array so buildAdsbLatestSnapshot can normalize it again, exactly like the
// NestJS helper.
func parseOpenSkyStateVector(entry jsonRawMessage) (OpenSkyStateVector, bool) {
	var fields []jsonRawMessage
	if err := decodeJSONPayload(entry, &fields); err != nil {
		return OpenSkyStateVector{}, false
	}
	icao24 := strings.ToLower(normalizeStringRaw(atIndex(fields, 0)))
	if icao24 == "" {
		return OpenSkyStateVector{}, false
	}
	lastContactSec := 0.0
	if value, ok := toFiniteNumber(atIndex(fields, 4)); ok {
		lastContactSec = value
	} else if value, ok := toFiniteNumber(atIndex(fields, 3)); ok {
		lastContactSec = value
	}
	lastContactMs := int64(math.Max(0, math.Trunc(lastContactSec*1000)))
	vector := OpenSkyStateVector{
		ICAO24:        icao24,
		LastContactMs: lastContactMs,
		Raw:           entry,
	}
	if value := normalizeStringRaw(atIndex(fields, 1)); value != "" {
		vector.Callsign = value
	}
	if value := normalizeStringRaw(atIndex(fields, 2)); value != "" {
		vector.CountryName = value
	}
	if lastContactMs > 0 {
		vector.LastContactAt = formatISO(lastContactMs)
	}
	if value, ok := toFiniteNumber(atIndex(fields, 5)); ok {
		vector.Longitude = &value
	}
	if value, ok := toFiniteNumber(atIndex(fields, 6)); ok {
		vector.Latitude = &value
	}
	if value, ok := toFiniteNumber(atIndex(fields, 10)); ok {
		vector.Heading = &value
	}
	altitudeMeters, hasAltitudeMeters := toFiniteNumber(atIndex(fields, 13))
	if !hasAltitudeMeters {
		altitudeMeters, hasAltitudeMeters = toFiniteNumber(atIndex(fields, 7))
	}
	if hasAltitudeMeters {
		rounded := jsRound(altitudeMeters * feetPerMeter)
		vector.AltitudeFt = &rounded
	}
	if velocity, ok := toFiniteNumber(atIndex(fields, 9)); ok {
		rounded := jsRound(velocity * knotsPerMeterPerSecond)
		vector.GroundSpeedKt = &rounded
	}
	return vector, true
}

func atIndex(values []jsonRawMessage, index int) jsonRawMessage {
	if index < 0 || index >= len(values) {
		return nil
	}
	return values[index]
}

// refreshGlobalAllFlightCapture mirrors refreshGlobalAllFlightCapture: one region
// per 15 minutes, persisted for every organization, with the cursor advanced only
// after a complete success.
func (o *openSkyService) refreshGlobalAllFlightCapture(ctx context.Context, orgIDs []string, runtime *dataruntimesettings.RealtimeCronRuntime) error {
	if len(orgIDs) == 0 || !runtime.Enabled || !runtime.Sources.Opensky.Enabled || !hasOpenSkyCredentials(runtime) {
		return nil
	}
	lastRunMs, err := o.readNumberCache(ctx, openskyAllCaptureLastRun)
	if err != nil {
		return err
	}
	nowMs := o.clockMillis()
	if lastRunMs != nil && nowMs-int64(*lastRunMs) < globalAllCaptureInterval*1000 {
		return nil
	}
	summary, err := o.getBudgetSummary(ctx, runtime, nowMs)
	if err != nil {
		return err
	}
	if summary.AllModeBlocked {
		return nil
	}
	cursor, err := o.readNumberCache(ctx, openskyAllCaptureCursor)
	if err != nil {
		return err
	}
	cursorValue := 0.0
	if cursor != nil {
		cursorValue = *cursor
	}
	index := int(math.Abs(cursorValue)) % len(openskyAllCaptureRegions)
	region := openskyAllCaptureRegions[index]

	states, err := o.fetchOpenSkyStates(ctx, runtime, openSkyFetchOptions{
		Scope:         "all",
		BBox:          region.BBox,
		CacheKey:      "realtime-signals:opensky:all-capture:" + region.Key,
		CacheTTL:      openskyRegionCacheTTL * time.Second,
		ReserveBudget: true,
	})
	if err != nil {
		var reserve *budgetReserveError
		var exhausted *budgetExhaustedError
		if errors.As(err, &reserve) || errors.As(err, &exhausted) {
			// A constrained budget is a normal skip, not a capture failure.
			return nil
		}
		return err
	}
	fetchedAtMs := o.clockMillis()
	endpoint := openSkyEndpoint(openSkyBaseURL(runtime), region.BBox)
	rawEntries := make([]jsonRawMessage, 0, len(states))
	for _, state := range states {
		rawEntries = append(rawEntries, state.Raw)
	}
	snapshot := buildAdsbLatestSnapshot(endpoint, rawEntries, len(states), fetchedAtMs,
		getAdsbStaleThresholdSeconds(globalAllCaptureInterval))
	for _, orgID := range orgIDs {
		if err := o.transport.persistAircraftTransportSnapshot(ctx, orgID, snapshot.Aircraft, snapshot.UpdatedAt, "all"); err != nil {
			return err
		}
	}
	if err := rediscache.SetJSON(ctx, o.store.redis, openskyAllCaptureLastRun, fetchedAtMs, openskyAllCaptureTTL*time.Second); err != nil {
		return err
	}
	return rediscache.SetJSON(ctx, o.store.redis, openskyAllCaptureCursor, cursorValue+1, openskyAllCaptureCursorTT*time.Second)
}

// readNumberCache mirrors `cache.get<number>(key) ?? null` with the typeof guard.
func (o *openSkyService) readNumberCache(ctx context.Context, key string) (*float64, error) {
	if o.store.redis == nil {
		return nil, rediscache.ErrNoClient
	}
	raw, err := o.store.redis.Get(ctx, key).Result()
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
	if err := decodeJSONPayload(jsonRawMessage(raw), &value); err != nil {
		return nil, nil
	}
	return &value, nil
}

// resolveOpenSkyCountryCode mirrors resolveOpenSkyCountryCode: text extraction,
// then name/code normalization, each converted to the alpha-2 code the map
// displays.
func resolveOpenSkyCountryCode(countryName string) string {
	if jsTrim(countryName) == "" {
		return ""
	}
	candidates := []string{
		geocoding.ExtractCountryCodeFromText(countryName),
		geocoding.NormalizeCountryCode(countryName),
		countryName,
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if alpha2 := geocoding.CountryAlpha2(candidate); alpha2 != "" {
			return alpha2
		}
	}
	return ""
}

// extractCountryCode mirrors extractCountryCode: the alpha-3 code from a direct
// match, or the first country mentioned in the text.
func extractCountryCode(value string) string {
	if value == "" {
		return ""
	}
	if normalized := geocoding.NormalizeCountryCode(value); normalized != "" {
		return normalized
	}
	return geocoding.ExtractCountryCodeFromText(value)
}

func intPointer(value int) *int { return &value }

package alertworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file ports AlertsNotificationThrottleService from
// apps/api/src/modules/alerts/alerts-notification-throttle.service.ts.
//
// The NestJS implementation reserves one schedule per independent Redis key
// (global, channel type, channel and minimum interval) with sequential EVAL
// calls and returns Math.max(now, ...schedules). Because the keys never
// interact, this port issues the same EVALSHA commands in a single pipeline and
// then takes the maximum of the successful results. The Lua script, KEYS/ARGV,
// interval and TTL arithmetic are unchanged, so the scheduled time is
// identical to the sequential implementation (the pipeline only removes the
// round-trip gaps between the reservations).
//
// The pace script delays the next slot instead of rejecting the send, which is
// why the caller adds the returned delay to its own `now`.

// paceLuaScript is PACE_LUA_SCRIPT copied verbatim, including the leading and
// trailing newline of the JavaScript template literal.
const paceLuaScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval_ms = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])

if interval_ms <= 0 then
  return 0
end

local next_time = redis.call('GET', key)
if next_time then
  next_time = tonumber(next_time)
else
  next_time = now
end

local scheduled = now
if next_time > scheduled then
  scheduled = next_time
end

local new_next = scheduled + interval_ms
redis.call('SET', key, tostring(new_next), 'PX', ttl_ms)

return scheduled - now
`

// throttleDefaultNamespace is the BULLMQ_NAMESPACE default used by NestJS.
const throttleDefaultNamespace = "modular"

// muteDateLayouts are the Date.parse fallbacks. RFC3339Nano is what the
// callers persist; the others are common human-readable forms. Date-time
// strings without an explicit zone are parsed as UTC, which keeps the worker
// deterministic (JS would use the process-local timezone for those).
var muteDateLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

// ThrottleConfig are the ALERT_NOTIFY_* values plus the BullMQ namespace.
type ThrottleConfig struct {
	// GlobalPerSecond is ALERT_NOTIFY_GLOBAL_PER_SECOND.
	GlobalPerSecond float64
	// EmailPerSecond is ALERT_NOTIFY_EMAIL_PER_SECOND.
	EmailPerSecond float64
	// WebhookPerSecond is ALERT_NOTIFY_WEBHOOK_PER_SECOND.
	WebhookPerSecond float64
	// PerChannelPerSecond is ALERT_NOTIFY_PER_CHANNEL_PER_SECOND.
	PerChannelPerSecond float64
	// LimiterTTLMs is ALERT_NOTIFY_LIMITER_TTL_MS.
	LimiterTTLMs int64
	// Namespace is BULLMQ_NAMESPACE; empty falls back to "modular".
	Namespace string
}

// Throttle is the Redis pace limiter.
type Throttle struct {
	client *redis.Client
	cfg    ThrottleConfig
	script *redis.Script
	// scriptLoaded records whether SCRIPT LOAD succeeded, so the hot path can
	// use EVALSHA. Failures fall back to EVAL with the full source.
	scriptLoaded atomic.Bool
}

// NewThrottle builds the pace limiter over an existing Redis client.
func NewThrottle(client *redis.Client, cfg ThrottleConfig) *Throttle {
	return &Throttle{
		client: client,
		cfg:    cfg,
		script: redis.NewScript(paceLuaScript),
	}
}

// ReserveNotificationScheduleMs mirrors reserveNotificationScheduleMs: it
// reserves one slot per configured key and returns the latest scheduled
// millisecond timestamp (at least now). The four EVALSHA calls are pipelined.
func (t *Throttle) ReserveNotificationScheduleMs(ctx context.Context, input ReserveInput) (int64, error) {
	if t == nil {
		return 0, errors.New("alerts notification throttle: nil receiver")
	}
	nowMs := time.Now().UnixMilli()
	targets := paceTargets(t.cfg, input)
	if len(targets) == 0 {
		return nowMs, nil
	}
	if t.client == nil {
		return 0, errors.New("alerts notification throttle: nil redis client")
	}
	pipeline := t.client.Pipeline()
	commands := make([]*redis.Cmd, 0, len(targets))
	for _, target := range targets {
		commands = append(commands, t.queuePaceEvaluation(ctx, pipeline, target, nowMs))
	}
	// Exec returns the first command error (usually a connection failure) even
	// when other commands still have usable replies. The schedule therefore
	// uses every successful reply and only fails when none succeeded.
	_, execErr := pipeline.Exec(ctx)
	if execErr != nil {
		// A flushed script cache (Redis restart) leaves the local loaded flag
		// stale; the next reservation reloads the script.
		t.scriptLoaded.Store(false)
	}
	delays := make([]int64, 0, len(commands))
	var firstCommandErr error
	for _, command := range commands {
		delay, err := command.Int64()
		if err != nil {
			if firstCommandErr == nil {
				firstCommandErr = err
			}
			continue
		}
		delays = append(delays, delay)
	}
	if len(delays) == 0 {
		if execErr != nil {
			return 0, fmt.Errorf("alerts notification throttle: %w", execErr)
		}
		if firstCommandErr != nil {
			return 0, fmt.Errorf("alerts notification throttle: %w", firstCommandErr)
		}
		return nowMs, nil
	}
	return maxScheduledMs(nowMs, delays), nil
}

// queuePaceEvaluation queues one EVALSHA (preferred) or EVAL fallback on the
// pipeline. Script.Run cannot be used here because it calls EvalSha on the
// client and inspects the result immediately; EvalSha queues the same command
// and defers the reply to pipeline.Exec.
func (t *Throttle) queuePaceEvaluation(ctx context.Context, pipeline redis.Pipeliner, target paceTarget, nowMs int64) *redis.Cmd {
	keys := []string{target.Key}
	args := []any{nowMs, target.IntervalMs, target.TTLMs}
	if t.ensurePaceScriptLoaded(ctx) {
		return t.script.EvalSha(ctx, pipeline, keys, args...)
	}
	return pipeline.Eval(ctx, paceLuaScript, keys, args...)
}

// ensurePaceScriptLoaded performs a one-time SCRIPT LOAD. When SCRIPT is
// unavailable (ACL restrictions, older proxy) it reports false and the caller
// sends the full script with EVAL instead; both paths keep the exact same Lua
// source, keys, arguments and TTLs.
func (t *Throttle) ensurePaceScriptLoaded(ctx context.Context) bool {
	if t.scriptLoaded.Load() {
		return true
	}
	if err := t.script.Load(ctx, t.client).Err(); err != nil {
		return false
	}
	t.scriptLoaded.Store(true)
	return true
}

// ReserveInput is the channel-specific part of a reservation.
type ReserveInput struct {
	// ChannelType is "email" or "webhook"; empty behaves like "webhook",
	// mirroring the NestJS ternary's else branch.
	ChannelType string
	// ChannelID enables the per-channel and minimum-interval keys when set.
	ChannelID string
	// MinIntervalSeconds enables the minimum-interval key when > 0.
	MinIntervalSeconds *int64
}

// paceTarget is one Redis key plus its pace interval and key TTL.
type paceTarget struct {
	Key        string
	IntervalMs int64
	TTLMs      int64
}

// paceTargets derives the keys, intervals and TTLs of one reservation. It is
// pure so the arithmetic can be tested without Redis.
func paceTargets(cfg ThrottleConfig, input ReserveInput) []paceTarget {
	prefix := throttleNamespace(cfg.Namespace) + ":alerts:notify"
	targets := make([]paceTarget, 0, 4)
	if cfg.GlobalPerSecond > 0 {
		targets = append(targets, newPaceTarget(prefix+":global", cfg.GlobalPerSecond, cfg.LimiterTTLMs))
	}
	channelType := input.ChannelType
	if channelType != "email" {
		// The NestJS type only allows email|webhook; the ternary treats every
		// other value (including empty) as webhook.
		channelType = "webhook"
	}
	perType := cfg.WebhookPerSecond
	if channelType == "email" {
		perType = cfg.EmailPerSecond
	}
	if perType > 0 {
		targets = append(targets, newPaceTarget(prefix+":type:"+channelType, perType, cfg.LimiterTTLMs))
	}
	if input.ChannelID != "" {
		if cfg.PerChannelPerSecond > 0 {
			targets = append(targets, newPaceTarget(prefix+":channel:"+input.ChannelID, cfg.PerChannelPerSecond, cfg.LimiterTTLMs))
		}
		if input.MinIntervalSeconds != nil && *input.MinIntervalSeconds > 0 {
			// The NestJS service passes 1/minIntervalSeconds as maxPerSecond,
			// so the resulting interval is ceil(1000 * minIntervalSeconds).
			maxPerSecond := 1 / float64(*input.MinIntervalSeconds)
			targets = append(targets, newPaceTarget(prefix+":interval:"+input.ChannelID, maxPerSecond, cfg.LimiterTTLMs))
		}
	}
	return targets
}

// newPaceTarget applies intervalMs = max(1, ceil(1000/maxPerSecond)) and
// ttlMs = max(limiterTTLMs, intervalMs*10), matching reserveScheduledAtMs.
func newPaceTarget(key string, maxPerSecond float64, limiterTTLMs int64) paceTarget {
	intervalMs := int64(1)
	if maxPerSecond > 0 {
		raw := math.Ceil(1000 / maxPerSecond)
		switch {
		case math.IsNaN(raw) || raw < 1:
			intervalMs = 1
		case raw >= float64(math.MaxInt64):
			intervalMs = math.MaxInt64
		default:
			intervalMs = int64(raw)
		}
	}
	ttlMs := limiterTTLMs
	if intervalMs > math.MaxInt64/10 {
		ttlMs = math.MaxInt64
	} else if intervalMs*10 > ttlMs {
		ttlMs = intervalMs * 10
	}
	return paceTarget{Key: key, IntervalMs: intervalMs, TTLMs: ttlMs}
}

// throttleNamespace resolves BULLMQ_NAMESPACE with its "modular" default.
func throttleNamespace(namespace string) string {
	trimmed := strings.TrimSpace(namespace)
	if trimmed == "" {
		return throttleDefaultNamespace
	}
	return trimmed
}

// maxScheduledMs mirrors `Math.max(now, ...schedules)`, where each schedule is
// now + max(0, delay). A negative delay (the Lua script never returns one) is
// clamped to zero.
func maxScheduledMs(nowMs int64, delays []int64) int64 {
	scheduled := nowMs
	for _, delay := range delays {
		if delay < 0 {
			delay = 0
		}
		candidate := nowMs + delay
		if candidate > scheduled {
			scheduled = candidate
		}
	}
	return scheduled
}

// ParseMuteUntilMs mirrors parseMuteUntilMs for a string input: trimmed empty
// input is nil; a finite Number() is interpreted as seconds or milliseconds by
// the 10^10 threshold; anything else falls back to Date.parse. Unparsable
// values are nil.
func ParseMuteUntilMs(value *string) *int64 {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if number, ok := parseJSFiniteNumber(trimmed); ok {
		return ParseMuteUntilMsNumber(&number)
	}
	return parseJSMuteDateMs(trimmed)
}

// ParseMuteUntilMsNumber mirrors parseMuteUntilMs for a numeric input. A
// non-finite value is nil (the TS code falls through to the "not a string"
// branch); values at or below 10_000_000_000 are seconds and larger values are
// already milliseconds. Fractional milliseconds are truncated toward zero when
// converted to the worker's int64 representation.
func ParseMuteUntilMsNumber(value *float64) *int64 {
	if value == nil {
		return nil
	}
	number := *value
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	milliseconds := number
	if number <= 10_000_000_000 {
		milliseconds = number * 1000
	}
	return millisecondsToInt64(milliseconds)
}

// ParseMuteUntil mirrors the service's MuteUntilInput switch for a raw JSON
// value: null is nil, a JSON number follows parseMuteUntilMs's numeric branch
// and a JSON string follows its string branch. Booleans, objects and arrays are
// nil because the TS union cannot produce them. Parsing uses
// json.Decoder.UseNumber so large timestamps do not lose precision before the
// 10^10 threshold check.
func ParseMuteUntil(jsValue json.RawMessage) *int64 {
	trimmed := bytes.TrimSpace(jsValue)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil
	}
	switch value := decoded.(type) {
	case nil:
		return nil
	case json.Number:
		number, err := value.Float64()
		if err != nil {
			return nil
		}
		return ParseMuteUntilMsNumber(&number)
	case string:
		return ParseMuteUntilMs(&value)
	default:
		return nil
	}
}

// IsMutedNow reports muteUntilMs != nil && nowMs < *muteUntilMs.
func IsMutedNow(muteUntilMs *int64, nowMs int64) bool {
	return muteUntilMs != nil && nowMs < *muteUntilMs
}

// parseJSFiniteNumber approximates Number(text) and reports whether the result
// is finite. It understands the 0x/0o/0b integer prefixes and rejects Go-only
// underscore literals, so "1_000" stays unparsable like JS.
func parseJSFiniteNumber(text string) (float64, bool) {
	if strings.Contains(text, "_") {
		return 0, false
	}
	lower := strings.ToLower(text)
	switch {
	case strings.HasPrefix(lower, "0x"):
		parsed, err := strconv.ParseUint(text[2:], 16, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	case strings.HasPrefix(lower, "0o"):
		parsed, err := strconv.ParseUint(text[2:], 8, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	case strings.HasPrefix(lower, "0b"):
		parsed, err := strconv.ParseUint(text[2:], 2, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// parseJSMuteDateMs is the Date.parse fallback subset: the layouts above, in
// UTC. Unparsable input returns nil, like Date.parse returning NaN.
func parseJSMuteDateMs(text string) *int64 {
	for _, layout := range muteDateLayouts {
		parsed, err := time.Parse(layout, text)
		if err != nil {
			continue
		}
		milliseconds := parsed.UTC().UnixMilli()
		return &milliseconds
	}
	return nil
}

// millisecondsToInt64 converts a finite millisecond value, returning nil when
// it cannot be represented by int64 (the TS code would keep a larger number,
// which no persisted mute timestamp can use here).
func millisecondsToInt64(value float64) *int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value >= float64(math.MaxInt64) || value < float64(math.MinInt64) {
		return nil
	}
	converted := int64(value)
	return &converted
}

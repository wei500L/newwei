package alertworker

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"testing"
)

// nestJSPaceLuaScript is PACE_LUA_SCRIPT copied from
// apps/api/src/modules/alerts/alerts-notification-throttle.service.ts. It must
// stay byte-for-byte identical to paceLuaScript so the EVALSHA cache key and
// the Redis-side behaviour never drift.
const nestJSPaceLuaScript = `
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

// TestPaceLuaScriptMatchesNestJS pins the verbatim Lua source.
func TestPaceLuaScriptMatchesNestJS(t *testing.T) {
	if paceLuaScript != nestJSPaceLuaScript {
		t.Fatalf("paceLuaScript differs from the NestJS literal:\n--- go ---\n%s\n--- ts ---\n%s", paceLuaScript, nestJSPaceLuaScript)
	}
}

// TestPaceTargets pins the key names and the interval/TTL arithmetic of the
// pure target derivation.
func TestPaceTargets(t *testing.T) {
	cases := []struct {
		name  string
		cfg   ThrottleConfig
		input ReserveInput
		want  []paceTarget
	}{
		{
			name: "all four keys",
			cfg: ThrottleConfig{
				GlobalPerSecond:     10,
				EmailPerSecond:      2,
				WebhookPerSecond:    3,
				PerChannelPerSecond: 1,
				LimiterTTLMs:        1000,
				Namespace:           "modular",
			},
			input: ReserveInput{
				ChannelType:        "email",
				ChannelID:          "chan-1",
				MinIntervalSeconds: throttleInt64Pointer(60),
			},
			want: []paceTarget{
				{Key: "modular:alerts:notify:global", IntervalMs: 100, TTLMs: 1000},
				{Key: "modular:alerts:notify:type:email", IntervalMs: 500, TTLMs: 5000},
				{Key: "modular:alerts:notify:channel:chan-1", IntervalMs: 1000, TTLMs: 10000},
				{Key: "modular:alerts:notify:interval:chan-1", IntervalMs: 60000, TTLMs: 600000},
			},
		},
		{
			name:  "global only with TTL floor",
			cfg:   ThrottleConfig{GlobalPerSecond: 4, LimiterTTLMs: 250},
			input: ReserveInput{ChannelType: "webhook"},
			want: []paceTarget{
				{Key: "modular:alerts:notify:global", IntervalMs: 250, TTLMs: 2500},
			},
		},
		{
			name:  "email type key",
			cfg:   ThrottleConfig{EmailPerSecond: 4, WebhookPerSecond: 5, LimiterTTLMs: 1000},
			input: ReserveInput{ChannelType: "email"},
			want: []paceTarget{
				{Key: "modular:alerts:notify:type:email", IntervalMs: 250, TTLMs: 2500},
			},
		},
		{
			name:  "empty channel type behaves like webhook",
			cfg:   ThrottleConfig{WebhookPerSecond: 5, LimiterTTLMs: 1000},
			input: ReserveInput{ChannelType: ""},
			want: []paceTarget{
				{Key: "modular:alerts:notify:type:webhook", IntervalMs: 200, TTLMs: 2000},
			},
		},
		{
			name:  "channel and minimum interval keys",
			cfg:   ThrottleConfig{PerChannelPerSecond: 2, LimiterTTLMs: 500},
			input: ReserveInput{ChannelType: "webhook", ChannelID: "c1", MinIntervalSeconds: throttleInt64Pointer(60)},
			want: []paceTarget{
				{Key: "modular:alerts:notify:channel:c1", IntervalMs: 500, TTLMs: 5000},
				{Key: "modular:alerts:notify:interval:c1", IntervalMs: 60000, TTLMs: 600000},
			},
		},
		{
			name:  "minimum interval rate alone",
			cfg:   ThrottleConfig{},
			input: ReserveInput{ChannelType: "webhook", ChannelID: "c2", MinIntervalSeconds: throttleInt64Pointer(3)},
			want: []paceTarget{
				{Key: "modular:alerts:notify:interval:c2", IntervalMs: 3000, TTLMs: 30000},
			},
		},
		{
			name:  "custom namespace",
			cfg:   ThrottleConfig{GlobalPerSecond: 2, Namespace: "bull"},
			input: ReserveInput{ChannelType: "webhook"},
			want: []paceTarget{
				{Key: "bull:alerts:notify:global", IntervalMs: 500, TTLMs: 5000},
			},
		},
		{
			name:  "zero minimum interval is ignored",
			cfg:   ThrottleConfig{},
			input: ReserveInput{ChannelType: "webhook", ChannelID: "c3", MinIntervalSeconds: throttleInt64Pointer(0)},
			want:  nil,
		},
		{
			name:  "negative minimum interval is ignored",
			cfg:   ThrottleConfig{},
			input: ReserveInput{ChannelType: "webhook", ChannelID: "c4", MinIntervalSeconds: throttleInt64Pointer(-5)},
			want:  nil,
		},
		{
			name:  "nil minimum interval is ignored",
			cfg:   ThrottleConfig{},
			input: ReserveInput{ChannelType: "webhook", ChannelID: "c5"},
			want:  nil,
		},
		{
			name:  "slow rate saturates the interval",
			cfg:   ThrottleConfig{GlobalPerSecond: 0.1, LimiterTTLMs: 50},
			input: ReserveInput{ChannelType: "webhook"},
			want: []paceTarget{
				{Key: "modular:alerts:notify:global", IntervalMs: 10000, TTLMs: 100000},
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := paceTargets(testCase.cfg, testCase.input)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("paceTargets() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

// TestThrottleNamespace covers the BULLMQ_NAMESPACE default.
func TestThrottleNamespace(t *testing.T) {
	if got := throttleNamespace(""); got != "modular" {
		t.Fatalf("throttleNamespace(\"\") = %q", got)
	}
	if got := throttleNamespace("  "); got != "modular" {
		t.Fatalf("throttleNamespace(blank) = %q", got)
	}
	if got := throttleNamespace(" custom "); got != "custom" {
		t.Fatalf("throttleNamespace(custom) = %q", got)
	}
}

// TestMaxScheduledMs mirrors Math.max(now, ...schedules) with the delay clamp.
func TestMaxScheduledMs(t *testing.T) {
	now := int64(1_000)
	cases := []struct {
		name   string
		delays []int64
		want   int64
	}{
		{name: "no schedules", delays: nil, want: 1000},
		{name: "all zero", delays: []int64{0, 0}, want: 1000},
		{name: "maximum wins", delays: []int64{0, 25, 10}, want: 1025},
		{name: "negative is clamped", delays: []int64{-5, -1}, want: 1000},
		{name: "negative alongside positive", delays: []int64{-5, 7}, want: 1007},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := maxScheduledMs(now, testCase.delays); got != testCase.want {
				t.Fatalf("maxScheduledMs(%d, %v) = %d, want %d", now, testCase.delays, got, testCase.want)
			}
		})
	}
}

// TestParseMuteUntilMs pins the string branch of parseMuteUntilMs.
func TestParseMuteUntilMs(t *testing.T) {
	cases := []struct {
		name  string
		value *string
		want  *int64
	}{
		{name: "nil", value: nil, want: nil},
		{name: "empty", value: throttleStringPointer(""), want: nil},
		{name: "blank", value: throttleStringPointer("   "), want: nil},
		{name: "seconds", value: throttleStringPointer("1700000000"), want: throttleInt64Pointer(1700000000000)},
		{name: "milliseconds", value: throttleStringPointer("1700000000000"), want: throttleInt64Pointer(1700000000000)},
		{name: "exactly the threshold is seconds", value: throttleStringPointer("10000000000"), want: throttleInt64Pointer(10000000000000)},
		{name: "just above the threshold is milliseconds", value: throttleStringPointer("10000000001"), want: throttleInt64Pointer(10000000001)},
		{name: "trimmed seconds", value: throttleStringPointer(" 42 "), want: throttleInt64Pointer(42000)},
		{name: "negative seconds", value: throttleStringPointer("-5"), want: throttleInt64Pointer(-5000)},
		{name: "fractional seconds", value: throttleStringPointer("1700000000.5"), want: throttleInt64Pointer(1700000000500)},
		{name: "hex number", value: throttleStringPointer("0x10"), want: throttleInt64Pointer(16000)},
		{name: "underscored number is not a JS number", value: throttleStringPointer("1_000"), want: nil},
		{name: "infinity is not finite", value: throttleStringPointer("Infinity"), want: nil},
		{name: "iso timestamp", value: throttleStringPointer("2026-10-20T00:00:00.000Z"), want: throttleInt64Pointer(1792454400000)},
		{name: "iso timestamp with offset", value: throttleStringPointer("2026-10-20T03:04:05+03:00"), want: throttleInt64Pointer(1792454645000)},
		{name: "space separated timestamp", value: throttleStringPointer("2026-10-20 15:04:05"), want: throttleInt64Pointer(1792508645000)},
		{name: "date only", value: throttleStringPointer("2026-10-20"), want: throttleInt64Pointer(1792454400000)},
		{name: "invalid timestamp", value: throttleStringPointer("not-a-date"), want: nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := ParseMuteUntilMs(testCase.value)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("ParseMuteUntilMs(%v) = %v, want %v", throttlePrintableString(testCase.value), throttlePrintableInt64(got), throttlePrintableInt64(testCase.want))
			}
		})
	}
}

// TestParseMuteUntilMsNumber pins the numeric branch, including the finite
// guard and the int64 representability floor.
func TestParseMuteUntilMsNumber(t *testing.T) {
	cases := []struct {
		name  string
		value *float64
		want  *int64
	}{
		{name: "nil", value: nil, want: nil},
		{name: "zero", value: throttleFloat64Pointer(0), want: throttleInt64Pointer(0)},
		{name: "seconds", value: throttleFloat64Pointer(1.7e9), want: throttleInt64Pointer(1700000000000)},
		{name: "milliseconds", value: throttleFloat64Pointer(1.7e12), want: throttleInt64Pointer(1700000000000)},
		{name: "exactly the threshold is seconds", value: throttleFloat64Pointer(1e10), want: throttleInt64Pointer(10000000000000)},
		{name: "just above the threshold is milliseconds", value: throttleFloat64Pointer(1e10 + 1), want: throttleInt64Pointer(10000000001)},
		{name: "negative seconds", value: throttleFloat64Pointer(-5), want: throttleInt64Pointer(-5000)},
		{name: "fractional seconds", value: throttleFloat64Pointer(1.5), want: throttleInt64Pointer(1500)},
		{name: "not a number", value: throttleFloat64Pointer(math.NaN()), want: nil},
		{name: "positive infinity", value: throttleFloat64Pointer(math.Inf(1)), want: nil},
		{name: "negative infinity", value: throttleFloat64Pointer(math.Inf(-1)), want: nil},
		{name: "above int64 range", value: throttleFloat64Pointer(1e19), want: nil},
		{name: "below int64 range", value: throttleFloat64Pointer(-1e19), want: nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := ParseMuteUntilMsNumber(testCase.value)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("ParseMuteUntilMsNumber(%v) = %v, want %v", throttlePrintableFloat64(testCase.value), throttlePrintableInt64(got), throttlePrintableInt64(testCase.want))
			}
		})
	}
}

// TestParseMuteUntil covers the JSON-facing switch the service uses.
func TestParseMuteUntil(t *testing.T) {
	cases := []struct {
		name    string
		jsValue json.RawMessage
		want    *int64
	}{
		{name: "empty", jsValue: nil, want: nil},
		{name: "null", jsValue: json.RawMessage("null"), want: nil},
		{name: "number seconds", jsValue: json.RawMessage("1700000000"), want: throttleInt64Pointer(1700000000000)},
		{name: "number milliseconds", jsValue: json.RawMessage("1700000000000"), want: throttleInt64Pointer(1700000000000)},
		{name: "number at threshold", jsValue: json.RawMessage("10000000000"), want: throttleInt64Pointer(10000000000000)},
		{name: "string seconds", jsValue: json.RawMessage(`"1700000000"`), want: throttleInt64Pointer(1700000000000)},
		{name: "string iso timestamp", jsValue: json.RawMessage(`"2026-10-20T00:00:00.000Z"`), want: throttleInt64Pointer(1792454400000)},
		{name: "blank string", jsValue: json.RawMessage(`"   "`), want: nil},
		{name: "invalid string", jsValue: json.RawMessage(`"not-a-date"`), want: nil},
		{name: "boolean", jsValue: json.RawMessage("true"), want: nil},
		{name: "object", jsValue: json.RawMessage(`{"value":1}`), want: nil},
		{name: "array", jsValue: json.RawMessage(`[1]`), want: nil},
		{name: "invalid json", jsValue: json.RawMessage("not json"), want: nil},
		{name: "number above int64 range", jsValue: json.RawMessage("1e19"), want: nil},
		{name: "number overflow", jsValue: json.RawMessage("1e400"), want: nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := ParseMuteUntil(testCase.jsValue)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("ParseMuteUntil(%s) = %v, want %v", string(testCase.jsValue), throttlePrintableInt64(got), throttlePrintableInt64(testCase.want))
			}
		})
	}
}

// TestIsMutedNow pins the strict now < muteUntil comparison.
func TestIsMutedNow(t *testing.T) {
	now := int64(1_000)
	cases := []struct {
		name  string
		mute  *int64
		nowMs int64
		muted bool
	}{
		{name: "nil is never muted", mute: nil, nowMs: now, muted: false},
		{name: "boundary is not muted", mute: throttleInt64Pointer(now), nowMs: now, muted: false},
		{name: "future is muted", mute: throttleInt64Pointer(now + 1), nowMs: now, muted: true},
		{name: "past is not muted", mute: throttleInt64Pointer(now - 1), nowMs: now, muted: false},
		{name: "zero mute with negative now", mute: throttleInt64Pointer(0), nowMs: -1, muted: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsMutedNow(testCase.mute, testCase.nowMs); got != testCase.muted {
				t.Fatalf("IsMutedNow(%v, %d) = %v, want %v", throttlePrintableInt64(testCase.mute), testCase.nowMs, got, testCase.muted)
			}
		})
	}
}

// TestNewThrottle wires the script without touching Redis.
func TestNewThrottle(t *testing.T) {
	throttle := NewThrottle(nil, ThrottleConfig{Namespace: "modular"})
	if throttle == nil || throttle.script == nil {
		t.Fatal("NewThrottle() did not build the script")
	}
	if throttle.scriptLoaded.Load() {
		t.Fatal("NewThrottle() marked the script as loaded without a SCRIPT LOAD")
	}
}

// throttleInt64Pointer builds a nullable millisecond input.
func throttleInt64Pointer(value int64) *int64 {
	return &value
}

// throttlePrintableString renders a nullable string in test failure messages.
func throttlePrintableString(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

// throttlePrintableInt64 renders a nullable int64 in test failure messages.
func throttlePrintableInt64(value *int64) string {
	if value == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%d", *value)
}

// throttlePrintableFloat64 renders a nullable float64 in test failure messages.
func throttlePrintableFloat64(value *float64) string {
	if value == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%v", *value)
}

// throttleStringPointer builds a nullable string input.
func throttleStringPointer(value string) *string {
	return &value
}

// throttleFloat64Pointer builds a nullable numeric input.
func throttleFloat64Pointer(value float64) *float64 {
	return &value
}

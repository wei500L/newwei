package crawlworker

// JavaScript number semantics shared by the crawl worker. NestJS normalizes
// every numeric knob in crawl.processor.ts with Math.round / Math.floor /
// Number.isFinite, so the Go port must not use Go's rounding: Go's
// math.Round rounds halves away from zero, while Math.round rounds halves
// toward +Infinity ((-0.5).round() is -0, (0.5).round() is 1).

import (
	"encoding/json"
	"math"
	"strings"
)

const (
	// maxCrawlConcurrency is MAX_CRAWL_CONCURRENCY: the C2 broadcast and the
	// settings clamp both cap the crawl worker concurrency at 20.
	maxCrawlConcurrency = 20
	// defaultRequestTimeoutMs is the last-resort crawl4ai request timeout
	// (120000 in resolveQueueTimeoutMs).
	defaultRequestTimeoutMs = 120_000
	// minRequestTimeoutMs is the lower clamp resolveQueueTimeoutMs applies to
	// a configured timeout.
	minRequestTimeoutMs = 1_000
)

// jsRound is Math.round: round half up (toward +Infinity), and keep the sign of
// -0 as 0. Values beyond 2^52 are already integers for both runtimes.
//
// A JavaScript number can exceed the Go int range (JSON.parse has no limit on an
// integer literal), so out-of-range magnitudes saturate instead of relying on
// Go's implementation-defined float-to-int conversion.
func jsRound(value float64) int {
	if math.IsNaN(value) {
		return 0
	}
	rounded := math.Floor(value + 0.5)
	if rounded >= float64(math.MaxInt64) {
		return math.MaxInt
	}
	if rounded <= float64(math.MinInt64) {
		return math.MinInt
	}
	return int(rounded)
}

// finiteNumber is Number.isFinite.
func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// positiveInteger is normalizePositiveInteger: a finite number rounds to at
// least one; any other value reports false (the NestJS helper returns null,
// which callers translate into a default).
func positiveInteger(value float64) (int, bool) {
	if !finiteNumber(value) {
		return 0, false
	}
	rounded := jsRound(value)
	if rounded < 1 {
		rounded = 1
	}
	return rounded, true
}

// nonNegativeInteger is normalizeNonNegativeInteger: floor a finite number at
// zero, and read anything else as zero (resolveMemoryPressureRequeues does the
// same with its `?? 0`).
func nonNegativeInteger(value float64) int {
	if !finiteNumber(value) {
		return 0
	}
	// Clamp instead of falling back to zero: the callers treat the value as a
	// budget, and a huge counter must stay "spent" rather than restart at zero.
	if value >= float64(math.MaxInt32) {
		return math.MaxInt32
	}
	floored := int(math.Floor(value))
	if floored < 0 {
		return 0
	}
	return floored
}

// jsonNumber decodes a JSON number. The NestJS classifier reads job data and
// broadcast payloads through typeof/Number.isInteger guards, so a JSON string,
// boolean, null, array or object all report false instead of a zero value.
func jsonNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	switch trimmed[0] {
	case '"', '{', '[', 't', 'f', 'n':
		return 0, false
	}
	var value float64
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return 0, false
	}
	if !finiteNumber(value) {
		return 0, false
	}
	return value, true
}

// jsonInteger decodes a JSON number that is also an integer value. JSON.parse
// turns 5.0 and 5e0 into the integer 5, and Number.isInteger accepts both, so
// the integrality test runs on the decoded value rather than on the text.
func jsonInteger(raw json.RawMessage) (int, bool) {
	value, ok := jsonNumber(raw)
	if !ok || math.Trunc(value) != value {
		return 0, false
	}
	// The callers read small counters (versions, concurrency, keep counts); a
	// magnitude outside the int32 range is not a value they can act on and would
	// make the float-to-int conversion implementation-defined.
	if value < math.MinInt32 || value > math.MaxInt32 {
		return 0, false
	}
	return int(value), true
}

// jsonString decodes a JSON string. It mirrors the `typeof value === "string"`
// guards CrawlJobData reads, so numbers and nulls read as missing.
func jsonString(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return ""
	}
	var value string
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return ""
	}
	return value
}

// optionalJSONString is jsonString with an undefined/empty result as nil, the
// shape CrawlJobData uses for sourceId and triggeredById.
func optionalJSONString(raw json.RawMessage) *string {
	value := jsonString(raw)
	if value == "" {
		return nil
	}
	return &value
}

// optionalJSONInt is the number twin of optionalJSONString.
func optionalJSONInt(raw json.RawMessage) *int {
	value, ok := jsonNumber(raw)
	if !ok {
		return nil
	}
	rounded := jsRound(value)
	return &rounded
}

func maxInt(first, second int) int {
	if first > second {
		return first
	}
	return second
}

func minInt(first, second int) int {
	if first < second {
		return first
	}
	return second
}

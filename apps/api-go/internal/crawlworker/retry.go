package crawlworker

// Pure resolution helpers of crawl.processor.ts: worker concurrency, the
// BullMQ limiter bound, attempt numbers, backoff delay, the memory pressure
// cooldown and the per-class request timeout. Every function reproduces the
// JavaScript numeric semantics (Math.round half-up, clamp order, `??` only for
// absent values) so the Go worker takes the same decisions as the NestJS one.

import (
	"encoding/json"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// resolveInitialWorkerConcurrency is resolveInitialWorkerConcurrency. Go has no
// `undefined`, so a zero value means "not configured": the settings value wins,
// then the environment fallback, then one.
func resolveInitialWorkerConcurrency(configured, fallback int) int {
	if configured > 0 {
		return maxInt(1, jsRound(float64(configured)))
	}
	if fallback > 0 {
		return maxInt(1, jsRound(float64(fallback)))
	}
	return 1
}

// resolveManualLimiterMax is resolveManualLimiterMax: the BullMQ moveToActive
// limiter is 100 slots per concurrency unit per second, clamped to
// [1,10000], so the rate limiter never throttles below the configured pull
// concurrency.
func resolveManualLimiterMax(concurrency int) int64 {
	max := int64(jsRound(float64(concurrency)) * 100)
	if max < 1 {
		return 1
	}
	if max > 10_000 {
		return 10_000
	}
	return max
}

// resolveMaxAttempts is resolveMaxAttempts: a positive integer, default one.
func resolveMaxAttempts(value int) int {
	if value < 1 {
		return 1
	}
	return maxInt(1, jsRound(float64(value)))
}

// resolveAttemptsStarted is resolveAttemptsStarted. BullMQ increments the job
// hash field `ats` on every moveToActive and `atm` only when an attempt
// finishes, so a rate-limited (memory pressure) requeue raises the started
// counter without consuming a retry.
func resolveAttemptsStarted(attemptsStarted, attemptsMade int) int {
	if attemptsStarted > 0 {
		return maxInt(1, jsRound(float64(attemptsStarted)))
	}
	return maxInt(1, int(math.Floor(float64(attemptsMade)))+1)
}

// resolveAttempt is Math.min(maxAttempts, attemptsStarted): the attempt number
// the execution retry context receives.
func resolveAttempt(maxAttempts, attemptsStarted int) int {
	return minInt(maxAttempts, attemptsStarted)
}

// resolveBackoffDelayMs is resolveBackoffDelayMs: nil when the job has no
// backoff, a fixed delay for a numeric backoff (BullMQ normalizes a number to
// {type:"fixed"}), the exponential delay for {type:"exponential"} and the plain
// delay for any other object. The delay is floored at zero and rounded with
// Math.round.
func resolveBackoffDelayMs(raw json.RawMessage, attempt int) *int {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if delay, ok := jsonNumber(raw); ok {
		value := maxInt(0, jsRound(delay))
		return &value
	}
	if trimmed[0] != '{' {
		return nil
	}
	var policy struct {
		Type  string          `json:"type"`
		Delay json.RawMessage `json:"delay"`
	}
	if err := json.Unmarshal([]byte(trimmed), &policy); err != nil {
		return nil
	}
	delay, ok := jsonNumber(policy.Delay)
	if !ok {
		return nil
	}
	normalized := maxInt(0, jsRound(delay))
	if policy.Type == "exponential" {
		exponent := maxInt(0, attempt-1)
		value := jsRound(float64(normalized) * math.Pow(2, float64(exponent)))
		return &value
	}
	return &normalized
}

// resolveQueueOverloadCooldownMs is resolveQueueOverloadCooldownMs: clamp the
// configured base cooldown to [5s,10min], scale it by the memory pressure
// percentage (>=94% x2, >=96% x3, >=98% x4) and clamp the result again.
func resolveQueueOverloadCooldownMs(configured int, memoryPercent *float64) int {
	base := memoryPressureDefaultCooldownMs
	if configured > 0 {
		base = jsRound(float64(configured))
	}
	base = clampInt(base, memoryPressureCooldownMinMs, memoryPressureCooldownMaxMs)

	multiplier := 1
	if memoryPercent != nil {
		switch {
		case *memoryPercent >= 98:
			multiplier = 4
		case *memoryPercent >= 96:
			multiplier = 3
		case *memoryPercent >= 94:
			multiplier = 2
		}
	}
	return clampInt(jsRound(float64(base*multiplier)), memoryPressureCooldownMinMs, memoryPressureCooldownMaxMs)
}

// resolveRequestTimeoutMs is resolveQueueTimeoutMs after the settings read: the
// hot queue uses requestTimeoutHotMs, the normal and legacy queues use
// requestTimeoutNormalMs; a non-positive value falls through to the
// CRAWL4AI_TIMEOUT_MS fallback, and both are floored at one second. Without any
// usable value the timeout is 120000ms.
func resolveRequestTimeoutMs(class crawlqueue.PriorityClass, settings crawlqueue.Settings, fallbackMs int) int {
	configured := settings.RequestTimeoutNormalMs
	if class == crawlqueue.PriorityClassHot {
		configured = settings.RequestTimeoutHotMs
	}
	if configured > 0 {
		return maxInt(minRequestTimeoutMs, jsRound(float64(configured)))
	}
	if fallbackMs > 0 {
		return maxInt(minRequestTimeoutMs, jsRound(float64(fallbackMs)))
	}
	return defaultRequestTimeoutMs
}

// clampInt is Math.max(min, Math.min(max, value)).
func clampInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

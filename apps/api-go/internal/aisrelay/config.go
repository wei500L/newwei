package aisrelay

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// Configuration surface of the relay. The names, aliases, defaults and minimum
// values below are copied from the Node implementation so that both versions can
// read the same .env and behave identically at startup.
const (
	// DefaultUpstreamURL is used when neither AISSTREAM_URL nor its alias is set.
	DefaultUpstreamURL = "wss://stream.aisstream.io/v0/stream"
	// DefaultListenPort mirrors the Node default (PORT, aliased by AIS_RELAY_PORT).
	DefaultListenPort = 3004
	// DefaultListenHost mirrors the Node default (AIS_RELAY_HOST, aliased by HOST).
	DefaultListenHost = "0.0.0.0"

	envUpstreamURL            = "AISSTREAM_URL"
	envUpstreamURLAlias       = "AIS_RELAY_UPSTREAM_URL"
	envPort                   = "PORT"
	envPortAlias              = "AIS_RELAY_PORT"
	envHost                   = "AIS_RELAY_HOST"
	envHostAlias              = "HOST"
	envAPIKey                 = "AISSTREAM_API_KEY"
	envSharedSecret           = "AIS_RELAY_SHARED_SECRET"
	envSharedSecretAlias      = "RELAY_SHARED_SECRET"
	envSnapshotIntervalMS     = "AIS_SNAPSHOT_INTERVAL_MS"
	envQueueHardCap           = "AIS_UPSTREAM_QUEUE_HARD_CAP"
	envDrainBatch             = "AIS_UPSTREAM_DRAIN_BATCH"
	envDrainBudgetMS          = "AIS_UPSTREAM_DRAIN_BUDGET_MS"
	envMinPositionReports     = "AIS_RELAY_HEALTH_MIN_POSITION_REPORTS"
	envMaxIgnoredRatio        = "AIS_RELAY_HEALTH_MAX_IGNORED_RATIO_PERCENT"
	envMaxParseErrorRatio     = "AIS_RELAY_HEALTH_MAX_PARSE_ERROR_RATIO_PERCENT"
	envNoMessagesAfterConnect = "AIS_RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS"
	envStaleMessages          = "AIS_RELAY_HEALTH_STALE_MESSAGES_MS"
	envMaxVessels             = "AIS_MAX_VESSELS"
	envMaxVesselHistory       = "AIS_MAX_VESSEL_HISTORY"
	envMaxCandidateReports    = "AIS_MAX_CANDIDATE_REPORTS"

	// minimumSnapshotCacheTTL mirrors the Node floor applied after readPositiveInt.
	minimumSnapshotCacheTTL = 2 * time.Second
	// maximumPositiveInt bounds parsed values so a malformed oversized number
	// cannot overflow the int conversion. The Node relay has no such bound but
	// every affected setting is a count or a port, so clamping is harmless.
	maximumPositiveInt = math.MaxInt32
)

// Config is the resolved runtime configuration of the relay.
type Config struct {
	// UpstreamURL is the AISStream websocket endpoint (AISSTREAM_URL, then
	// AIS_RELAY_UPSTREAM_URL, then DefaultUpstreamURL).
	UpstreamURL string
	// UpstreamAPIKey is the AISStream subscription key; startup fails without it.
	UpstreamAPIKey string
	// SharedSecret guards GET /ais/snapshot. An empty value disables auth, which
	// is the Node behaviour when no secret is configured.
	SharedSecret string
	// ListenHost is the bind address (AIS_RELAY_HOST, then HOST, then DefaultListenHost).
	ListenHost string
	// ListenPort is the bind port (PORT, then AIS_RELAY_PORT, then DefaultListenPort).
	ListenPort int

	// SnapshotCacheTTL is the refresh cadence of the cached snapshot; the cache
	// stores the serialised payload and the HTTP handler serves those bytes.
	SnapshotCacheTTL time.Duration
	// UpstreamQueueHardCap bounds the message backlog. Messages that arrive while
	// the queue is full are counted as dropped instead of blocking the reader.
	UpstreamQueueHardCap int
	// UpstreamDrainBatch is the maximum number of messages processed per lock
	// acquisition, which keeps a burst from starving HTTP readers.
	UpstreamDrainBatch int
	// UpstreamDrainBudget bounds how long one drain pass may hold the state lock.
	UpstreamDrainBudget time.Duration

	// HealthMinPositionReports is the sample floor below which the ratio based
	// degradation reasons stay silent.
	HealthMinPositionReports int
	// HealthMaxIgnoredRatioPercent degrades the relay when more than this share of
	// position reports is discarded during normalisation.
	HealthMaxIgnoredRatioPercent int
	// HealthMaxParseErrorRatioPercent degrades the relay on frequent parse errors.
	HealthMaxParseErrorRatioPercent int
	// HealthNoMessagesAfterConnect is how long an open stream may stay silent
	// before it is reported as degraded.
	HealthNoMessagesAfterConnect time.Duration
	// HealthStaleMessages is the silence budget for an established stream.
	HealthStaleMessages time.Duration

	// MaxVessels caps the retained vessel snapshots.
	MaxVessels int
	// MaxVesselHistory caps the tracked per-vessel sighting histories.
	MaxVesselHistory int
	// MaxCandidateReports caps the retained military candidate reports.
	MaxCandidateReports int
}

// LoadConfig resolves the relay configuration from the environment. lookup must
// report whether a variable is present, because the Node relay distinguishes an
// unset variable from an empty one when applying its `??` alias chains.
//
// A missing AISSTREAM_API_KEY is a startup error, exactly as in the Node version,
// which throws "AISSTREAM_API_KEY is required" at module load.
func LoadConfig(lookup func(name string) (string, bool)) (Config, error) {
	config := Config{
		UpstreamURL:                     normalizedAlias(lookup, DefaultUpstreamURL, envUpstreamURL, envUpstreamURLAlias),
		UpstreamAPIKey:                  normalizedAlias(lookup, "", envAPIKey),
		SharedSecret:                    normalizedAlias(lookup, "", envSharedSecret, envSharedSecretAlias),
		ListenHost:                      normalizedAlias(lookup, DefaultListenHost, envHost, envHostAlias),
		ListenPort:                      positiveIntAlias(lookup, DefaultListenPort, 1, envPort, envPortAlias),
		SnapshotCacheTTL:                snapshotCacheTTL(lookup),
		UpstreamQueueHardCap:            positiveIntAlias(lookup, 8000, 1, envQueueHardCap),
		UpstreamDrainBatch:              positiveIntAlias(lookup, 250, 1, envDrainBatch),
		UpstreamDrainBudget:             time.Duration(positiveIntAlias(lookup, 20, 1, envDrainBudgetMS)) * time.Millisecond,
		HealthMinPositionReports:        positiveIntAlias(lookup, 25, 1, envMinPositionReports),
		HealthMaxIgnoredRatioPercent:    positiveIntAlias(lookup, 85, 1, envMaxIgnoredRatio),
		HealthMaxParseErrorRatioPercent: positiveIntAlias(lookup, 20, 1, envMaxParseErrorRatio),
		HealthNoMessagesAfterConnect:    time.Duration(positiveIntAlias(lookup, 60_000, 5_000, envNoMessagesAfterConnect)) * time.Millisecond,
		HealthStaleMessages:             time.Duration(positiveIntAlias(lookup, 90_000, 10_000, envStaleMessages)) * time.Millisecond,
		MaxVessels:                      positiveIntAlias(lookup, 20_000, 1_000, envMaxVessels),
		MaxVesselHistory:                positiveIntAlias(lookup, 20_000, 1_000, envMaxVesselHistory),
		MaxCandidateReports:             positiveIntAlias(lookup, 1_500, 100, envMaxCandidateReports),
	}
	if config.UpstreamAPIKey == "" {
		return Config{}, errors.New("AISSTREAM_API_KEY is required")
	}
	return config, nil
}

// snapshotCacheTTL applies the Node floor of 2s on top of the parsed interval.
func snapshotCacheTTL(lookup func(name string) (string, bool)) time.Duration {
	interval := time.Duration(positiveIntAlias(lookup, 5_000, 1, envSnapshotIntervalMS)) * time.Millisecond
	if interval < minimumSnapshotCacheTTL {
		return minimumSnapshotCacheTTL
	}
	return interval
}

// normalizedAlias follows `normalizeString(process.env.FIRST ?? process.env.SECOND)
// ?? fallback`: the first variable that is *present* wins (an empty value still
// wins the alias race), then the value is JS-trimmed and an empty result falls back.
func normalizedAlias(lookup func(name string) (string, bool), fallback string, names ...string) string {
	raw, present := aliasValue(lookup, names...)
	if !present {
		return fallback
	}
	trimmed := jsTrim(raw)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

// positiveIntAlias follows `readPositiveInt(process.env.FIRST ?? process.env.SECOND,
// fallback, minimum)`.
func positiveIntAlias(lookup func(name string) (string, bool), fallback int, minimum int, names ...string) int {
	raw, present := aliasValue(lookup, names...)
	if !present {
		return fallback
	}
	return positiveIntValue(raw, fallback, minimum)
}

// aliasValue applies the JS `??` chain: the first present variable wins.
func aliasValue(lookup func(name string) (string, bool), names ...string) (string, bool) {
	for _, name := range names {
		if value, ok := lookup(name); ok {
			return value, true
		}
	}
	return "", false
}

// positiveIntValue reproduces readPositiveInt from the Node relay:
//
//	if (!value) return fallback;
//	const parsed = Number(value);
//	if (!Number.isFinite(parsed)) return fallback;
//	return Math.max(min, Math.floor(parsed));
//
// Note that this uses Number() and not parseInt(), so "12.9" becomes 12, "0x10"
// becomes 16, " 7 " becomes 7, and "3004abc" is not a number and therefore falls
// back instead of yielding 3004.
func positiveIntValue(raw string, fallback int, minimum int) int {
	if raw == "" {
		return fallback
	}
	parsed, ok := parseJSNumber(raw)
	if !ok {
		return fallback
	}
	floored := math.Floor(parsed)
	if floored < float64(minimum) {
		return minimum
	}
	if floored > float64(maximumPositiveInt) {
		return maximumPositiveInt
	}
	return int(floored)
}

// ListenAddress is the host:port the HTTP server binds.
func (c Config) ListenAddress() string {
	return fmt.Sprintf("%s:%d", c.ListenHost, c.ListenPort)
}

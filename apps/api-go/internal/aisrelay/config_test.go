package aisrelay

import (
	"testing"
	"time"
)

// Configuration contract: names, aliases, defaults, minimums and the required key must
// match apps/ais-relay/src/index.ts lines 29-108 so that one .env drives both relays.

func relayTestLookup(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, present := values[name]
		return value, present
	}
}

func relayTestLoadConfig(t *testing.T, values map[string]string) Config {
	t.Helper()

	config, err := LoadConfig(relayTestLookup(values))
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	return config
}

func TestConfigRequiresAPIKey(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]string
	}{
		{"missing", nil},
		{"empty", map[string]string{envAPIKey: ""}},
		{"whitespace only", map[string]string{envAPIKey: "   "}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := LoadConfig(relayTestLookup(testCase.values)); err == nil {
				t.Fatal("LoadConfig() error = nil, want AISSTREAM_API_KEY error")
			} else if err.Error() != "AISSTREAM_API_KEY is required" {
				t.Fatalf("LoadConfig() error = %q, want %q", err, "AISSTREAM_API_KEY is required")
			}
		})
	}
}

func TestConfigDefaults(t *testing.T) {
	config := relayTestLoadConfig(t, map[string]string{envAPIKey: "key"})

	checks := []struct {
		name string
		got  any
		want any
	}{
		{"upstream url", config.UpstreamURL, "wss://stream.aisstream.io/v0/stream"},
		{"api key", config.UpstreamAPIKey, "key"},
		{"shared secret", config.SharedSecret, ""},
		{"listen host", config.ListenHost, "0.0.0.0"},
		{"listen port", config.ListenPort, 3004},
		{"snapshot ttl", config.SnapshotCacheTTL, 5 * time.Second},
		{"queue hard cap", config.UpstreamQueueHardCap, 8000},
		{"drain batch", config.UpstreamDrainBatch, 250},
		{"drain budget", config.UpstreamDrainBudget, 20 * time.Millisecond},
		{"min position reports", config.HealthMinPositionReports, 25},
		{"max ignored ratio", config.HealthMaxIgnoredRatioPercent, 85},
		{"max parse error ratio", config.HealthMaxParseErrorRatioPercent, 20},
		{"no messages after connect", config.HealthNoMessagesAfterConnect, 60 * time.Second},
		{"stale messages", config.HealthStaleMessages, 90 * time.Second},
		{"max vessels", config.MaxVessels, 20000},
		{"max vessel history", config.MaxVesselHistory, 20000},
		{"max candidate reports", config.MaxCandidateReports, 1500},
		{"listen address", config.ListenAddress(), "0.0.0.0:3004"},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Fatalf("%s = %v, want %v", check.name, check.got, check.want)
		}
	}
}

func TestConfigAliasPrecedence(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]string
		field  func(Config) any
		want   any
	}{
		{
			name:   "upstream url primary",
			values: map[string]string{envAPIKey: "key", envUpstreamURL: "ws://primary", envUpstreamURLAlias: "ws://alias"},
			field:  func(c Config) any { return c.UpstreamURL },
			want:   "ws://primary",
		},
		{
			name:   "upstream url alias",
			values: map[string]string{envAPIKey: "key", envUpstreamURLAlias: "ws://alias"},
			field:  func(c Config) any { return c.UpstreamURL },
			want:   "ws://alias",
		},
		{
			// `process.env.AISSTREAM_URL ?? process.env.AIS_RELAY_UPSTREAM_URL` keeps an
			// empty primary value (it is not nullish), so normalizeString makes it absent
			// and the alias is NOT consulted.
			name:   "empty primary does not fall through to alias",
			values: map[string]string{envAPIKey: "key", envUpstreamURL: "", envUpstreamURLAlias: "ws://alias"},
			field:  func(c Config) any { return c.UpstreamURL },
			want:   "wss://stream.aisstream.io/v0/stream",
		},
		{
			name:   "port primary wins over alias",
			values: map[string]string{envAPIKey: "key", envPort: "8080", envPortAlias: "8081"},
			field:  func(c Config) any { return c.ListenPort },
			want:   8080,
		},
		{
			name:   "port alias",
			values: map[string]string{envAPIKey: "key", envPortAlias: "8081"},
			field:  func(c Config) any { return c.ListenPort },
			want:   8081,
		},
		{
			name:   "host primary wins over alias",
			values: map[string]string{envAPIKey: "key", envHost: "10.0.0.1", envHostAlias: "10.0.0.2"},
			field:  func(c Config) any { return c.ListenHost },
			want:   "10.0.0.1",
		},
		{
			name:   "host alias",
			values: map[string]string{envAPIKey: "key", envHostAlias: "10.0.0.2"},
			field:  func(c Config) any { return c.ListenHost },
			want:   "10.0.0.2",
		},
		{
			name:   "shared secret primary",
			values: map[string]string{envAPIKey: "key", envSharedSecret: "primary", envSharedSecretAlias: "alias"},
			field:  func(c Config) any { return c.SharedSecret },
			want:   "primary",
		},
		{
			name:   "shared secret alias",
			values: map[string]string{envAPIKey: "key", envSharedSecretAlias: "alias"},
			field:  func(c Config) any { return c.SharedSecret },
			want:   "alias",
		},
		{
			// normalizeString trims, so a whitespace-only secret is treated as unset and
			// auth stays disabled.
			name:   "whitespace secret is absent",
			values: map[string]string{envAPIKey: "key", envSharedSecret: "   "},
			field:  func(c Config) any { return c.SharedSecret },
			want:   "",
		},
		{
			name:   "api key is js trimmed",
			values: map[string]string{envAPIKey: "  key  "},
			field:  func(c Config) any { return c.UpstreamAPIKey },
			want:   "key",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := relayTestLoadConfig(t, testCase.values)
			if got := testCase.field(config); got != testCase.want {
				t.Fatalf("resolved %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestPositiveIntEnvUsesNumberAndFloor(t *testing.T) {
	// readPositiveInt calls Number(value), floors it, then clamps to the minimum; it does
	// NOT use parseInt. A partially numeric string therefore falls back instead of
	// yielding its numeric prefix, and a fractional value is truncated.
	cases := []struct {
		name     string
		raw      string
		fallback int
		minimum  int
		want     int
	}{
		{"plain integer", "3004", 999, 1, 3004},
		{"surrounding whitespace", " 42 ", 999, 1, 42},
		{"fraction is floored", "12.9", 999, 1, 12},
		{"negative fraction is floored", "-12.1", 999, 1, 1},
		{"scientific notation", "1e3", 999, 1, 1000},
		{"hexadecimal", "0x10", 999, 1, 16},
		{"trailing garbage falls back", "3004abc", 3004, 1, 3004},
		{"non numeric falls back", "abc", 3004, 1, 3004},
		{"infinity falls back", "Infinity", 3004, 1, 3004},
		{"empty falls back", "", 3004, 1, 3004},
		{"zero clamps to minimum", "0", 3004, 1, 1},
		{"negative clamps to minimum", "-5", 3004, 1, 1},
		// A blank string is truthy in JS, so `!value` is false and Number("   ") === 0,
		// which clamps to the minimum instead of taking the fallback.
		{"blank clamps to minimum", "   ", 3004, 1, 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := positiveIntValue(testCase.raw, testCase.fallback, testCase.minimum); got != testCase.want {
				t.Fatalf("positiveIntValue(%q) = %d, want %d", testCase.raw, got, testCase.want)
			}
		})
	}
}

func TestConfigMinimums(t *testing.T) {
	// Each minimum is the third argument of the corresponding readPositiveInt call.
	config := relayTestLoadConfig(t, map[string]string{
		envAPIKey:                 "key",
		envMaxVessels:             "5",
		envMaxVesselHistory:       "5",
		envMaxCandidateReports:    "5",
		envMaxIgnoredRatio:        "0",
		envMaxParseErrorRatio:     "0",
		envNoMessagesAfterConnect: "1",
		envStaleMessages:          "1",
		envDrainBatch:             "0",
		envDrainBudgetMS:          "0",
		envQueueHardCap:           "0",
		envMinPositionReports:     "0",
		envSnapshotIntervalMS:     "100",
	})

	checks := []struct {
		name string
		got  any
		want any
	}{
		{"max vessels", config.MaxVessels, 1000},
		{"max vessel history", config.MaxVesselHistory, 1000},
		{"max candidate reports", config.MaxCandidateReports, 100},
		{"max ignored ratio", config.HealthMaxIgnoredRatioPercent, 1},
		{"max parse error ratio", config.HealthMaxParseErrorRatioPercent, 1},
		{"no messages after connect", config.HealthNoMessagesAfterConnect, 5000 * time.Millisecond},
		{"stale messages", config.HealthStaleMessages, 10000 * time.Millisecond},
		{"drain batch", config.UpstreamDrainBatch, 1},
		{"drain budget", config.UpstreamDrainBudget, 1 * time.Millisecond},
		{"queue hard cap", config.UpstreamQueueHardCap, 1},
		{"min position reports", config.HealthMinPositionReports, 1},
		// AIS_SNAPSHOT_INTERVAL_MS has no minimum of its own; the 2s floor is applied
		// afterwards by SNAPSHOT_CACHE_TTL_MS.
		{"snapshot ttl floor", config.SnapshotCacheTTL, 2 * time.Second},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Fatalf("%s = %v, want %v", check.name, check.got, check.want)
		}
	}
}

func TestConfigSnapshotIntervalPassesThroughAboveFloor(t *testing.T) {
	config := relayTestLoadConfig(t, map[string]string{
		envAPIKey:             "key",
		envSnapshotIntervalMS: "10000",
	})
	if config.SnapshotCacheTTL != 10*time.Second {
		t.Fatalf("SnapshotCacheTTL = %v, want 10s", config.SnapshotCacheTTL)
	}
}

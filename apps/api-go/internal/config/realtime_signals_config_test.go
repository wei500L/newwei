package config

import (
	"strings"
	"testing"
)

// API_GO_REALTIME_SIGNALS_MODE is a background-only switch: the empty value is
// go, any value other than legacy/go fails startup, and go requires the
// three data stores but no JWT because the collector serves no route.
func TestRealtimeSignalsModeParsing(t *testing.T) {
	// An explicit legacy value takes the rollback branch; the empty value now
	// resolves to go, which the defaults test covers.
	for _, legacy := range []string{"legacy", "  legacy  "} {
		cfg, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_REALTIME_SIGNALS_MODE" {
				return legacy
			}
			return ""
		}))
		if err != nil {
			t.Fatalf("legacy mode %q: %v", legacy, err)
		}
		if cfg.RealtimeSignalsMode != RealtimeSignalsModeLegacy {
			t.Fatalf("legacy mode %q parsed as %s", legacy, cfg.RealtimeSignalsMode)
		}
	}
}

func TestRealtimeSignalsModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "Go", "true"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_REALTIME_SIGNALS_MODE" {
				return invalid
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), "API_GO_REALTIME_SIGNALS_MODE must be one of legacy|go") {
			t.Fatalf("mode %q: %v", invalid, err)
		}
	}
}

func TestRealtimeSignalsModeGoRequiresDataStoresWithoutJWT(t *testing.T) {
	full := map[string]string{
		"API_GO_REALTIME_SIGNALS_MODE": "go",
		"DATABASE_URL":                 "mysql://user:pass@127.0.0.1:3306/app",
		"REDIS_HOST":                   "redis",
		"MONGO_URI":                    "mongodb://127.0.0.1:27017/app",
	}
	for missing, expected := range map[string]string{
		"DATABASE_URL": "DATABASE_URL is required when API_GO_REALTIME_SIGNALS_MODE=go",
		"REDIS_HOST":   "REDIS_HOST is required when API_GO_REALTIME_SIGNALS_MODE=go",
		"MONGO_URI":    "MONGO_URI is required when API_GO_REALTIME_SIGNALS_MODE=go",
	} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == missing {
				return ""
			}
			return full[key]
		}))
		if err == nil || !strings.Contains(err.Error(), expected) {
			t.Fatalf("missing %s: %v", missing, err)
		}
	}
	cfg, err := Load(legacyUnset(func(key string) string { return full[key] }))
	if err != nil {
		t.Fatalf("go mode must not require JWT: %v", err)
	}
	if cfg.RealtimeSignalsMode != RealtimeSignalsModeGo {
		t.Fatalf("mode = %s", cfg.RealtimeSignalsMode)
	}
}

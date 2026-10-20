package config

import (
	"strings"
	"testing"
)

// TestNewsEventsIngestionModeDefaultsToLegacy locks the cross-process switch
// contract: an unset value keeps the NestJS Cron in charge, and the settle
// window falls back to 120000 ms.
func TestNewsEventsIngestionModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsIngestionMode != NewsEventsIngestionModeLegacy {
		t.Fatalf("NewsEventsIngestionMode = %q, want legacy", cfg.NewsEventsIngestionMode)
	}
	if cfg.NewsEventsIngestionSettleMs != 120_000 {
		t.Fatalf("NewsEventsIngestionSettleMs = %d, want 120000", cfg.NewsEventsIngestionSettleMs)
	}
}

// TestNewsEventsIngestionModeRejectsInvalidValue verifies only "", "legacy" and
// "go" are accepted.
func TestNewsEventsIngestionModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_NEWS_EVENTS_INGESTION_MODE" {
			return "on"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWS_EVENTS_INGESTION_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

// TestNewsEventsIngestionModeAcceptsEmptyStringAsLegacy verifies the documented
// three-value vocabulary.
func TestNewsEventsIngestionModeAcceptsEmptyStringAsLegacy(t *testing.T) {
	for _, value := range []string{"", "legacy"} {
		cfg, err := Load(func(key string) string {
			if key == "API_GO_NEWS_EVENTS_INGESTION_MODE" {
				return value
			}
			return ""
		})
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if cfg.NewsEventsIngestionMode != NewsEventsIngestionModeLegacy {
			t.Fatalf("%q => %q, want legacy", value, cfg.NewsEventsIngestionMode)
		}
	}
}

// TestNewsEventsIngestionModeRequiresMySQLRedisAndMongo verifies go mode fails
// startup without its three storage backends but needs no JWT.
func TestNewsEventsIngestionModeRequiresMySQLRedisAndMongo(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_NEWS_EVENTS_INGESTION_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("expected startup validation error")
	}
	message := err.Error()
	for _, want := range []string{
		"DATABASE_URL is required when API_GO_NEWS_EVENTS_INGESTION_MODE=go",
		"REDIS_HOST is required when API_GO_NEWS_EVENTS_INGESTION_MODE=go",
		"MONGO_URI is required when API_GO_NEWS_EVENTS_INGESTION_MODE=go",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("missing %q in %v", want, err)
		}
	}
}

// TestNewsEventsIngestionModeGoWithoutJWT verifies the background unit runs with
// every HTTP credential absent.
func TestNewsEventsIngestionModeGoWithoutJWT(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWS_EVENTS_INGESTION_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsIngestionMode != NewsEventsIngestionModeGo {
		t.Fatalf("NewsEventsIngestionMode = %q, want go", cfg.NewsEventsIngestionMode)
	}
	if cfg.JWTSecret != "" {
		t.Fatalf("JWTSecret = %q, want empty", cfg.JWTSecret)
	}
}

// TestNewsEventsIngestionSettleWindowParsing locks the settle configuration:
// zero is accepted, a negative value and a non-integer fail startup.
func TestNewsEventsIngestionSettleWindowParsing(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "NEWS_EVENTS_INGESTION_SETTLE_MS" {
			return "0"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsIngestionSettleMs != 0 {
		t.Fatalf("settle = %d, want 0", cfg.NewsEventsIngestionSettleMs)
	}

	cfg, err = Load(func(key string) string {
		if key == "NEWS_EVENTS_INGESTION_SETTLE_MS" {
			return " 45000 "
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsIngestionSettleMs != 45_000 {
		t.Fatalf("settle = %d, want 45000", cfg.NewsEventsIngestionSettleMs)
	}

	for _, invalid := range []string{"-1", "soon", "1.5"} {
		_, err := Load(func(key string) string {
			if key == "NEWS_EVENTS_INGESTION_SETTLE_MS" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "NEWS_EVENTS_INGESTION_SETTLE_MS must be a non-negative integer") {
			t.Fatalf("%q => %v", invalid, err)
		}
	}
}

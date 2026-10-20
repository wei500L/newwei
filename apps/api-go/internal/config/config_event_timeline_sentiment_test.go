package config

import (
	"strings"
	"testing"
)

// TestEventTimelineSentimentModesDefaultToLegacy pins the default and the
// empty-string behaviour of both switches.
func TestEventTimelineSentimentModesDefaultToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsEventsTimelineMode != NewsEventsTimelineModeLegacy {
		t.Fatalf("timeline mode = %s, want legacy", cfg.NewsEventsTimelineMode)
	}
	if cfg.SentimentSnapshotMode != SentimentSnapshotModeLegacy {
		t.Fatalf("sentiment mode = %s, want legacy", cfg.SentimentSnapshotMode)
	}
	for _, empty := range []string{"", "  "} {
		cfg, err := Load(func(key string) string {
			switch key {
			case "API_GO_NEWS_EVENTS_TIMELINE_MODE", "API_GO_SENTIMENT_SNAPSHOT_MODE":
				return empty
			default:
				return ""
			}
		})
		if err != nil {
			t.Fatalf("empty mode %q: %v", empty, err)
		}
		if cfg.NewsEventsTimelineMode != NewsEventsTimelineModeLegacy ||
			cfg.SentimentSnapshotMode != SentimentSnapshotModeLegacy {
			t.Fatalf("empty mode %q parsed as %s/%s", empty,
				cfg.NewsEventsTimelineMode, cfg.SentimentSnapshotMode)
		}
	}
}

// TestEventTimelineSentimentModesRejectInvalid pins the fail-closed parse.
func TestEventTimelineSentimentModesRejectInvalid(t *testing.T) {
	for _, testCase := range []struct{ key, invalid string }{
		{"API_GO_NEWS_EVENTS_TIMELINE_MODE", "shadow"},
		{"API_GO_NEWS_EVENTS_TIMELINE_MODE", "Go"},
		{"API_GO_NEWS_EVENTS_TIMELINE_MODE", "true"},
		{"API_GO_SENTIMENT_SNAPSHOT_MODE", "canary"},
		{"API_GO_SENTIMENT_SNAPSHOT_MODE", "on"},
	} {
		_, err := Load(func(key string) string {
			if key == testCase.key {
				return testCase.invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), testCase.key+" must be one of legacy|go") {
			t.Fatalf("%s=%q: %v", testCase.key, testCase.invalid, err)
		}
	}
}

// TestEventTimelineSentimentGoRequiresMySQLRedisMongo pins the startup
// requirements: both cron units serve no route, so JWT_SECRET is not one.
func TestEventTimelineSentimentGoRequiresMySQLRedisMongo(t *testing.T) {
	full := map[string]string{
		"DATABASE_URL": "mysql://user:pass@127.0.0.1:3306/app",
		"REDIS_HOST":   "redis",
		"MONGO_URI":    "mongodb://127.0.0.1:27017/app",
	}
	for _, modeKey := range []string{"API_GO_NEWS_EVENTS_TIMELINE_MODE", "API_GO_SENTIMENT_SNAPSHOT_MODE"} {
		for missing, expected := range map[string]string{
			"DATABASE_URL": "DATABASE_URL is required when " + modeKey + "=go",
			"REDIS_HOST":   "REDIS_HOST is required when " + modeKey + "=go",
			"MONGO_URI":    "MONGO_URI is required when " + modeKey + "=go",
		} {
			_, err := Load(func(key string) string {
				if key == modeKey {
					return "go"
				}
				if key == missing {
					return ""
				}
				return full[key]
			})
			if err == nil || !strings.Contains(err.Error(), expected) {
				t.Fatalf("%s missing %s: %v", modeKey, missing, err)
			}
		}

		cfg, err := Load(func(key string) string {
			if key == modeKey {
				return "go"
			}
			return full[key]
		})
		if err != nil {
			t.Fatalf("%s=go must not require JWT: %v", modeKey, err)
		}
		switch modeKey {
		case "API_GO_NEWS_EVENTS_TIMELINE_MODE":
			if cfg.NewsEventsTimelineMode != NewsEventsTimelineModeGo {
				t.Fatalf("timeline mode = %s", cfg.NewsEventsTimelineMode)
			}
			if cfg.SentimentSnapshotMode != SentimentSnapshotModeLegacy {
				t.Fatalf("sentiment mode followed the timeline switch: %s", cfg.SentimentSnapshotMode)
			}
		case "API_GO_SENTIMENT_SNAPSHOT_MODE":
			if cfg.SentimentSnapshotMode != SentimentSnapshotModeGo {
				t.Fatalf("sentiment mode = %s", cfg.SentimentSnapshotMode)
			}
			if cfg.NewsEventsTimelineMode != NewsEventsTimelineModeLegacy {
				t.Fatalf("timeline mode followed the sentiment switch: %s", cfg.NewsEventsTimelineMode)
			}
		}
	}
}

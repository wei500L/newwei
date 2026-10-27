package config

import (
	"strings"
	"testing"
)

func TestCrawlWorkerModeDefaults(t *testing.T) {
	for _, value := range []string{"legacy", "  legacy  "} {
		cfg, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_CRAWL_WORKER_MODE" {
				return value
			}
			return ""
		}))
		if err != nil {
			t.Fatalf("Load(%q) error = %v", value, err)
		}
		if cfg.CrawlWorkerMode != CrawlWorkerModeLegacy {
			t.Fatalf("mode(%q) = %s", value, cfg.CrawlWorkerMode)
		}
	}
}

func TestCrawlWorkerModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_CRAWL_WORKER_MODE" {
			return "shadow"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_WORKER_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

func TestCrawlWorkerModeGoRequiresEveryDependency(t *testing.T) {
	deps := map[string]string{
		"DATABASE_URL":                   "mysql://user:pass@127.0.0.1:3306/app",
		"REDIS_HOST":                     "127.0.0.1",
		"MONGO_URI":                      "mongodb://127.0.0.1:27017/app",
		"CRAWL4AI_BASE_URL":              "http://127.0.0.1:11235",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	missing := []struct {
		key      string
		expected string
	}{
		{"DATABASE_URL", "DATABASE_URL is required when API_GO_CRAWL_WORKER_MODE=go"},
		{"REDIS_HOST", "REDIS_HOST is required when API_GO_CRAWL_WORKER_MODE=go"},
		{"MONGO_URI", "MONGO_URI is required when API_GO_CRAWL_WORKER_MODE=go"},
		{"CRAWL4AI_BASE_URL", "CRAWL4AI_BASE_URL is required when API_GO_CRAWL_WORKER_MODE=go"},
		{"SYSTEM_SETTINGS_ENCRYPTION_KEY", "SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_CRAWL_WORKER_MODE=go"},
	}
	for _, tc := range missing {
		t.Run(tc.key, func(t *testing.T) {
			_, err := Load(legacyUnset(func(key string) string {
				if key == "API_GO_CRAWL_WORKER_MODE" {
					return "go"
				}
				if key == tc.key {
					return ""
				}
				return deps[key]
			}))
			if err == nil || !strings.Contains(err.Error(), tc.expected) {
				t.Fatalf("missing %q in %v", tc.expected, err)
			}
		})
	}

	cfg, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_CRAWL_WORKER_MODE" {
			return "go"
		}
		return deps[key]
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.CrawlWorkerMode != CrawlWorkerModeGo {
		t.Fatalf("mode = %s", cfg.CrawlWorkerMode)
	}
}

func TestCrawlWorkerMediaDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.CrawlMediaFetchTimeoutMs != 15_000 {
		t.Errorf("media fetch timeout = %d", cfg.CrawlMediaFetchTimeoutMs)
	}
	if cfg.CrawlMediaMaxBytes != 2_097_152 {
		t.Errorf("media max bytes = %d", cfg.CrawlMediaMaxBytes)
	}
	if cfg.CrawlMediaMaxPerResult != 6 {
		t.Errorf("media max per result = %d", cfg.CrawlMediaMaxPerResult)
	}
}

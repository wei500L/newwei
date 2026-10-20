package config

import (
	"strings"
	"testing"
)

func credentialed(key string) string {
	switch key {
	case "JWT_SECRET":
		return "secret"
	case "DATABASE_URL":
		return "mysql://user:pass@127.0.0.1:3306/app"
	case "REDIS_HOST":
		return "redis"
	}
	return ""
}

// TestCrawlTaskWriteModeDefaultsToLegacy pins that both switches default to
// legacy when unset or explicit.
func TestCrawlTaskWriteModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTaskWriteMode != CrawlTaskWriteModeLegacy || cfg.CrawlQueueOpsMode != CrawlQueueOpsModeLegacy {
		t.Fatalf("modes = %s/%s", cfg.CrawlTaskWriteMode, cfg.CrawlQueueOpsMode)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_TASK_WRITE_MODE", "API_GO_CRAWL_QUEUE_OPS_MODE":
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTaskWriteMode != CrawlTaskWriteModeLegacy || cfg.CrawlQueueOpsMode != CrawlQueueOpsModeLegacy {
		t.Fatalf("modes = %s/%s", cfg.CrawlTaskWriteMode, cfg.CrawlQueueOpsMode)
	}
}

func TestCrawlTaskWriteModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_TASK_WRITE_MODE" {
			return "shadow"
		}
		return credentialed(key)
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_TASK_WRITE_MODE must be one of legacy|go") {
		t.Fatalf("write mode: %v", err)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_QUEUE_OPS_MODE" {
			return "canary"
		}
		return credentialed(key)
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_QUEUE_OPS_MODE must be one of legacy|go") {
		t.Fatalf("queue mode: %v", err)
	}
}

func TestCrawlTaskWriteModeRequiresCredentialedStack(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_TASK_WRITE_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required when API_GO_CRAWL_TASK_WRITE_MODE=go") {
		t.Fatalf("write mode credentials: %v", err)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_QUEUE_OPS_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CRAWL_QUEUE_OPS_MODE=go") {
		t.Fatalf("queue mode credentials: %v", err)
	}
	cfg, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_TASK_WRITE_MODE" || key == "API_GO_CRAWL_QUEUE_OPS_MODE" {
			return "go"
		}
		return credentialed(key)
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTaskWriteMode != CrawlTaskWriteModeGo || cfg.CrawlQueueOpsMode != CrawlQueueOpsModeGo {
		t.Fatalf("modes = %s/%s", cfg.CrawlTaskWriteMode, cfg.CrawlQueueOpsMode)
	}
	if cfg.MongoURI != "" {
		t.Fatal("neither switch may require Mongo")
	}
}

func TestCrawl4aiEnvironmentDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlMaxConcurrency != 3 || cfg.CrawlMaxRetries != 3 || cfg.CrawlRetryBackoffMs != 5000 {
		t.Fatalf("defaults = %d/%d/%d", cfg.CrawlMaxConcurrency, cfg.CrawlMaxRetries, cfg.CrawlRetryBackoffMs)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "CRAWL4AI_MAX_CONCURRENCY":
			return "7"
		case "CRAWL4AI_MAX_RETRIES":
			return "4"
		case "CRAWL4AI_RETRY_BACKOFF_MS":
			return "900"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlMaxConcurrency != 7 || cfg.CrawlMaxRetries != 4 || cfg.CrawlRetryBackoffMs != 900 {
		t.Fatalf("env values = %d/%d/%d", cfg.CrawlMaxConcurrency, cfg.CrawlMaxRetries, cfg.CrawlRetryBackoffMs)
	}
}

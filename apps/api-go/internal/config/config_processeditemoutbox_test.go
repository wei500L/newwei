package config

import (
	"strings"
	"testing"
)

func TestProcessedItemOutboxDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProcessedItemOutboxMode != ProcessedItemOutboxModeLegacy {
		t.Fatalf("mode = %q, want legacy", cfg.ProcessedItemOutboxMode)
	}
	if cfg.ProcessedItemOutboxTickBudgetMs != 240000 {
		t.Fatalf("tick budget = %d, want 240000", cfg.ProcessedItemOutboxTickBudgetMs)
	}
	if cfg.ProcessedItemOutboxConcurrency != 4 || cfg.ProcessedItemOutboxBatchSize != 10 {
		t.Fatalf("concurrency/batch = %d/%d, want 4/10", cfg.ProcessedItemOutboxConcurrency, cfg.ProcessedItemOutboxBatchSize)
	}
}

func TestProcessedItemOutboxRejectsInvalidValues(t *testing.T) {
	if _, err := Load(func(key string) string {
		if key == "API_GO_PROCESSED_ITEM_OUTBOX_MODE" {
			return "sometimes"
		}
		return ""
	}); err == nil || !strings.Contains(err.Error(), "API_GO_PROCESSED_ITEM_OUTBOX_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
	for _, key := range []string{
		"PROCESSED_ITEM_OUTBOX_TICK_BUDGET_MS",
		"PROCESSED_ITEM_OUTBOX_CONCURRENCY",
		"PROCESSED_ITEM_OUTBOX_BATCH_SIZE",
	} {
		if _, err := Load(func(candidate string) string {
			if candidate == key {
				return "0"
			}
			return ""
		}); err == nil || !strings.Contains(err.Error(), key+" must be a positive integer") {
			t.Fatalf("invalid %s error = %v", key, err)
		}
	}
}

func TestProcessedItemOutboxGoRequiresMySQLRedisAndMongo(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_PROCESSED_ITEM_OUTBOX_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("expected missing resources to fail startup")
	}
	for _, expected := range []string{
		"DATABASE_URL is required when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go",
		"REDIS_HOST is required when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go",
		"MONGO_URI is required when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go",
	} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("error %q does not contain %q", err, expected)
		}
	}
}

func TestProcessedItemOutboxGoAllowsOnlyBackgroundResources(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_PROCESSED_ITEM_OUTBOX_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/app"
		case "PROCESSED_ITEM_OUTBOX_TICK_BUDGET_MS":
			return "120000"
		case "PROCESSED_ITEM_OUTBOX_CONCURRENCY":
			return "6"
		case "PROCESSED_ITEM_OUTBOX_BATCH_SIZE":
			return "20"
		case "SCHEDULE_ENABLED":
			return "false"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProcessedItemOutboxMode != ProcessedItemOutboxModeGo {
		t.Fatalf("mode = %q, want go", cfg.ProcessedItemOutboxMode)
	}
	if cfg.ProcessedItemOutboxTickBudgetMs != 120000 || cfg.ProcessedItemOutboxConcurrency != 6 || cfg.ProcessedItemOutboxBatchSize != 20 {
		t.Fatalf("throughput config = %d/%d/%d", cfg.ProcessedItemOutboxTickBudgetMs, cfg.ProcessedItemOutboxConcurrency, cfg.ProcessedItemOutboxBatchSize)
	}
	if cfg.JWTSecret != "" || cfg.ScheduleEnabled {
		t.Fatalf("unexpected credential or schedule state: jwt=%q schedule=%v", cfg.JWTSecret, cfg.ScheduleEnabled)
	}
}

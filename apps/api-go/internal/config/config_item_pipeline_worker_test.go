package config

import (
	"strings"
	"testing"
)

func TestItemPipelineWorkerModeDefaultsToLegacy(t *testing.T) {
	for _, value := range []string{"", "legacy"} {
		cfg, err := Load(func(key string) string {
			if key == "API_GO_ITEM_PIPELINE_WORKER_MODE" {
				return value
			}
			return ""
		})
		if err != nil {
			t.Fatalf("Load(%q) error = %v", value, err)
		}
		if cfg.ItemPipelineWorkerMode != ItemPipelineWorkerModeLegacy {
			t.Fatalf("mode(%q) = %s", value, cfg.ItemPipelineWorkerMode)
		}
	}
}

func TestItemPipelineWorkerModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_ITEM_PIPELINE_WORKER_MODE" {
			return "all"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_ITEM_PIPELINE_WORKER_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

func TestItemPipelineWorkerModeGoRequiresConnectionsAndKey(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_ITEM_PIPELINE_WORKER_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("go without connections must fail")
	}
	for _, expected := range []string{
		"DATABASE_URL is required when API_GO_ITEM_PIPELINE_WORKER_MODE=go",
		"REDIS_HOST is required when API_GO_ITEM_PIPELINE_WORKER_MODE=go",
		"MONGO_URI is required when API_GO_ITEM_PIPELINE_WORKER_MODE=go",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_ITEM_PIPELINE_WORKER_MODE=go",
	} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("missing %q in %v", expected, err)
		}
	}

	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_ITEM_PIPELINE_WORKER_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/app"
		case "SYSTEM_SETTINGS_ENCRYPTION_KEY":
			return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ItemPipelineWorkerMode != ItemPipelineWorkerModeGo {
		t.Fatalf("mode = %s", cfg.ItemPipelineWorkerMode)
	}
}

func TestItemPipelineFailureConfigDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.NewsSourceSchedulerFailureRecoveryDelayMs != 600_000 {
		t.Errorf("failure recovery delay = %d", cfg.NewsSourceSchedulerFailureRecoveryDelayMs)
	}
	if cfg.NewsSourceSchedulerFailureMaxDelayMs != 21_600_000 {
		t.Errorf("failure max delay = %d", cfg.NewsSourceSchedulerFailureMaxDelayMs)
	}
	if cfg.NewsSourceSchedulerCircuitBreakerThreshold != 3 {
		t.Errorf("circuit breaker threshold = %v", cfg.NewsSourceSchedulerCircuitBreakerThreshold)
	}
	if cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs != 3_600_000 {
		t.Errorf("circuit breaker base delay = %d", cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs)
	}
	if cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs != 86_400_000 {
		t.Errorf("circuit breaker max delay = %d", cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs)
	}
	if cfg.NewsSourceSchedulerAutoDisableThreshold != 0 {
		t.Errorf("auto disable threshold = %v", cfg.NewsSourceSchedulerAutoDisableThreshold)
	}
}

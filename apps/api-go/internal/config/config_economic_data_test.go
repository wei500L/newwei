package config

import (
	"strings"
	"testing"
)

func TestEconomicDataModesDefaultToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.EconomicDataMode != EconomicDataModeLegacy {
		t.Fatalf("EconomicDataMode = %q", cfg.EconomicDataMode)
	}
	if cfg.EconomicDataWorkerMode != EconomicDataWorkerModeLegacy {
		t.Fatalf("EconomicDataWorkerMode = %q", cfg.EconomicDataWorkerMode)
	}
	if !cfg.AkshareEnabled || cfg.AkshareBaseURL != "http://localhost:8081" {
		t.Fatalf("akshare defaults = enabled:%t base:%s", cfg.AkshareEnabled, cfg.AkshareBaseURL)
	}
	if cfg.AkshareTimeoutMs != 20000 || cfg.AkshareMaxRetries != 3 || cfg.AkshareQueueConcurrency != 2 {
		t.Fatalf("akshare numeric defaults = %+v", cfg)
	}
}

func TestEconomicDataModesRejectInvalidValues(t *testing.T) {
	for _, key := range []string{"API_GO_ECONOMIC_DATA_MODE", "API_GO_ECONOMIC_DATA_WORKER_MODE"} {
		if _, err := Load(func(name string) string {
			if name == key {
				return "enabled"
			}
			return ""
		}); err == nil {
			t.Fatalf("Load() accepted %s=enabled", key)
		}
	}
}

func TestEconomicDataRequestGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_ECONOMIC_DATA_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET is required when API_GO_ECONOMIC_DATA_MODE=go") {
		t.Fatalf("missing request credentials: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_ECONOMIC_DATA_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("request go should not require Mongo: %v", err)
	}
	if cfg.EconomicDataMode != EconomicDataModeGo {
		t.Fatalf("mode = %s", cfg.EconomicDataMode)
	}
}

func TestEconomicDataWorkerGoDoesNotRequireJWT(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_ECONOMIC_DATA_WORKER_MODE":
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
		t.Fatalf("worker go should not require JWT: %v", err)
	}
	if cfg.EconomicDataWorkerMode != EconomicDataWorkerModeGo {
		t.Fatalf("worker mode = %s", cfg.EconomicDataWorkerMode)
	}
	if cfg.EconomicDataMode != EconomicDataModeLegacy {
		t.Fatalf("request mode must stay legacy: %s", cfg.EconomicDataMode)
	}
}

func TestEconomicDataWorkerGoRequiresMongo(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_ECONOMIC_DATA_WORKER_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_ECONOMIC_DATA_WORKER_MODE=go") {
		t.Fatalf("missing worker Mongo: %v", err)
	}
}

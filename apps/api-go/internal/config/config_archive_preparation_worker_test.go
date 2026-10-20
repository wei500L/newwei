package config

import (
	"strings"
	"testing"
)

func TestArchivePreparationWorkerModeDefaultsToLegacy(t *testing.T) {
	for _, value := range []string{"", "legacy"} {
		cfg, err := Load(func(key string) string {
			if key == "API_GO_ARCHIVE_PREPARATION_WORKER_MODE" {
				return value
			}
			return ""
		})
		if err != nil {
			t.Fatalf("Load(%q) error = %v", value, err)
		}
		if cfg.ArchivePreparationWorkerMode != ArchivePreparationWorkerModeLegacy {
			t.Fatalf("mode(%q) = %s", value, cfg.ArchivePreparationWorkerMode)
		}
	}
}

func TestArchivePreparationWorkerModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_ARCHIVE_PREPARATION_WORKER_MODE" {
			return "worker"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_ARCHIVE_PREPARATION_WORKER_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

func TestArchivePreparationWorkerModeGoRequiresConnectionsAndKey(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_ARCHIVE_PREPARATION_WORKER_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("go without connections must fail")
	}
	for _, expected := range []string{
		"DATABASE_URL is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go",
		"REDIS_HOST is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go",
		"MONGO_URI is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go",
	} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("missing %q in %v", expected, err)
		}
	}

	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_ARCHIVE_PREPARATION_WORKER_MODE":
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
	if cfg.ArchivePreparationWorkerMode != ArchivePreparationWorkerModeGo {
		t.Fatalf("mode = %s", cfg.ArchivePreparationWorkerMode)
	}
}

package config

import (
	"strings"
	"testing"
)

// TestCrawlMaintenanceModeDefaultsToLegacy locks the default ownership: both
// switches default to legacy and the janitor keeps the NestJS defaults.
func TestCrawlMaintenanceModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.CrawlMaintenanceMode != CrawlMaintenanceModeGo {
		t.Fatalf("CrawlMaintenanceMode = %q, want go", cfg.CrawlMaintenanceMode)
	}
	if cfg.AuditLogRetentionMode != AuditLogRetentionModeGo {
		t.Fatalf("AuditLogRetentionMode = %q, want go", cfg.AuditLogRetentionMode)
	}
	if !cfg.CrawlTaskJanitorEnabled {
		t.Fatal("CrawlTaskJanitorEnabled = false, want true by default")
	}
	if cfg.CrawlTaskRunningTimeoutMs != 1_800_000 ||
		cfg.CrawlTaskQueuedTimeoutMs != 43_200_000 ||
		cfg.CrawlTaskJanitorBatchSize != 50 ||
		cfg.CrawlTaskJanitorQueueScanLimit != 5_000 ||
		cfg.CrawlTaskJanitorLockTTLMs != 120_000 {
		t.Fatalf("janitor defaults = %+v", cfg)
	}
}

// TestCrawlMaintenanceModeAcceptsGo verifies the two independent switches and
// the resources they require.
func TestCrawlMaintenanceModeAcceptsGo(t *testing.T) {
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CRAWL_MAINTENANCE_MODE":
			return "go"
		case "API_GO_AUDIT_LOG_RETENTION_MODE":
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
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlMaintenanceMode != CrawlMaintenanceModeGo ||
		cfg.AuditLogRetentionMode != AuditLogRetentionModeGo {
		t.Fatalf("modes = %q/%q", cfg.CrawlMaintenanceMode, cfg.AuditLogRetentionMode)
	}
}

// TestCrawlMaintenanceModeRejectsInvalidValue locks the startup failure.
func TestCrawlMaintenanceModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_CRAWL_MAINTENANCE_MODE" {
			return "sometimes"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_MAINTENANCE_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

// TestAuditLogRetentionModeRejectsInvalidValue locks the second switch.
func TestAuditLogRetentionModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_AUDIT_LOG_RETENTION_MODE" {
			return "enabled"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_AUDIT_LOG_RETENTION_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

// TestCrawlMaintenanceModeRequiresMongo names the third dependency.
func TestCrawlMaintenanceModeRequiresMongo(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CRAWL_MAINTENANCE_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	}))
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_CRAWL_MAINTENANCE_MODE=go") {
		t.Fatalf("missing mongo error = %v", err)
	}
}

// TestAuditLogRetentionModeNeedsNoMongo verifies the purge only needs MySQL and
// Redis.
func TestAuditLogRetentionModeNeedsNoMongo(t *testing.T) {
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_AUDIT_LOG_RETENTION_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MongoURI != "" {
		t.Fatalf("MongoURI = %q, want empty", cfg.MongoURI)
	}
}

// TestCrawlMaintenanceJanitorEnvOverrides verifies the Go janitor reads the
// same environment the NestJS schema exposes.
func TestCrawlMaintenanceJanitorEnvOverrides(t *testing.T) {
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "CRAWL_TASK_JANITOR_ENABLED":
			return "false"
		case "CRAWL_TASK_RUNNING_TIMEOUT_MS":
			return "9000"
		case "CRAWL_TASK_QUEUED_TIMEOUT_MS":
			return "12345"
		case "CRAWL_TASK_JANITOR_BATCH_SIZE":
			return "7"
		case "CRAWL_TASK_JANITOR_QUEUE_SCAN_LIMIT":
			return "99"
		case "CRAWL_TASK_JANITOR_LOCK_TTL_MS":
			return "60000"
		default:
			return ""
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTaskJanitorEnabled ||
		cfg.CrawlTaskRunningTimeoutMs != 9000 ||
		cfg.CrawlTaskQueuedTimeoutMs != 12345 ||
		cfg.CrawlTaskJanitorBatchSize != 7 ||
		cfg.CrawlTaskJanitorQueueScanLimit != 99 ||
		cfg.CrawlTaskJanitorLockTTLMs != 60000 {
		t.Fatalf("janitor overrides = %+v", cfg)
	}
}

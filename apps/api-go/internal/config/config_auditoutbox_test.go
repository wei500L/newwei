package config

import (
	"strings"
	"testing"
)

// TestAuditOutboxModeRejectsInvalidValue locks the cross-process switch
// contract: only "", "legacy" and "go" are accepted.
func TestAuditOutboxModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_AUDIT_OUTBOX_MODE" {
			return "sometimes"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_AUDIT_OUTBOX_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

// TestAuditOutboxModeEmptyIsLegacy covers the documented empty-string
// compatibility and the default-on schedule switch.
func TestAuditOutboxModeEmptyIsLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuditOutboxMode != AuditOutboxModeLegacy {
		t.Fatalf("AuditOutboxMode = %q, want legacy", cfg.AuditOutboxMode)
	}
	if !cfg.ScheduleEnabled {
		t.Fatal("ScheduleEnabled = false, want true when SCHEDULE_ENABLED is unset")
	}
}

// TestAuditOutboxModeOnlyNeedsMySQLAndRedis verifies the background owner can
// run while JWT, Mongo, SMTP and every HTTP switch stay unconfigured.
func TestAuditOutboxModeOnlyNeedsMySQLAndRedis(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_AUDIT_OUTBOX_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "SCHEDULE_ENABLED":
			return "false"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuditOutboxMode != AuditOutboxModeGo {
		t.Fatalf("AuditOutboxMode = %q, want go", cfg.AuditOutboxMode)
	}
	if cfg.ScheduleEnabled {
		t.Fatal("ScheduleEnabled = true, want false for SCHEDULE_ENABLED=false")
	}
	if cfg.JWTSecret != "" || cfg.MongoURI != "" || cfg.SMTP.Host != "" {
		t.Fatalf("unexpected credentialed resources: jwt=%q mongo=%q smtp=%q", cfg.JWTSecret, cfg.MongoURI, cfg.SMTP.Host)
	}
}

// TestAuditOutboxModeRequiresResources names each missing startup dependency.
func TestAuditOutboxModeRequiresResources(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_AUDIT_OUTBOX_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("expected missing DATABASE_URL to fail startup")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL is required when API_GO_AUDIT_OUTBOX_MODE=go") {
		t.Fatalf("error = %v", err)
	}
	if !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_AUDIT_OUTBOX_MODE=go") {
		t.Fatalf("error = %v", err)
	}
}

package config

import (
	"strings"
	"testing"
)

// TestUserDigestDeliveryModeRejectsInvalidValue locks the cross-process switch
// contract: only "", "legacy" and "go" are accepted.
func TestUserDigestDeliveryModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_USER_DIGEST_DELIVERY_MODE" {
			return "sometimes"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_USER_DIGEST_DELIVERY_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

// TestUserDigestDeliveryModeOnlyNeedsDeliveryResources verifies delivery-only
// can run while every HTTP switch and JWT_SECRET are absent.
func TestUserDigestDeliveryModeOnlyNeedsDeliveryResources(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_USER_DIGEST_DELIVERY_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		case "SMTP_HOST":
			return "smtp.example.com"
		case "SMTP_PORT":
			return "465"
		case "SMTP_USER":
			return "digest@example.com"
		case "SMTP_PASS":
			return "secret"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UserDigestDeliveryMode != UserDigestDeliveryModeGo {
		t.Fatalf("UserDigestDeliveryMode = %q, want go", cfg.UserDigestDeliveryMode)
	}
	if cfg.UserDigestMode != UserDigestModeLegacy {
		t.Fatalf("UserDigestMode = %q, want legacy", cfg.UserDigestMode)
	}
	if cfg.JWTSecret != "" {
		t.Fatalf("JWTSecret = %q, want empty", cfg.JWTSecret)
	}
}

// TestUserDigestDeliveryModeEmptyIsLegacy covers the documented empty-string
// compatibility.
func TestUserDigestDeliveryModeEmptyIsLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UserDigestDeliveryMode != UserDigestDeliveryModeLegacy {
		t.Fatalf("UserDigestDeliveryMode = %q, want legacy", cfg.UserDigestDeliveryMode)
	}
}

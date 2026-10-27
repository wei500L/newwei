package config

import "testing"

// TestRealtimeSocketDefaults pins the legacy defaults so an unset deployment
// keeps the NestJS transport and the shared adapter configuration.
func TestRealtimeSocketDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.RealtimeSocketMode != RealtimeSocketModeGo {
		t.Fatalf("RealtimeSocketMode = %q, want go", cfg.RealtimeSocketMode)
	}
	if cfg.ClassificationQualityAlertMode != ClassificationQualityAlertModeGo {
		t.Fatalf("ClassificationQualityAlertMode = %q, want go", cfg.ClassificationQualityAlertMode)
	}
	if !cfg.WSRedisAdapterEnabled {
		t.Fatal("WSRedisAdapterEnabled must default to true like the NestJS env schema")
	}
	if cfg.WSRedisAdapterKey != "socket.io" {
		t.Fatalf("WSRedisAdapterKey = %q, want socket.io", cfg.WSRedisAdapterKey)
	}
}

func TestRealtimeSocketRejectsInvalidMode(t *testing.T) {
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_REALTIME_SOCKET_MODE" {
			return "yes"
		}
		return ""
	})); err == nil {
		t.Fatal("Load() should reject an invalid realtime socket mode")
	}
}

func TestRealtimeSocketGoRequiresAuth(t *testing.T) {
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_REALTIME_SOCKET_MODE" {
			return "go"
		}
		return ""
	})); err == nil {
		t.Fatal("Load() should require JWT/DATABASE_URL/REDIS_HOST in go mode")
	}
}

func TestRealtimeSocketGoRequiresRedisAdapter(t *testing.T) {
	authOnly := func(key string) string {
		switch key {
		case "API_GO_REALTIME_SOCKET_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		case "WS_REDIS_ADAPTER_ENABLED":
			return "false"
		default:
			return ""
		}
	}
	if _, err := Load(authOnly); err == nil {
		t.Fatal("go mode must reject WS_REDIS_ADAPTER_ENABLED=false")
	}
	enabled := func(key string) string {
		if key == "WS_REDIS_ADAPTER_ENABLED" {
			return "true"
		}
		return authOnly(key)
	}
	cfg, err := Load(enabled)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.RealtimeSocketMode != RealtimeSocketModeGo {
		t.Fatalf("RealtimeSocketMode = %q, want go", cfg.RealtimeSocketMode)
	}
}

func TestClassificationQualityAlertModeParsing(t *testing.T) {
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_CLASSIFICATION_QUALITY_ALERT_MODE" {
			return "yes"
		}
		return ""
	})); err == nil {
		t.Fatal("Load() should reject an invalid classification quality alert mode")
	}
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_CLASSIFICATION_QUALITY_ALERT_MODE" {
			return "go"
		}
		return ""
	})); err == nil {
		t.Fatal("Load() should require JWT/DATABASE_URL/REDIS_HOST in go mode")
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CLASSIFICATION_QUALITY_ALERT_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/test"
		default:
			return ""
		}
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ClassificationQualityAlertMode != ClassificationQualityAlertModeGo {
		t.Fatalf("ClassificationQualityAlertMode = %q, want go", cfg.ClassificationQualityAlertMode)
	}
	// The scheduler needs Mongo for the summary documents; a missing MONGO_URI
	// must fail startup instead of degrading to a permanently failing cron.
	if _, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CLASSIFICATION_QUALITY_ALERT_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		default:
			return ""
		}
	})); err == nil {
		t.Fatal("Load() should require MONGO_URI when the classification alert scheduler is go")
	}
}

func TestWSRedisAdapterConfigParsing(t *testing.T) {
	for _, value := range []string{"false", "0", "no", "n", "off"} {
		cfg, err := Load(legacyUnset(func(key string) string {
			if key == "WS_REDIS_ADAPTER_ENABLED" {
				return value
			}
			return ""
		}))
		if err != nil {
			t.Fatalf("Load(WS_REDIS_ADAPTER_ENABLED=%q) error = %v", value, err)
		}
		if cfg.WSRedisAdapterEnabled {
			t.Fatalf("WS_REDIS_ADAPTER_ENABLED=%q parsed as true", value)
		}
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "WS_REDIS_ADAPTER_ENABLED":
			return "on"
		case "WS_REDIS_ADAPTER_KEY":
			return "custom-key"
		default:
			return ""
		}
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.WSRedisAdapterEnabled || cfg.WSRedisAdapterKey != "custom-key" {
		t.Fatalf("unexpected adapter config: enabled=%t key=%q", cfg.WSRedisAdapterEnabled, cfg.WSRedisAdapterKey)
	}
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "WS_REDIS_ADAPTER_ENABLED" {
			return "maybe"
		}
		return ""
	})); err == nil {
		t.Fatal("Load() should reject a non-boolean WS_REDIS_ADAPTER_ENABLED")
	}
}

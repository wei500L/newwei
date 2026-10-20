package config

import "testing"

func TestNotificationsSocketDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.NotificationsSocketMode != NotificationsSocketModeLegacy {
		t.Fatalf("NotificationsSocketMode = %q, want legacy", cfg.NotificationsSocketMode)
	}
	if cfg.WSMaxConnectionsPerUser != 5 || cfg.WSMaxConnectionsPerIP != 50 {
		t.Fatalf("unexpected connection caps: user=%d ip=%d", cfg.WSMaxConnectionsPerUser, cfg.WSMaxConnectionsPerIP)
	}
	if cfg.WSConnectRateLimitPerIP != 60 || cfg.WSConnectRateLimitPerUser != 30 || cfg.WSConnectRateLimitWindowSeconds != 60 {
		t.Fatalf("unexpected rate limits: ip=%d user=%d window=%d", cfg.WSConnectRateLimitPerIP, cfg.WSConnectRateLimitPerUser, cfg.WSConnectRateLimitWindowSeconds)
	}
}

func TestNotificationsSocketRejectsInvalidMode(t *testing.T) {
	if _, err := Load(func(key string) string {
		if key == "API_GO_NOTIFICATIONS_SOCKET_MODE" {
			return "yes"
		}
		return ""
	}); err == nil {
		t.Fatal("Load() should reject an invalid notifications socket mode")
	}
}

func TestNotificationsSocketGoRequiresAuth(t *testing.T) {
	if _, err := Load(func(key string) string {
		if key == "API_GO_NOTIFICATIONS_SOCKET_MODE" {
			return "go"
		}
		return ""
	}); err == nil {
		t.Fatal("Load() should require JWT/DATABASE_URL/REDIS_HOST in go mode")
	}
}

func TestNotificationsSocketRejectsInvalidLimits(t *testing.T) {
	if _, err := Load(func(key string) string {
		if key == "WS_CONNECT_RATE_LIMIT_PER_IP" {
			return "0"
		}
		return ""
	}); err == nil {
		t.Fatal("Load() should reject non-positive WS limits")
	}
}

package config

import (
	"strings"
	"testing"
)

func TestAccountDataModesDefaultToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AvatarUploadMode != AvatarUploadModeLegacy {
		t.Fatalf("avatar mode = %s", cfg.AvatarUploadMode)
	}
	if cfg.UserDataExportMode != UserDataExportModeLegacy {
		t.Fatalf("export mode = %s", cfg.UserDataExportMode)
	}
	for _, value := range []string{"", "legacy"} {
		cfg, err := Load(func(key string) string {
			switch key {
			case "API_GO_AVATAR_UPLOAD_MODE", "API_GO_USER_DATA_EXPORT_MODE":
				return value
			default:
				return ""
			}
		})
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if cfg.AvatarUploadMode != AvatarUploadModeLegacy || cfg.UserDataExportMode != UserDataExportModeLegacy {
			t.Fatalf("%q: modes = %s/%s", value, cfg.AvatarUploadMode, cfg.UserDataExportMode)
		}
	}
}

func TestAccountDataModesRejectInvalid(t *testing.T) {
	cases := map[string]string{
		"API_GO_AVATAR_UPLOAD_MODE":    "API_GO_AVATAR_UPLOAD_MODE must be one of legacy|go",
		"API_GO_USER_DATA_EXPORT_MODE": "API_GO_USER_DATA_EXPORT_MODE must be one of legacy|go",
	}
	for key, message := range cases {
		for _, invalid := range []string{"shadow", "canary", "Go", "GO "} {
			_, err := Load(func(name string) string {
				if name == key {
					return invalid
				}
				return ""
			})
			if err == nil || !strings.Contains(err.Error(), message) {
				t.Fatalf("%s=%q: %v", key, invalid, err)
			}
		}
	}
}

func TestAccountDataModeRequirements(t *testing.T) {
	// Avatar upload: JWT + MySQL + Redis, no Mongo.
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_AVATAR_UPLOAD_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_AVATAR_UPLOAD_MODE=go") {
		t.Fatalf("avatar missing redis: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_AVATAR_UPLOAD_MODE":
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
		t.Fatalf("avatar should not require Mongo: %v", err)
	}
	if cfg.AvatarUploadMode != AvatarUploadModeGo || cfg.UserDataExportMode != UserDataExportModeLegacy {
		t.Fatalf("modes = %s/%s", cfg.AvatarUploadMode, cfg.UserDataExportMode)
	}

	// Data export additionally needs Mongo.
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_USER_DATA_EXPORT_MODE":
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
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_USER_DATA_EXPORT_MODE=go") {
		t.Fatalf("export missing mongo: %v", err)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_USER_DATA_EXPORT_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
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
		t.Fatalf("export requirements: %v", err)
	}
	if cfg.UserDataExportMode != UserDataExportModeGo || cfg.AvatarUploadMode != AvatarUploadModeLegacy {
		t.Fatalf("modes = %s/%s", cfg.AvatarUploadMode, cfg.UserDataExportMode)
	}
}

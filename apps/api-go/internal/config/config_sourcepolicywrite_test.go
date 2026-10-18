package config

import (
	"strings"
	"testing"
)

func TestGraphQLSourcePolicyWriteModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLSourcePolicyWriteMode != "legacy" {
		t.Fatalf("mode = %q", cfg.GraphQLSourcePolicyWriteMode)
	}
}

func TestGraphQLSourcePolicyWriteModeAcceptsGoWithoutMongo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLSourcePolicyWriteMode != "go" {
		t.Fatalf("mode = %q", cfg.GraphQLSourcePolicyWriteMode)
	}
	if cfg.MongoURI != "" {
		t.Fatalf("MongoURI = %q", cfg.MongoURI)
	}
	if cfg.GraphQLReadMode != "legacy" || cfg.GraphQLSettingsWriteMode != "legacy" {
		t.Fatalf("read=%q settingsWrite=%q", cfg.GraphQLReadMode, cfg.GraphQLSettingsWriteMode)
	}
}

func TestGraphQLSourcePolicyWriteModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE" {
			return "on"
		}
		return ""
	})
	if err == nil {
		t.Fatal("invalid value was accepted")
	}
	if !strings.Contains(err.Error(), "API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE") {
		t.Fatalf("error does not name the variable: %v", err)
	}
}

func TestGraphQLSourcePolicyWriteModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil {
		t.Fatal("go without credentials was accepted")
	}
	for _, name := range []string{"JWT_SECRET", "DATABASE_URL", "REDIS_HOST"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error does not name %s: %v", name, err)
		}
	}
}

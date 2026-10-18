package config

import (
	"strings"
	"testing"
)

func TestGraphQLWorkspaceWriteModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLWorkspaceWriteMode != "legacy" || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("write=%q read=%q", cfg.GraphQLWorkspaceWriteMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLWorkspaceWriteModeAcceptsExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLWorkspaceWriteMode != "legacy" {
		t.Fatalf("explicit legacy = %q", legacy.GraphQLWorkspaceWriteMode)
	}

	goMode, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE":
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
	if goMode.GraphQLWorkspaceWriteMode != "go" {
		t.Fatalf("go = %q", goMode.GraphQLWorkspaceWriteMode)
	}
	// The write takeover needs no Mongo: only the read switch requires MONGO_URI.
	if goMode.MongoURI != "" {
		t.Fatalf("MongoURI = %q", goMode.MongoURI)
	}
	if goMode.GraphQLReadMode != "legacy" || goMode.GraphQLWorkspaceReadMode != "legacy" {
		t.Fatalf("read=%q workspaceRead=%q", goMode.GraphQLReadMode, goMode.GraphQLWorkspaceReadMode)
	}
}

func TestGraphQLWorkspaceWriteModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE" {
			return "on"
		}
		return ""
	})
	if err == nil {
		t.Fatal("invalid value was accepted")
	}
	if !strings.Contains(err.Error(), "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE") {
		t.Fatalf("error does not name the variable: %v", err)
	}
}

func TestGraphQLWorkspaceWriteModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_WRITE_MODE" {
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

package config

import (
	"strings"
	"testing"
)

func TestGraphQLOrgAccessWriteModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.GraphQLOrgAccessWriteMode != "go" || cfg.GraphQLReadMode != "go" {
		t.Fatalf("write=%q read=%q", cfg.GraphQLOrgAccessWriteMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLOrgAccessWriteModeAcceptsExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE" {
			return "legacy"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLOrgAccessWriteMode != "legacy" {
		t.Fatalf("explicit legacy = %q", legacy.GraphQLOrgAccessWriteMode)
	}

	goMode, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if goMode.GraphQLOrgAccessWriteMode != "go" {
		t.Fatalf("go = %q", goMode.GraphQLOrgAccessWriteMode)
	}
	// The write takeover needs no Mongo: only the read switch requires MONGO_URI.
	if goMode.MongoURI != "" {
		t.Fatalf("MongoURI = %q", goMode.MongoURI)
	}
	if goMode.GraphQLReadMode != "legacy" {
		t.Fatalf("read mode = %q", goMode.GraphQLReadMode)
	}
}

func TestGraphQLOrgAccessWriteModeRejectsInvalid(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE" {
			return "shadow"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLOrgAccessWriteModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("Load() accepted go without credentials")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=go",
		"DATABASE_URL is required when API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=go",
		"REDIS_HOST is required when API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %v missing %q", err, want)
		}
	}
}

func TestGraphQLOrgAccessWriteModeGoDoesNotRequireMongo(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		}
		return ""
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

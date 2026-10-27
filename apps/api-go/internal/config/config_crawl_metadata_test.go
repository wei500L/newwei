package config

import (
	"strings"
	"testing"
)

// TestCrawlMetadataModeDefaultsToLegacy pins the default: an unset variable and
// the explicit "legacy" value both keep the POST on NestJS.
func TestCrawlMetadataModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.CrawlMetadataMode != CrawlMetadataModeGo {
		t.Fatalf("mode = %s", cfg.CrawlMetadataMode)
	}
	if cfg.GraphQLCrawlMetadataMode != "go" {
		t.Fatalf("graphql mode = %s", cfg.GraphQLCrawlMetadataMode)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CRAWL_METADATA_MODE":
			return "legacy"
		case "API_GO_GRAPHQL_CRAWL_METADATA_MODE":
			return "legacy"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlMetadataMode != CrawlMetadataModeLegacy || cfg.GraphQLCrawlMetadataMode != "legacy" {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestCrawlMetadataModeRejectsInvalid(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_CRAWL_METADATA_MODE" {
			return "shadow"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_METADATA_MODE must be one of legacy|go") {
		t.Fatalf("invalid http mode: %v", err)
	}
	_, err = Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_CRAWL_METADATA_MODE" {
			return "canary"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_CRAWL_METADATA_MODE must be one of legacy|go") {
		t.Fatalf("invalid graphql mode: %v", err)
	}
}

// TestCrawlMetadataModeRequiresCredentialsWithoutMongo pins the resource
// boundary: the HTTP entry needs JWT/MySQL/Redis and must not require Mongo, so
// it can run while every other crawl mode is legacy.
func TestCrawlMetadataModeRequiresCredentialsWithoutMongo(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CRAWL_METADATA_MODE":
			return "go"
		default:
			return ""
		}
	}))
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required when API_GO_CRAWL_METADATA_MODE=go") {
		t.Fatalf("missing credentials: %v", err)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_CRAWL_METADATA_MODE":
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
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlMetadataMode != CrawlMetadataModeGo {
		t.Fatalf("mode = %s", cfg.CrawlMetadataMode)
	}
	if cfg.MongoURI != "" {
		t.Fatal("the metadata HTTP mode must not require Mongo")
	}
}

// TestGraphQLCrawlMetadataModeRequiresReadPilot pins that the root cannot be
// registered without the parent read executor, and that it then inherits the
// parent Mongo requirement.
func TestGraphQLCrawlMetadataModeRequiresReadPilot(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_CRAWL_METADATA_MODE":
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
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_CRAWL_METADATA_MODE=go requires API_GO_GRAPHQL_READ_MODE=go") {
		t.Fatalf("missing read pilot: %v", err)
	}

	base := func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_READ_MODE", "API_GO_GRAPHQL_CRAWL_METADATA_MODE":
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
	}
	if _, err := Load(base); err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_GRAPHQL_READ_MODE=go") {
		t.Fatalf("mongo comes from the parent read pilot: %v", err)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		if key == "MONGO_URI" {
			return "mongodb://127.0.0.1:27017/app"
		}
		return base(key)
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLCrawlMetadataMode != "go" || cfg.CrawlMetadataMode != CrawlMetadataModeLegacy {
		t.Fatalf("cfg = %+v", cfg)
	}
}

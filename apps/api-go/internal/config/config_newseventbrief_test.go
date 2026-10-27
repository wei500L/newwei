package config

import (
	"strings"
	"testing"
)

func TestGraphQLNewsEventBriefModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.GraphQLNewsEventBriefMode != "go" {
		t.Fatalf("brief mode = %q", cfg.GraphQLNewsEventBriefMode)
	}
	if cfg.GraphQLReadMode != "go" || cfg.GraphQLNewsEventsMode != "go" {
		t.Fatalf("read=%q newsEvents=%q", cfg.GraphQLReadMode, cfg.GraphQLNewsEventsMode)
	}
}

func TestGraphQLNewsEventBriefModeRejectsInvalid(t *testing.T) {
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE" {
			return "yes"
		}
		return ""
	})); err == nil {
		t.Fatal("Load() must reject an invalid brief mode")
	}
}

func TestGraphQLNewsEventBriefModeRequiresParentSwitches(t *testing.T) {
	// brief=go alone must not silently enable its parents.
	if _, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE" {
			return "go"
		}
		return ""
	})); err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go requires") {
		t.Fatalf("err = %v", err)
	}

	// read=go but news-events still legacy is also a dependency error.
	if _, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE":
			return "go"
		case "API_GO_GRAPHQL_READ_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		case "MONGO_URI":
			return "mongodb://localhost:27017/modular"
		}
		return ""
	})); err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go requires") {
		t.Fatalf("err = %v", err)
	}
}

func TestGraphQLNewsEventBriefModeGoWithParents(t *testing.T) {
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE":
			return "go"
		case "API_GO_GRAPHQL_NEWS_EVENTS_MODE":
			return "go"
		case "API_GO_GRAPHQL_READ_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		case "MONGO_URI":
			return "mongodb://localhost:27017/modular"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLNewsEventBriefMode != "go" || cfg.GraphQLNewsEventsMode != "go" || cfg.GraphQLReadMode != "go" {
		t.Fatalf("brief=%q newsEvents=%q read=%q", cfg.GraphQLNewsEventBriefMode, cfg.GraphQLNewsEventsMode, cfg.GraphQLReadMode)
	}
}

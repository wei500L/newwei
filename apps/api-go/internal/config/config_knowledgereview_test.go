package config

import (
	"strings"
	"testing"
)

func TestGraphQLKnowledgeReviewModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLKnowledgeReviewMode != "legacy" {
		t.Fatalf("mode = %q", cfg.GraphQLKnowledgeReviewMode)
	}
}

func TestGraphQLKnowledgeReviewModeAcceptsExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLKnowledgeReviewMode != "legacy" {
		t.Fatalf("explicit legacy = %q", legacy.GraphQLKnowledgeReviewMode)
	}

	goMode, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE":
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
	if goMode.GraphQLKnowledgeReviewMode != "go" {
		t.Fatalf("go = %q", goMode.GraphQLKnowledgeReviewMode)
	}
	// The write takeover needs no Mongo and does not require any read switch.
	if goMode.MongoURI != "" {
		t.Fatalf("MongoURI = %q", goMode.MongoURI)
	}
	if goMode.GraphQLReadMode != "legacy" || goMode.GraphQLSettingsCrawlReadMode != "legacy" || goMode.GraphQLKnowledgeGraphMode != "legacy" {
		t.Fatalf("read=%q settingsCrawl=%q knowledgeGraph=%q",
			goMode.GraphQLReadMode, goMode.GraphQLSettingsCrawlReadMode, goMode.GraphQLKnowledgeGraphMode)
	}
}

func TestGraphQLKnowledgeReviewModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE" {
			return "on"
		}
		return ""
	})
	if err == nil {
		t.Fatal("invalid value was accepted")
	}
	if !strings.Contains(err.Error(), "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE") {
		t.Fatalf("error does not name the variable: %v", err)
	}
}

func TestGraphQLKnowledgeReviewModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE" {
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

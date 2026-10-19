package config

import (
	"strings"
	"testing"
)

func TestGraphQLAlertRulesModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLAlertRulesMode != "legacy" || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("alertRules=%q read=%q", cfg.GraphQLAlertRulesMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLAlertRulesModeAcceptsExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_ALERT_RULES_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLAlertRulesMode != "legacy" {
		t.Fatalf("explicit legacy = %q", legacy.GraphQLAlertRulesMode)
	}

	goMode, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_ALERT_RULES_MODE":
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
	if goMode.GraphQLAlertRulesMode != "go" {
		t.Fatalf("go = %q", goMode.GraphQLAlertRulesMode)
	}
	// The unit is independent of the read switch and needs no Mongo.
	if goMode.MongoURI != "" {
		t.Fatalf("MongoURI = %q", goMode.MongoURI)
	}
	if goMode.GraphQLReadMode != "legacy" || goMode.GraphQLWorkspaceWriteMode != "legacy" {
		t.Fatalf("read=%q workspaceWrite=%q", goMode.GraphQLReadMode, goMode.GraphQLWorkspaceWriteMode)
	}
}

func TestGraphQLAlertRulesModeWhitespaceIsTrimmed(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_ALERT_RULES_MODE":
			return "  go  "
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
	if cfg.GraphQLAlertRulesMode != "go" {
		t.Fatalf("trimmed = %q", cfg.GraphQLAlertRulesMode)
	}
}

func TestGraphQLAlertRulesModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_ALERT_RULES_MODE" {
			return "on"
		}
		return ""
	})
	if err == nil {
		t.Fatal("invalid value was accepted")
	}
	if !strings.Contains(err.Error(), "API_GO_GRAPHQL_ALERT_RULES_MODE") {
		t.Fatalf("error does not name the variable: %v", err)
	}
}

func TestGraphQLAlertRulesModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_ALERT_RULES_MODE" {
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

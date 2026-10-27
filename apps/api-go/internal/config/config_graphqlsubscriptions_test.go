package config

import (
	"strings"
	"testing"
)

func graphqlSubscriptionsEnv(overrides map[string]string) func(string) string {
	base := map[string]string{
		"JWT_SECRET":   "test-jwt-secret",
		"DATABASE_URL": "mysql://root:secret@localhost:3306/app",
		"REDIS_HOST":   "localhost",
	}
	return func(key string) string {
		if value, ok := overrides[key]; ok {
			return value
		}
		return base[key]
	}
}

func TestGraphQLSubscriptionsDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.GraphQLSubscriptionsMode != GraphQLSubscriptionsModeGo {
		t.Errorf("GraphQLSubscriptionsMode = %q, want go", cfg.GraphQLSubscriptionsMode)
	}
	if cfg.GraphQLSubscriptionBus != "redis" {
		t.Errorf("GraphQLSubscriptionBus = %q, want redis", cfg.GraphQLSubscriptionBus)
	}
}

func TestGraphQLSubscriptionsGoNeedsNoMongo(t *testing.T) {
	cfg, err := Load(graphqlSubscriptionsEnv(map[string]string{
		"API_GO_GRAPHQL_SUBSCRIPTIONS_MODE": "go",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.GraphQLSubscriptionsMode != GraphQLSubscriptionsModeGo {
		t.Errorf("GraphQLSubscriptionsMode = %q, want go", cfg.GraphQLSubscriptionsMode)
	}
}

func TestGraphQLSubscriptionsRejectsLocalBus(t *testing.T) {
	_, err := Load(graphqlSubscriptionsEnv(map[string]string{
		"API_GO_GRAPHQL_SUBSCRIPTIONS_MODE": "go",
		"GRAPHQL_SUBSCRIPTION_BUS":          "local",
	}))
	if err == nil || !strings.Contains(err.Error(), "requires GRAPHQL_SUBSCRIPTION_BUS=redis") {
		t.Fatalf("Load() error = %v, want go+local rejection", err)
	}
}

func TestGraphQLSubscriptionsLegacyAcceptsLocalBus(t *testing.T) {
	cfg, err := Load(graphqlSubscriptionsEnv(map[string]string{
		"API_GO_GRAPHQL_SUBSCRIPTIONS_MODE": "legacy",
		"GRAPHQL_SUBSCRIPTION_BUS":          "local",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.GraphQLSubscriptionBus != "local" {
		t.Errorf("GraphQLSubscriptionBus = %q, want local", cfg.GraphQLSubscriptionBus)
	}
}

func TestGraphQLSubscriptionsEmptyIsGo(t *testing.T) {
	cfg, err := Load(graphqlSubscriptionsEnv(map[string]string{
		"API_GO_GRAPHQL_SUBSCRIPTIONS_MODE": "",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.GraphQLSubscriptionsMode != GraphQLSubscriptionsModeGo {
		t.Errorf("GraphQLSubscriptionsMode = %q, want go", cfg.GraphQLSubscriptionsMode)
	}
}

func TestGraphQLSubscriptionsRejectsUnknownMode(t *testing.T) {
	_, err := Load(graphqlSubscriptionsEnv(map[string]string{
		"API_GO_GRAPHQL_SUBSCRIPTIONS_MODE": "shadow",
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_SUBSCRIPTIONS_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v, want mode rejection", err)
	}
}

func TestGraphQLSubscriptionsRejectsUnknownBus(t *testing.T) {
	_, err := Load(graphqlSubscriptionsEnv(map[string]string{
		"GRAPHQL_SUBSCRIPTION_BUS": "memory",
	}))
	if err == nil || !strings.Contains(err.Error(), "GRAPHQL_SUBSCRIPTION_BUS must be one of redis|local") {
		t.Fatalf("Load() error = %v, want bus rejection", err)
	}
}

func TestGraphQLSubscriptionsGoNeedsCredentials(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_SUBSCRIPTIONS_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("Load() should reject go without JWT/DATABASE_URL/REDIS_HOST")
	}
	for _, expected := range []string{
		"JWT_SECRET is required when API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go",
		"DATABASE_URL is required when API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go",
		"REDIS_HOST is required when API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go",
	} {
		if !strings.Contains(err.Error(), expected) {
			t.Errorf("Load() error = %v, want %q", err, expected)
		}
	}
}

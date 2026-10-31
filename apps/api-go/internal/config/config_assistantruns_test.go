package config

import (
	"strings"
	"testing"
)

func TestAssistantSwitchesDefaultToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.GraphQLAssistantWriteMode != "go" || cfg.AssistantWorkerMode != "go" {
		t.Fatalf("write=%q worker=%q", cfg.GraphQLAssistantWriteMode, cfg.AssistantWorkerMode)
	}
	if cfg.AssistantQueueConcurrency != 2 || cfg.AssistantMaxRetries != 3 ||
		cfg.AssistantLLMTimeoutMs != 300_000 || cfg.AssistantStreamFlushChars != 80 ||
		cfg.AssistantStreamFlushMs != 250 {
		t.Fatalf("assistant defaults = %+v", cfg)
	}
}

func TestAssistantSwitchesAcceptExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_ASSISTANT_WRITE_MODE", "API_GO_ASSISTANT_WORKER_MODE":
			return "legacy"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLAssistantWriteMode != "legacy" || legacy.AssistantWorkerMode != "legacy" {
		t.Fatalf("legacy = %q/%q", legacy.GraphQLAssistantWriteMode, legacy.AssistantWorkerMode)
	}

	goMode, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_ASSISTANT_WRITE_MODE", "API_GO_ASSISTANT_WORKER_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "127.0.0.1"
		case "MONGO_URI":
			return "mongodb://localhost:27017/app"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if goMode.GraphQLAssistantWriteMode != "go" || goMode.AssistantWorkerMode != "go" {
		t.Fatalf("go = %q/%q", goMode.GraphQLAssistantWriteMode, goMode.AssistantWorkerMode)
	}
}

func TestAssistantSwitchesRejectInvalid(t *testing.T) {
	for _, name := range []string{"API_GO_GRAPHQL_ASSISTANT_WRITE_MODE", "API_GO_ASSISTANT_WORKER_MODE"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == name {
				return "on"
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Fatalf("%s invalid value was accepted: %v", name, err)
		}
	}
}

func TestAssistantWriteModeRequiresCredentialsAndMongo(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_GRAPHQL_ASSISTANT_WRITE_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("go without credentials was accepted")
	}
	for _, name := range []string{"JWT_SECRET", "DATABASE_URL", "REDIS_HOST", "MONGO_URI"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error does not name %s: %v", name, err)
		}
	}
}

func TestAssistantWorkerModeRequiresDataStoresButNotJWT(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_ASSISTANT_WORKER_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("go without data stores was accepted")
	}
	for _, name := range []string{"DATABASE_URL", "REDIS_HOST", "MONGO_URI"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error does not name %s: %v", name, err)
		}
	}
	if strings.Contains(err.Error(), "JWT_SECRET") {
		t.Fatalf("worker mode must not require JWT_SECRET: %v", err)
	}
}

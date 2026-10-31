package config

import (
	"strings"
	"testing"
)

// TestKnowledgeGraphIngestionModeDefaultsToLegacy locks the cross-process
// switch contract: an unset value must keep the NestJS cron in charge.
func TestKnowledgeGraphIngestionModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.KnowledgeGraphIngestionMode != KnowledgeGraphIngestionModeGo {
		t.Fatalf("KnowledgeGraphIngestionMode = %q, want go", cfg.KnowledgeGraphIngestionMode)
	}
}

// TestKnowledgeGraphIngestionModeRejectsInvalidValue verifies only "",
// "legacy" and "go" are accepted.
func TestKnowledgeGraphIngestionModeRejectsInvalidValue(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE" {
			return "sometimes"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode error = %v", err)
	}
}

// TestKnowledgeGraphIngestionModeOnlyNeedsMySQLAndRedis verifies the chain can
// run while every HTTP switch and JWT_SECRET are absent. Mongo stays optional
// because the LLM request log is best effort.
func TestKnowledgeGraphIngestionModeOnlyNeedsMySQLAndRedis(t *testing.T) {
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE":
			return "go"
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
	if cfg.KnowledgeGraphIngestionMode != KnowledgeGraphIngestionModeGo {
		t.Fatalf("KnowledgeGraphIngestionMode = %q, want go", cfg.KnowledgeGraphIngestionMode)
	}
	if cfg.JWTSecret != "" {
		t.Fatalf("JWTSecret = %q, want empty", cfg.JWTSecret)
	}
}

// TestKnowledgeGraphIngestionModeRequiresMySQLAndRedis verifies go mode fails
// startup without its storage backends.
func TestKnowledgeGraphIngestionModeRequiresMySQLAndRedis(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("expected startup validation error")
	}
	message := err.Error()
	if !strings.Contains(message, "DATABASE_URL is required when API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go") {
		t.Fatalf("missing DATABASE_URL error: %v", err)
	}
	if !strings.Contains(message, "REDIS_HOST is required when API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go") {
		t.Fatalf("missing REDIS_HOST error: %v", err)
	}
}

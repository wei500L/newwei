package config

import "testing"

func envWith(overrides map[string]string) func(string) string {
	return func(key string) string {
		if value, ok := overrides[key]; ok {
			return value
		}
		return ""
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(envWith(map[string]string{
		"VECTOR_INTERNAL_TOKEN": "valid-token-1",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Port != 4010 {
		t.Errorf("Port = %d, want 4010", cfg.Port)
	}
	if cfg.QdrantURL != "http://localhost:6333" {
		t.Errorf("QdrantURL = %q, want default", cfg.QdrantURL)
	}
	if cfg.QdrantAPIKey != "" {
		t.Errorf("QdrantAPIKey = %q, want empty", cfg.QdrantAPIKey)
	}
	if cfg.CollectionPrefix != "processed_item_summary" {
		t.Errorf("CollectionPrefix = %q, want default", cfg.CollectionPrefix)
	}
	if cfg.QdrantTimeoutMs != 5000 {
		t.Errorf("QdrantTimeoutMs = %d, want 5000", cfg.QdrantTimeoutMs)
	}
	if cfg.NodeEnv != "development" {
		t.Errorf("NodeEnv = %q, want development", cfg.NodeEnv)
	}
}

func TestLoadRejectsShortToken(t *testing.T) {
	if _, err := Load(envWith(map[string]string{
		"VECTOR_INTERNAL_TOKEN": "short",
	})); err == nil {
		t.Fatal("Load() should reject a token shorter than 8 characters")
	}
}

func TestLoadRejectsDevTokenInProduction(t *testing.T) {
	if _, err := Load(envWith(map[string]string{
		"NODE_ENV":              "production",
		"VECTOR_INTERNAL_TOKEN": "dev-token",
	})); err == nil {
		t.Fatal("Load() should reject dev-token in production")
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	if _, err := Load(envWith(map[string]string{
		"VECTOR_INTERNAL_TOKEN": "valid-token-1",
		"PORT":                  "0",
	})); err == nil {
		t.Fatal("Load() should reject PORT=0")
	}
}

func TestLoadAcceptsExplicitConfig(t *testing.T) {
	cfg, err := Load(envWith(map[string]string{
		"NODE_ENV":                 "production",
		"PORT":                     "4011",
		"VECTOR_INTERNAL_TOKEN":    "prod-secret-token",
		"QDRANT_URL":               "http://qdrant:6333",
		"QDRANT_API_KEY":           "  key  ",
		"VECTOR_COLLECTION_PREFIX": "custom",
		"VECTOR_QDRANT_TIMEOUT_MS": "2500",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Port != 4011 || cfg.QdrantURL != "http://qdrant:6333" ||
		cfg.QdrantAPIKey != "key" || cfg.CollectionPrefix != "custom" || cfg.QdrantTimeoutMs != 2500 {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

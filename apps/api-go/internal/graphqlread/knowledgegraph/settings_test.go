package knowledgegraph

import "testing"

func TestBootstrapSettingsAreEnabled(t *testing.T) {
	fallback := fallbackSettings()
	if fallback.Enabled {
		t.Fatal("fallback must be disabled: a database error returns no reads")
	}
	bootstrap := bootstrapSettings()
	if !bootstrap.Enabled || !bootstrap.IngestionEnabled {
		t.Fatalf("bootstrap = %+v", bootstrap)
	}
	if bootstrap.CacheTTLSeconds != 60 {
		t.Fatalf("bootstrap cacheTtlSeconds = %d", bootstrap.CacheTTLSeconds)
	}
}

func TestNormalizeSettingsUsesFallbackAndClamps(t *testing.T) {
	fallback := fallbackSettings()
	out := normalizeSettings(nil, &fallback)
	if out.Enabled || out.CacheTTLSeconds != 60 {
		t.Fatalf("nil settings = %+v", out)
	}
	out = normalizeSettings(map[string]any{
		"enabled":         true,
		"cacheTtlSeconds": float64(9999),
		"maxBatchSize":    "12.4",
	}, &fallback)
	if !out.Enabled || out.CacheTTLSeconds != 3600 || out.MaxBatchSize != 12 {
		t.Fatalf("clamped settings = %+v", out)
	}
	out = normalizeSettings(map[string]any{"cacheTtlSeconds": float64(-1)}, &fallback)
	if out.CacheTTLSeconds != 0 {
		t.Fatalf("negative ttl = %d", out.CacheTTLSeconds)
	}
}

func TestClampIntArgMatchesJavaScriptRound(t *testing.T) {
	if got := clampIntArg(nil, 1, 180, 30); got != 30 {
		t.Fatalf("missing = %d", got)
	}
	if got := clampIntArg(float64(29.5), 1, 180, 30); got != 30 {
		t.Fatalf("29.5 = %d", got)
	}
	if got := clampIntArg(float64(-1), 1, 180, 30); got != 1 {
		t.Fatalf("negative = %d", got)
	}
	if got := clampIntArg(float64(500), 1, 180, 30); got != 180 {
		t.Fatalf("large = %d", got)
	}
}

func TestBuildSubgraphCacheKey(t *testing.T) {
	instrument := "instrument"
	key := buildSubgraphCacheKey("org1", " 600519.SH ", &instrument, 2, 200, []string{"supplies", "has_ticker"})
	want := "knowledgeGraph:subgraph:org1:seed=600519.sh:type=instrument:depth=2:max=200:rels=has_ticker,supplies"
	if key != want {
		t.Fatalf("key = %s, want %s", key, want)
	}
	anyKey := buildSubgraphCacheKey("org1", "Seed", nil, 1, 10, nil)
	anyWant := "knowledgeGraph:subgraph:org1:seed=seed:type=any:depth=1:max=10:rels=any"
	if anyKey != anyWant {
		t.Fatalf("any key = %s, want %s", anyKey, anyWant)
	}
	emptyRelation := buildSubgraphCacheKey("org1", "Seed", nil, 1, 10, []string{})
	emptyWant := "knowledgeGraph:subgraph:org1:seed=seed:type=any:depth=1:max=10:rels="
	if emptyRelation != emptyWant {
		t.Fatalf("empty relation key = %s, want %s", emptyRelation, emptyWant)
	}
}

func TestValidEntityAndRelationTypes(t *testing.T) {
	if value, ok := validEntityType(" Company "); !ok || value != "company" {
		t.Fatalf("company = %q %v", value, ok)
	}
	if _, ok := validEntityType("Person1"); ok {
		t.Fatal("Person1 must be ignored")
	}
	if value, ok := validRelationType("HAS_TICKER"); !ok || value != "has_ticker" {
		t.Fatalf("has_ticker = %q %v", value, ok)
	}
	if _, ok := validRelationType("unknown"); ok {
		t.Fatal("unknown relation must be ignored")
	}
}

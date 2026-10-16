package llmlogs

import (
	"reflect"
	"testing"
)

func TestDefaultMetadataPolicyMergesRequiredKeys(t *testing.T) {
	policy := defaultMetadataPolicySummary()
	if policy.Source != "default" {
		t.Fatalf("source=%q", policy.Source)
	}
	// DEFAULT 列表已含全部必选键，合并后长度不变。
	if len(policy.AllowedTopLevelKeys) != len(defaultMetadataAllowedTopLevelKeys) {
		t.Fatalf("keys=%d want %d", len(policy.AllowedTopLevelKeys), len(defaultMetadataAllowedTopLevelKeys))
	}
	if policy.AllowedTopLevelKeys[0] != "attempt" {
		t.Fatalf("first key=%q", policy.AllowedTopLevelKeys[0])
	}
	for _, required := range requiredMetadataAllowedTopLevelKeys {
		if !containsString(policy.AllowedTopLevelKeys, required) {
			t.Fatalf("missing required key %q", required)
		}
	}
	if policy.KeyCount != len(policy.AllowedTopLevelKeys) || policy.PrefixCount != 3 {
		t.Fatalf("counts=%d/%d", policy.KeyCount, policy.PrefixCount)
	}
	if !reflect.DeepEqual(policy.AllowedTopLevelPrefixes, []string{"x_", "meta_", "ctx_"}) {
		t.Fatalf("prefixes=%v", policy.AllowedTopLevelPrefixes)
	}
}

func TestMergeRequiredMetadataKeysAppendsMissing(t *testing.T) {
	merged := mergeRequiredMetadataKeys([]string{"custom", "runid", "custom"})
	want := []string{
		"custom", "runid",
		"nodeid", "profileid", "frontierrunid", "frontiernodeid", "crawlsiteprofileid",
	}
	if !reflect.DeepEqual(merged, want) {
		t.Fatalf("merged=%v", merged)
	}
}

func TestParseMetadataPolicyFromDBRow(t *testing.T) {
	raw := []byte(`{"retentionDays":30,"metadataAllowedTopLevelKeys":["custom","RUNID","bad key","custom"],"metadataAllowedTopLevelPrefixes":["zz_","zz_","X_"]}`)
	policy, ok := parseMetadataPolicy(raw)
	if !ok {
		t.Fatal("row should parse")
	}
	if policy.Source != "db" {
		t.Fatalf("source=%q", policy.Source)
	}
	wantKeys := []string{
		"custom", "runid",
		"nodeid", "profileid", "frontierrunid", "frontiernodeid", "crawlsiteprofileid",
	}
	if !reflect.DeepEqual(policy.AllowedTopLevelKeys, wantKeys) {
		t.Fatalf("keys=%v", policy.AllowedTopLevelKeys)
	}
	// 前缀同样小写去重。
	if !reflect.DeepEqual(policy.AllowedTopLevelPrefixes, []string{"zz_", "x_"}) {
		t.Fatalf("prefixes=%v", policy.AllowedTopLevelPrefixes)
	}
	if policy.KeyCount != len(wantKeys) || policy.PrefixCount != 2 {
		t.Fatalf("counts=%d/%d", policy.KeyCount, policy.PrefixCount)
	}
}

func TestParseMetadataPolicyFallsBackToDefaults(t *testing.T) {
	// 非法 JSON 与空值 → 解析失败，调用方落回 default。
	for _, raw := range [][]byte{nil, {}, []byte("not json"), []byte("{")} {
		if _, ok := parseMetadataPolicy(raw); ok {
			t.Fatalf("raw %q should not parse", raw)
		}
	}
	// 合法 JSON 但不是对象：source 仍是 db，两个列表落回默认（合并必选键）。
	policy, ok := parseMetadataPolicy([]byte("null"))
	if !ok {
		t.Fatal("null should parse")
	}
	if policy.Source != "db" || len(policy.AllowedTopLevelKeys) != len(defaultMetadataAllowedTopLevelKeys) {
		t.Fatalf("policy=%+v", policy)
	}
	// 字段类型不对（不是数组）→ 落回默认。
	policy, ok = parseMetadataPolicy([]byte(`{"metadataAllowedTopLevelKeys":"nope"}`))
	if !ok {
		t.Fatal("wrong type should still parse")
	}
	if len(policy.AllowedTopLevelKeys) != len(defaultMetadataAllowedTopLevelKeys) || policy.PrefixCount != 3 {
		t.Fatalf("policy=%+v", policy)
	}
}

func TestNormalizeMetadataTokenListKeepsFirstOccurrenceOrder(t *testing.T) {
	got := normalizeMetadataTokenList([]any{"b", "a", "b"}, 10, 64, false)
	if !reflect.DeepEqual(got, []string{"b", "a"}) {
		t.Fatalf("got %v", got)
	}
	// 超过上限时截断（lenient 分支不去重，与 TS 一致）。
	got = normalizeMetadataTokenList([]any{"a", "a", "c"}, 2, 64, false)
	if !reflect.DeepEqual(got, []string{"a", "a"}) {
		t.Fatalf("truncated got %v", got)
	}
	// strict 且长度不符 → nil。
	if got := normalizeMetadataTokenList([]any{"a", "bad key"}, 10, 64, true); got != nil {
		t.Fatalf("strict got %v", got)
	}
	// 非数组 → nil（strict 与 lenient 都是）。
	if got := normalizeMetadataTokenList("nope", 10, 64, false); got != nil {
		t.Fatalf("non-array got %v", got)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

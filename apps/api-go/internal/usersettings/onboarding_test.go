// user-settings 包最小单元测试：只覆盖核心风险（契约 normalization +
// shadow 身份边界），不追求测试数量增长。Go-批2B 起本文件同时承载三个
// 端点的契约测试（批指令限制：不新建测试文件，只扩展现有文件）。
//
// 1. onboarding 契约（批2A）：无记录 → settings:null；正常记录 →
//    normalization 与 updatedAt 正确；代表性异常对象 → 严格布尔、未知
//    key 丢弃、全 checklist 推导 completed。
// 2. RSS Reader 契约（批2B）：一个代表性合法/异常组合（trim/截断/去空/
//    稳定去重/类型过滤/严格布尔/provider/targetLanguage trim）。
// 3. Spacetime Timeline 契约（批2B）：默认值 + clamp 组合（浮点不取整）。
// 4. shadow 身份边界：legacy 200 + 合法形态 Bearer payload → 执行一次；
//    legacy 非 200 → 零执行；缺失/损坏 token → 零执行；PUT → 零执行
//    （cmd/api/main_test.go 的 dispatcher 表格测试覆盖三端点）。
package usersettings

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// assertJSONEqual 语义比较（key 顺序无关）——与 shadow runner 的 jsonEqual
// 同一口径。
func assertJSONEqual(t *testing.T, name, actual, expected string) {
	t.Helper()
	var a, b any
	if err := json.Unmarshal([]byte(actual), &a); err != nil {
		t.Fatalf("%s: actual is not JSON: %v\n%s", name, err, actual)
	}
	if err := json.Unmarshal([]byte(expected), &b); err != nil {
		t.Fatalf("%s: expected is not JSON: %v", name, err)
	}
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	if string(aj) != string(bj) {
		t.Errorf("%s mismatch:\n got: %s\nwant: %s", name, aj, bj)
	}
}

func TestOnboardingContract(t *testing.T) {
	// 无记录：settings 必须是 null，不能返回默认对象；updatedAt 为空对象。
	t.Run("no record yields settings null", func(t *testing.T) {
		response := BuildOnboardingResponse(Record{Found: false})
		body, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "no-record",
			string(body),
			`{"version":1,"updatedAt":{},"settings":null}`)
	})

	// 正常记录：normalization + updatedAt 毫秒 UTC（toISOString 等价）。
	t.Run("normal record", func(t *testing.T) {
		record := Record{
			Found:     true,
			Value:     []byte(`{"completed":false,"dismissed":true,"checklist":{"today":true},"completedTours":{"today":true}}`),
			UpdatedAt: time.Date(2026, 9, 3, 0, 0, 0, 123000000, time.UTC),
		}
		body, err := json.Marshal(BuildOnboardingResponse(record))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "normal-record",
			string(body),
			`{"version":1,"updatedAt":{"settings":"2026-09-03T00:00:00.123Z"},"settings":{"completed":false,"dismissed":true,"checklist":{"today":true,"events":false,"map":false,"finance":false},"completedTours":{"today":true}}}`)
	})

	// 代表性异常对象 A：严格布尔 + 未知 key 丢弃。字符串 "true"/数字 1
	// 都不是严格 true（checklist 与顶层布尔均按 false）；rogue/today2 丢弃。
	t.Run("malformed object strict booleans and unknown keys", func(t *testing.T) {
		settings := NormalizeOnboarding([]byte(`{
			"completed": "true",
			"dismissed": 1,
			"checklist": {"today": "true", "events": 1, "map": true, "finance": true, "rogue": true},
			"completedTours": {"today": "true", "today2": true, "map": true}
		}`))
		if settings.Completed {
			t.Error("completed = true, want false（存储值非严格 true 且 checklist 未全 true）")
		}
		if settings.Dismissed {
			t.Error("dismissed = true, want false（数字 1 非严格 true）")
		}
		if settings.Checklist.Today {
			t.Error("checklist.today = true, want false（字符串 \"true\" 非严格 true）")
		}
		if settings.Checklist.Events {
			t.Error("checklist.events = true, want false（数字 1 非严格 true）")
		}
		if !settings.Checklist.Map || !settings.Checklist.Finance {
			t.Error("checklist.map/finance must be true（严格 true 原样保留）")
		}
		if len(settings.CompletedTours) != 1 || !settings.CompletedTours["map"] {
			t.Errorf("completedTours = %v, want only {map:true}（严格 true，未知 key/非严格值丢弃）", settings.CompletedTours)
		}
	})

	// 代表性异常对象 B：四个 checklist 全严格 true → 推导 completed=true
	//（即使存储 completed 非严格 true）；dismissed 非严格 true 仍为 false。
	t.Run("all checklist strictly true derives completed", func(t *testing.T) {
		settings := NormalizeOnboarding([]byte(`{
			"completed": "yes",
			"dismissed": "true",
			"checklist": {"today": true, "events": true, "map": true, "finance": true},
			"completedTours": {"extra": 1}
		}`))
		if !settings.Completed {
			t.Error("completed = false, want true（四步 checklist 全严格 true 推导）")
		}
		if settings.Dismissed {
			t.Error("dismissed = true, want false（字符串 \"true\" 非严格 true）")
		}
		if len(settings.CompletedTours) != 0 {
			t.Errorf("completedTours = %v, want 空（非布尔值丢弃）", settings.CompletedTours)
		}
	})

	// value 不是 JSON 对象（数据库有记录但 value 异常）→ 返回默认设置对象
	// （不是 null）。
	t.Run("non-object value yields default settings", func(t *testing.T) {
		for name, raw := range map[string]string{
			"array":   `[1,2]`,
			"string":  `"hello"`,
			"invalid": `not-json`,
		} {
			record := Record{Found: true, Value: []byte(raw), UpdatedAt: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)}
			body, err := json.Marshal(BuildOnboardingResponse(record))
			if err != nil {
				t.Fatal(err)
			}
			assertJSONEqual(t, "non-object-"+name,
				string(body),
				`{"version":1,"updatedAt":{"settings":"2026-09-03T00:00:00.000Z"},"settings":{"completed":false,"dismissed":false,"checklist":{"today":false,"events":false,"map":false,"finance":false},"completedTours":{}}}`)
		}
	})
}

// Go-批2B：RSS Reader 契约——无记录 null、非对象默认值（含本端点特有的
// selectedSourceIds null 与 sourceLanguageFilters 空数组区分）、一个
// 代表性合法/异常组合。不逐字段造测试。
func TestRSSReaderContract(t *testing.T) {
	t.Run("no record yields settings null", func(t *testing.T) {
		body, err := json.Marshal(BuildRSSReaderResponse(Record{Found: false}))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "no-record",
			string(body),
			`{"version":1,"updatedAt":{},"settings":null}`)
	})

	// 非对象 value → 默认设置对象：selectedSourceIds 为 null（非数组语义），
	// sourceLanguageFilters 为空数组（非 null）。
	t.Run("non-object value yields default settings", func(t *testing.T) {
		for name, raw := range map[string]string{
			"array":   `[1,2]`,
			"string":  `"hello"`,
			"invalid": `not-json`,
		} {
			record := Record{Found: true, Value: []byte(raw), UpdatedAt: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)}
			body, err := json.Marshal(BuildRSSReaderResponse(record))
			if err != nil {
				t.Fatal(err)
			}
			assertJSONEqual(t, "non-object-"+name,
				string(body),
				`{"version":1,"updatedAt":{"settings":"2026-09-03T00:00:00.000Z"},"settings":{"selectedSourceIds":null,"sourceLanguageFilters":[],"translationEnabled":false,"translationProvider":"deeplx","targetLanguage":"zh-CN","showOriginalContent":false}}`)
		}
	})

	// 代表性合法/异常组合：trim、128 截断、去空、稳定去重（保留首现顺序）、
	// 非字符串类型过滤、严格布尔（数字 1 非 true）、provider 保留 "llm"、
	// targetLanguage trim。
	t.Run("mixed valid and malformed fields", func(t *testing.T) {
		longID := strings.Repeat("a", 130) // 超过 128 rune 截断上限
		raw := `{"selectedSourceIds":["  src-1 ","src-2","src-1",42,"  ","` + longID + `"],` +
			`"sourceLanguageFilters":[" zh ","ZH","en",7,""],` +
			`"translationEnabled":1,"translationProvider":"llm",` +
			`"targetLanguage":"  en-US  ","showOriginalContent":true}`
		settings := NormalizeRSSReader([]byte(raw))

		wantIDs := []string{"src-1", "src-2", longID[:128]}
		if len(settings.SelectedSourceIDs) != len(wantIDs) {
			t.Fatalf("selectedSourceIds = %v, want %v", settings.SelectedSourceIDs, wantIDs)
		}
		for i, want := range wantIDs {
			if settings.SelectedSourceIDs[i] != want {
				t.Errorf("selectedSourceIds[%d] = %q, want %q（trim/去重/类型过滤/128 截断）", i, settings.SelectedSourceIDs[i], want)
			}
		}
		wantFilters := []string{"ZH", "EN"}
		if len(settings.SourceLanguageFilters) != len(wantFilters) {
			t.Fatalf("sourceLanguageFilters = %v, want %v", settings.SourceLanguageFilters, wantFilters)
		}
		for i, want := range wantFilters {
			if settings.SourceLanguageFilters[i] != want {
				t.Errorf("sourceLanguageFilters[%d] = %q, want %q（trim+uppercase/去重/类型过滤）", i, settings.SourceLanguageFilters[i], want)
			}
		}
		if settings.TranslationEnabled {
			t.Error("translationEnabled = true, want false（数字 1 非严格 true）")
		}
		if settings.TranslationProvider != "llm" {
			t.Errorf("translationProvider = %q, want llm", settings.TranslationProvider)
		}
		if settings.TargetLanguage != "en-US" {
			t.Errorf("targetLanguage = %q, want en-US（trim）", settings.TargetLanguage)
		}
		if !settings.ShowOriginalContent {
			t.Error("showOriginalContent = false, want true（严格 true 原样保留）")
		}
	})
}

// Go-批2B：Spacetime Timeline 契约——无记录 null、非对象全默认、
// clamp + 类型回退组合、浮点不取整。不逐字段造测试。
func TestSpacetimeTimelineContract(t *testing.T) {
	t.Run("no record yields settings null", func(t *testing.T) {
		body, err := json.Marshal(BuildSpacetimeTimelineResponse(Record{Found: false}))
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "no-record",
			string(body),
			`{"version":1,"updatedAt":{},"settings":null}`)
	})

	// 非对象 value → 全默认（NestJS SPACETIME_TIMELINE_DEFAULT_SETTINGS）。
	t.Run("non-object value yields defaults", func(t *testing.T) {
		for name, raw := range map[string]string{
			"array":   `[1]`,
			"scalar":  `42`,
			"invalid": `not-json`,
		} {
			record := Record{Found: true, Value: []byte(raw), UpdatedAt: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)}
			body, err := json.Marshal(BuildSpacetimeTimelineResponse(record))
			if err != nil {
				t.Fatal(err)
			}
			assertJSONEqual(t, "non-object-"+name,
				string(body),
				`{"version":1,"updatedAt":{"settings":"2026-09-03T00:00:00.000Z"},"settings":{"authoritativeLock":true,"requireCorroborated":true,"sourceType":"authoritative","sortBy":"heat","minHeatScore":0.7,"minCredibilityScore":48,"timelineGranularity":"auto","speed":2,"syncStatusAutoRefresh":true}}`)
		}
	})

	// clamp + 类型回退组合：双向 clamp（-5→0、150→100、0.1→0.25）、合法
	// 枚举保留（blog/week）、非法枚举回退（bogus→heat）、布尔回退（非布尔
	// → 各自默认 true）、布尔 false 原样保留。
	t.Run("clamp and fallback combination", func(t *testing.T) {
		settings := NormalizeSpacetimeTimeline([]byte(`{
			"authoritativeLock": false,
			"requireCorroborated": "yes",
			"sourceType": "blog",
			"sortBy": "bogus",
			"minHeatScore": -5,
			"minCredibilityScore": 150,
			"timelineGranularity": "week",
			"speed": 0.1,
			"syncStatusAutoRefresh": 0
		}`))
		if settings.AuthoritativeLock {
			t.Error("authoritativeLock = true, want false（布尔 false 原样保留）")
		}
		if !settings.RequireCorroborated {
			t.Error("requireCorroborated = false, want true（非布尔回退默认）")
		}
		if settings.SourceType != "blog" {
			t.Errorf("sourceType = %q, want blog（合法枚举保留）", settings.SourceType)
		}
		if settings.SortBy != "heat" {
			t.Errorf("sortBy = %q, want heat（非法枚举回退默认）", settings.SortBy)
		}
		if settings.MinHeatScore != 0 {
			t.Errorf("minHeatScore = %v, want 0（-5 clamp 到下界）", settings.MinHeatScore)
		}
		if settings.MinCredibilityScore != 100 {
			t.Errorf("minCredibilityScore = %v, want 100（150 clamp 到上界）", settings.MinCredibilityScore)
		}
		if settings.TimelineGranularity != "week" {
			t.Errorf("timelineGranularity = %q, want week（合法枚举保留）", settings.TimelineGranularity)
		}
		if settings.Speed != 0.25 {
			t.Errorf("speed = %v, want 0.25（0.1 clamp 到下界）", settings.Speed)
		}
		if !settings.SyncStatusAutoRefresh {
			t.Error("syncStatusAutoRefresh = false, want true（数字 0 回退默认）")
		}
	})

	// 浮点不取整：合法范围内的浮点值与序列化均原样保留（与 JS
	// JSON.stringify 同为最短 round-trip 表示）。
	t.Run("floats are preserved without rounding", func(t *testing.T) {
		settings := NormalizeSpacetimeTimeline([]byte(`{"minHeatScore":3.75,"minCredibilityScore":48.5,"speed":1.5}`))
		if settings.MinHeatScore != 3.75 || settings.MinCredibilityScore != 48.5 || settings.Speed != 1.5 {
			t.Errorf("floats rounded or altered: %+v（want 3.75/48.5/1.5 原样）", settings)
		}
		body, err := json.Marshal(settings)
		if err != nil {
			t.Fatal(err)
		}
		assertJSONEqual(t, "float-serialization",
			string(body),
			`{"authoritativeLock":true,"requireCorroborated":true,"sourceType":"authoritative","sortBy":"heat","minHeatScore":3.75,"minCredibilityScore":48.5,"timelineGranularity":"auto","speed":1.5,"syncStatusAutoRefresh":true}`)
	})
}

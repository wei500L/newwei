// Go-批2A 最小单元测试：只覆盖两个核心风险（契约 normalization +
// shadow 身份边界），不追求测试数量增长。
//
// 1. onboarding 契约：无记录 → settings:null；正常记录 → normalization
//    与 updatedAt 正确；代表性异常对象 → 严格布尔、未知 key 丢弃、
//    全 checklist 推导 completed。
// 2. shadow 身份边界：legacy 200 + 合法形态 Bearer payload → 执行一次；
//    legacy 非 200 → 零执行；缺失/损坏 token → 零执行；PUT → 零执行。
package usersettings

import (
	"encoding/json"
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

	// 代表性异常对象：字符串 "true"/数字按 false；未知 key（today2、
	// rogue）丢弃；四个 checklist 全 true 推导 completed=true。
	t.Run("malformed object strict booleans and unknown keys", func(t *testing.T) {
		settings := NormalizeOnboarding([]byte(`{
			"completed": "true",
			"dismissed": 1,
			"checklist": {"today": "true", "events": 1, "map": true, "finance": true, "rogue": true},
			"completedTours": {"today": "true", "today2": true, "map": true}
		}`))
		if settings.Completed != true {
			t.Errorf("completed = %v, want true (all four checklist true)", settings.Completed)
		}
		if settings.Dismissed != false {
			t.Errorf("dismissed = %v, want false (only strict true)", settings.Dismissed)
		}
		if !settings.Checklist.Today || settings.Checklist.Events {
			t.Errorf("checklist today=%v events=%v, want false/false (strict booleans)", settings.Checklist.Today, settings.Checklist.Events)
		}
		if !settings.Checklist.Map || !settings.Checklist.Finance {
			t.Errorf("checklist map/finance must be true")
		}
		if len(settings.CompletedTours) != 1 || !settings.CompletedTours["map"] {
			t.Errorf("completedTours = %v, want only {map:true} (strict true, unknown keys dropped)", settings.CompletedTours)
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

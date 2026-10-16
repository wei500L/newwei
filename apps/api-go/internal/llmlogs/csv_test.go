package llmlogs

import (
	"strings"
	"testing"
	"time"
)

func TestEscapeCSVValueFormulaInjection(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  string
	}{
		// 公式注入防护：非纯数字的 =、+、-、@ 起始串加前导单引号。
		{"equals with comma", "=SUM(1,2)", `"'=SUM(1,2)"`},
		{"equals simple", "=1+2", "'=1+2"},
		{"calc payload", "=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"},
		{"negative number string", "-12.5", "-12.5"},
		{"two digit decimal", "-0.5", "-0.5"},
		{"negative command", "-cmd", "'-cmd"},
		{"plus command", "+cmd", "'+cmd"},
		{"plus number", "+1", "'+1"},
		{"at command", "@cmd", "'@cmd"},
		{"leading whitespace then formula", "  =x", "'  =x"},
		{"leading tab then formula", "\t-x", "'\t-x"},
		// 纯数字（含小数、负数）不加单引号。
		{"integer string", "42", "42"},
		{"decimal string", "42.75", "42.75"},
		// 数字类型不带公式前缀（JS 只在 typeof value === "string" 时判断）。
		{"negative float", -3.5, "-3.5"},
		{"integer", 7.0, "7"},
		{"zero", 0.0, "0"},
		// 普通字符串。
		{"plain", "gpt-4o", "gpt-4o"},
		{"blank", "", ""},
		{"whitespace only", "   ", "   "},
		// 双引号/逗号/换行转义。
		{"quote and comma", `say "hi", ok`, `"say ""hi"", ok"`},
		{"newline", "line\nbreak", "\"line\nbreak\""},
		{"carriage return", "a\rb", "\"a\rb\""},
		// null/undefined → 空串。
		{"nil", nil, ""},
	}
	for _, tc := range cases {
		if got := escapeCSVValue(tc.value); got != tc.want {
			t.Fatalf("%s: escapeCSVValue(%#v) = %q, want %q", tc.name, tc.value, got, tc.want)
		}
	}
}

func TestEscapeCSVValueTerminates(t *testing.T) {
	// 递归路径必须在一次前缀后收敛：已经带前导单引号的串不再加第二个。
	cases := map[string]string{
		"=x":    "'=x",
		"'=x":   "'=x",
		"'-cmd": "'-cmd",
	}
	for value, want := range cases {
		if got := escapeCSVValue(value); got != want {
			t.Fatalf("escapeCSVValue(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestJSNumberString(t *testing.T) {
	cases := map[float64]string{
		0:         "0",
		7:         "7",
		-3:        "-3",
		12.5:      "12.5",
		0.000001:  "0.000001",
		1e-7:      "1e-7",
		1e21:      "1e+21",
		123456789: "123456789",
	}
	for value, want := range cases {
		if got := jsNumberString(value); got != want {
			t.Fatalf("jsNumberString(%v) = %q, want %q", value, got, want)
		}
	}
}

func TestFormatISOUsesMillisecondUTC(t *testing.T) {
	if got := formatISO(nil); got != "1970-01-01T00:00:00.000Z" {
		t.Fatalf("nil got %q", got)
	}
	value := time.Date(2026, 10, 16, 12, 34, 56, 789000000, time.UTC)
	if got := formatISO(&value); got != "2026-10-16T12:34:56.789Z" {
		t.Fatalf("got %q", got)
	}
	east := time.FixedZone("east", 8*60*60)
	local := time.Date(2026, 10, 16, 20, 34, 56, 0, east)
	if got := formatISO(&local); got != "2026-10-16T12:34:56.000Z" {
		t.Fatalf("offset got %q", got)
	}
}

func TestToExportCSVLineMatchesServiceShape(t *testing.T) {
	created := time.Date(2026, 10, 16, 1, 2, 3, 0, time.UTC)
	latency := 12.0
	row := exportRow{
		CreatedAt:        &created,
		Model:            "gpt-4o",
		RequestType:      "completion",
		Status:           "error",
		LatencyMs:        latency,
		PromptTokens:     float64(10),
		CompletionTokens: nil,
		TotalTokens:      float64(10),
		Error:            "=cmd|' /C calc'!A0",
	}
	want := "2026-10-16T01:02:03.000Z,gpt-4o,completion,error,12,10,,10,'=cmd|' /C calc'!A0"
	if got := toExportCSVLine(row); got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}

	// model 为空 → unknown；createdAt 缺失 → 纪元；latencyMs 缺失 → 0。
	blank := exportRow{}
	if got := toExportCSVLine(blank); got != "1970-01-01T00:00:00.000Z,unknown,,,0,,,," {
		t.Fatalf("blank got %q", got)
	}

	// 负 latency 收敛到 0（Math.max(0, ...)）。
	negative := -9.5
	if got := toExportCSVLine(exportRow{LatencyMs: negative}); !strings.Contains(got, ",0,,") {
		t.Fatalf("negative latency got %q", got)
	}
}

func TestExportCSVHeaderLine(t *testing.T) {
	want := "timestamp,model,requestType,status,durationMs,inputTokens,outputTokens,totalTokens,error\n"
	if got := exportCSVHeaderLine(); got != want {
		t.Fatalf("got %q", got)
	}
}

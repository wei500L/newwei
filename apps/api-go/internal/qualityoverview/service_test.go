package qualityoverview

import (
	"testing"
	"time"
)

func TestClampWindowMatchesNestNormalization(t *testing.T) {
	cases := []struct {
		value    float64
		min, max int
		want     int
	}{
		{24, 1, 24 * 14, 24},
		{0, 1, 24 * 14, 1},
		{-5, 1, 24 * 14, 1},
		{12.9, 1, 24 * 14, 12},
		{1000, 1, 24 * 14, 336},
		{0, 5, 60 * 24 * 14, 5},
		{20160, 5, 60 * 24 * 14, 20160},
		{20161, 5, 60 * 24 * 14, 20160},
	}
	for _, tc := range cases {
		if got := clampWindow(tc.value, tc.min, tc.max); got != tc.want {
			t.Fatalf("clampWindow(%v, %d, %d) = %d, want %d", tc.value, tc.min, tc.max, got, tc.want)
		}
	}
}

func TestParseWindowOptionLenient(t *testing.T) {
	for _, raw := range []string{"", "abc", "NaN", "Infinity"} {
		if _, ok := parseWindowOption(raw); ok {
			t.Fatalf("parseWindowOption(%q) reported a value, want fallback", raw)
		}
	}
	if value, ok := parseWindowOption("12"); !ok || value != 12 {
		t.Fatalf("parseWindowOption(12) = %v %v", value, ok)
	}
	if value, ok := parseWindowOption("0"); !ok || value != 0 {
		t.Fatalf("parseWindowOption(0) = %v %v", value, ok)
	}
	// JS Number(" ") === 0，空格是有效（falsy-after-Number）输入 → 走 0。
	if value, ok := parseWindowOption(" "); !ok || value != 0 {
		t.Fatalf("parseWindowOption(space) = %v %v", value, ok)
	}
}

func TestParseListLimitLenient(t *testing.T) {
	cases := map[string]int{
		"":     50,
		"abc":  50,
		"NaN":  50,
		"0":    1,
		" ":    1,
		"-9":   1,
		"10":   10,
		"12.9": 12,
		"200":  200,
		"1000": 200,
	}
	for raw, want := range cases {
		if got := parseListLimit(raw); got != want {
			t.Fatalf("parseListLimit(%q) = %d, want %d", raw, got, want)
		}
	}
}

func TestParseSinceMinutesLenient(t *testing.T) {
	cases := []struct {
		raw        string
		wantValue  int
		wantActive bool
	}{
		{"", 0, false},
		{"abc", 0, false},
		{"NaN", 0, false},
		{"0", 0, false},
		{" ", 0, false},
		{"-3", -3, false},
		{"1.9", 1, true},
		{"60", 60, true},
	}
	for _, tc := range cases {
		value, active := parseSinceMinutes(tc.raw)
		if value != tc.wantValue || active != tc.wantActive {
			t.Fatalf("parseSinceMinutes(%q) = %d %v, want %d %v", tc.raw, value, active, tc.wantValue, tc.wantActive)
		}
	}
}

func TestNormalizeTaskLogStatusLenient(t *testing.T) {
	if got := normalizeTaskLogStatus(" failed "); got != "failed" {
		t.Fatalf("normalizeTaskLogStatus(failed) = %q", got)
	}
	for _, raw := range []string{"", "bad", "FAILED", "pendingx"} {
		if got := normalizeTaskLogStatus(raw); got != "" {
			t.Fatalf("normalizeTaskLogStatus(%q) = %q, want empty", raw, got)
		}
	}
}

func TestSnapshotKeysMatchAdminLogsService(t *testing.T) {
	if got := snapshotKey("org1", scopeQualityNewsSources, "windowHours:12"); got != "observability-snapshot:org1:quality_news_sources:windowHours:12" {
		t.Fatalf("snapshotKey = %q", got)
	}
	if got := lockKeyFor("observability-snapshot:org1:quality_pipeline:windowMinutes:60"); got != "lock:observability-snapshot:org1:quality_pipeline:windowMinutes:60" {
		t.Fatalf("lockKeyFor = %q", got)
	}
}

func TestFormatJSTimeMillisUTC(t *testing.T) {
	value := time.Date(2026, 10, 17, 9, 9, 40, 0, time.UTC)
	if got := formatJSTime(value); got != "2026-10-17T09:09:40.000Z" {
		t.Fatalf("formatJSTime = %q", got)
	}
}

func TestPercentileMatchesNestIndex(t *testing.T) {
	values := []int64{0, 10, 20, 30, 40, 50, 60, 70, 80, 90}
	if got := percentile(values, 0.5); got == nil || *got != 40 {
		t.Fatalf("p50 = %v", got)
	}
	if got := percentile(values, 0.9); got == nil || *got != 80 {
		t.Fatalf("p90 = %v", got)
	}
	if got := percentile(values, 0.99); got == nil || *got != 80 {
		t.Fatalf("p99 = %v", got)
	}
	if got := percentile(nil, 0.5); got != nil {
		t.Fatalf("empty percentile = %v", got)
	}
}

func TestRoundFiniteScale(t *testing.T) {
	a := 1.23456
	if got := roundFinite(&a, 3); got == nil || *got != 1.235 {
		t.Fatalf("roundFinite(1.23456, 3) = %v", got)
	}
	b := 12.6
	if got := roundFinite(&b, 0); got == nil || *got != 13 {
		t.Fatalf("roundFinite(12.6, 0) = %v", got)
	}
	if got := roundFinite(nil, 0); got != nil {
		t.Fatalf("roundFinite(nil) = %v", got)
	}
}

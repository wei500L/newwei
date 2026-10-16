package adminlogs

import (
	"errors"
	"testing"
	"time"
)

func inputMessage(t *testing.T, err error) string {
	t.Helper()
	var input *inputError
	if !errors.As(err, &input) {
		t.Fatalf("want *inputError, got %v", err)
	}
	return input.Message
}

// 两个控制器对错误参数的处理本来就不同——这里把两套规则都锁定。
func TestParseDateRules(t *testing.T) {
	if _, _, err := parseDateRange("2026-10-10T00:00:00Z", "2026-10-09T00:00:00Z"); err == nil {
		t.Fatal("start > end should be a 400")
	} else if got := inputMessage(t, err); got != "start must be earlier than or equal to end" {
		t.Fatalf("message = %q", got)
	}
	if _, err := parseDateQuery("start", "not-a-date"); err == nil {
		t.Fatal("invalid date should be a 400")
	} else if got := inputMessage(t, err); got != "start must be a valid date" {
		t.Fatalf("message = %q", got)
	}
	start, end, err := parseDateRange("2026-10-09T00:00:00Z", "  ")
	if err != nil || start == nil || end != nil {
		t.Fatalf("start=%v end=%v err=%v", start, end, err)
	}
	if !start.Equal(time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("start = %v", start)
	}
	// admin/errors 的宽松版：非法日期忽略该条件，不报错。
	if got := parseDateIgnoringError("not-a-date"); got != nil {
		t.Fatalf("lenient invalid date = %v", got)
	}
	if got := parseDateIgnoringError("  "); got != nil {
		t.Fatalf("lenient blank date = %v", got)
	}
}

func TestParsePositiveIntRules(t *testing.T) {
	if got, err := parsePositiveIntQuery("page", "", 1); err != nil || got != 1 {
		t.Fatalf("blank page = %d, %v", got, err)
	}
	if got, err := parsePositiveIntQuery("pageSize", "2.9", 20); err != nil || got != 2 {
		t.Fatalf("Math.trunc pageSize = %d, %v", got, err)
	}
	for _, raw := range []string{"abc", "0", "-1", "Infinity"} {
		_, err := parsePositiveIntQuery("page", raw, 1)
		if err == nil {
			t.Fatalf("%q should be a 400", raw)
		}
		if got := inputMessage(t, err); got != "page must be a positive number" {
			t.Fatalf("message = %q", got)
		}
	}
}

func TestKindRulesDifferBetweenControllers(t *testing.T) {
	// /api/admin/logs/errors：strict → 400。
	_, err := normalizeExceptionEventKind("bad")
	if err == nil {
		t.Fatal("logs/errors kind=bad should be a 400")
	}
	if got := inputMessage(t, err); got != "kind must be one of http, graphql, unknown" {
		t.Fatalf("message = %q", got)
	}
	if kind, err := normalizeExceptionEventKind(" graphql "); err != nil || kind != "graphql" {
		t.Fatalf("trimmed kind = %q, %v", kind, err)
	}
	if kind, err := normalizeExceptionEventKind(""); err != nil || kind != "" {
		t.Fatalf("blank kind = %q, %v", kind, err)
	}
	// /api/admin/errors：lenient → undefined，不报错（也不 trim）。
	if kind, ok := lenientExceptionEventKind("bad"); ok || kind != "" {
		t.Fatalf("lenient kind=bad = %q, %v", kind, ok)
	}
	if kind, ok := lenientExceptionEventKind(" graphql "); ok || kind != "" {
		t.Fatalf("lenient kind is not trimmed: %q, %v", kind, ok)
	}
	if kind, ok := lenientExceptionEventKind("unknown"); !ok || kind != "unknown" {
		t.Fatalf("lenient kind=unknown = %q, %v", kind, ok)
	}
}

func TestTaskLogStatusRules(t *testing.T) {
	if status, err := normalizeTaskLogStatus(" failed "); err != nil || status != "failed" {
		t.Fatalf("status = %q, %v", status, err)
	}
	if status, err := normalizeTaskLogStatus(""); err != nil || status != "" {
		t.Fatalf("blank status = %q, %v", status, err)
	}
	_, err := normalizeTaskLogStatus("queued")
	if err == nil {
		t.Fatal("status=queued should be a 400")
	}
	if got := inputMessage(t, err); got != "status must be one of pending, processing, completed, failed" {
		t.Fatalf("message = %q", got)
	}
}

func TestLimitOffsetRules(t *testing.T) {
	if _, present := parseLimit(""); present {
		t.Fatal("blank limit should be undefined")
	}
	if _, present := parseLimit("abc"); present {
		t.Fatal("non-numeric limit should be undefined")
	}
	if _, present := parseLimit("1e999"); present {
		t.Fatal("infinite limit should be undefined")
	}
	if value, present := parseLimit("0"); !present || value != 0 {
		t.Fatalf("limit=0 = %v, %v", value, present)
	}
	if got := clampLimit(0); got != 1 {
		t.Fatalf("clampLimit(0) = %d", got)
	}
	if got := clampLimit(-5); got != 1 {
		t.Fatalf("clampLimit(-5) = %d", got)
	}
	if got := clampLimit(500); got != 200 {
		t.Fatalf("clampLimit(500) = %d", got)
	}
	if got := clampOffset(-3); got != 0 {
		t.Fatalf("clampOffset(-3) = %d", got)
	}
	if got := clampOffset(2.7); got != 2 {
		t.Fatalf("clampOffset(2.7) = %d", got)
	}
}

func TestNormalizePagination(t *testing.T) {
	if page, size := normalizePagination(0, 0); page != 1 || size != 20 {
		t.Fatalf("defaults = %d, %d", page, size)
	}
	if page, size := normalizePagination(3, 1000); page != 3 || size != 100 {
		t.Fatalf("clamp = %d, %d", page, size)
	}
}

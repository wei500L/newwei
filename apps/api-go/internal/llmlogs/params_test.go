package llmlogs

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestParsePositiveIntQueryMirrorsController(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		fallback int
		want     int
		wantErr  bool
	}{
		{name: "page", raw: "3", fallback: 1, want: 3},
		{name: "page", raw: "3.9", fallback: 1, want: 3},
		{name: "page", raw: "3.0", fallback: 1, want: 3},
		{name: "page", raw: "1e2", fallback: 1, want: 100},
		{name: "page", raw: " +7 ", fallback: 1, want: 7},
		{name: "page", raw: "", fallback: 1, want: 1},
		{name: "page", raw: "   ", fallback: 1, want: 1},
		{name: "pageSize", raw: "", fallback: 20, want: 20},
		{name: "page", raw: "0", fallback: 1, wantErr: true},
		{name: "page", raw: "-1", fallback: 1, wantErr: true},
		{name: "page", raw: "0.4", fallback: 1, wantErr: true},
		{name: "page", raw: "abc", fallback: 1, wantErr: true},
		{name: "page", raw: "1,5", fallback: 1, wantErr: true},
		{name: "page", raw: "Infinity", fallback: 1, wantErr: true},
		{name: "page", raw: "NaN", fallback: 1, wantErr: true},
	}
	for _, tc := range cases {
		values := url.Values{tc.name: {tc.raw}}
		got, err := parsePositiveIntQuery(values, tc.name, tc.fallback)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%s=%q got %d, want error", tc.name, tc.raw, got)
			}
			if messageOf(t, err) != tc.name+" must be a positive number" {
				t.Fatalf("%s=%q message=%q", tc.name, tc.raw, messageOf(t, err))
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s=%q unexpected error %v", tc.name, tc.raw, err)
		}
		if got != tc.want {
			t.Fatalf("%s=%q got %d, want %d", tc.name, tc.raw, got, tc.want)
		}
	}
}

func TestNormalizeFeatureMirrorsController(t *testing.T) {
	if _, err := normalizeFeature("Bad Upper"); err == nil {
		t.Fatal("Bad Upper should be rejected")
	} else if messageOf(t, err) != "feature must be a lowercase token with [a-z0-9_:. -], max 64 chars" {
		t.Fatalf("message=%q", messageOf(t, err))
	}
	// 空值放行（undefined 语义）。
	for _, raw := range []string{"", "   "} {
		got, err := normalizeFeature(raw)
		if err != nil || got != "" {
			t.Fatalf("%q got %q err=%v", raw, got, err)
		}
	}
	// 大写转小写，允许 : _ - . 与数字。
	got, err := normalizeFeature("  News:Pipeline_v2.1  ")
	if err != nil || got != "news:pipeline_v2.1" {
		t.Fatalf("got %q err=%v", got, err)
	}
	// 64 字符是上限（含），65 拒绝。
	if _, err := normalizeFeature(strings.Repeat("a", 64)); err != nil {
		t.Fatalf("64 chars rejected: %v", err)
	}
	if _, err := normalizeFeature(strings.Repeat("a", 65)); err == nil {
		t.Fatal("65 chars should be rejected")
	}
	if _, err := normalizeFeature("bad/token"); err == nil {
		t.Fatal("slash should be rejected")
	}
}

func TestNormalizeProfileAndEntityIDsMirrorController(t *testing.T) {
	value, err := normalizeProfileID("  profile-1  ")
	if err != nil || value != "profile-1" {
		t.Fatalf("got %q err=%v", value, err)
	}
	if _, err := normalizeProfileID(strings.Repeat("p", 128)); err != nil {
		t.Fatalf("128 chars rejected: %v", err)
	}
	if _, err := normalizeProfileID(strings.Repeat("p", 129)); err == nil {
		t.Fatal("129 chars should be rejected")
	} else if messageOf(t, err) != "profileId must be 128 characters or fewer" {
		t.Fatalf("message=%q", messageOf(t, err))
	}
	for _, name := range []string{"runId", "nodeId"} {
		if _, err := normalizeEntityID(strings.Repeat("x", 128), name); err != nil {
			t.Fatalf("%s 128 chars rejected: %v", name, err)
		}
		if _, err := normalizeEntityID(strings.Repeat("x", 129), name); err == nil {
			t.Fatalf("%s 129 chars should be rejected", name)
		} else if messageOf(t, err) != name+" must be 128 characters or fewer" {
			t.Fatalf("%s message=%q", name, messageOf(t, err))
		}
		if got, err := normalizeEntityID("   ", name); err != nil || got != "" {
			t.Fatalf("%s blank got %q err=%v", name, got, err)
		}
	}
}

func TestNormalizeRequestTypeAndStatusMirrorController(t *testing.T) {
	for _, raw := range []string{"completion", "embedding", "rerank", "stream", "responses"} {
		got, err := normalizeRequestType(" " + raw + " ")
		if err != nil || got != raw {
			t.Fatalf("%q got %q err=%v", raw, got, err)
		}
	}
	if _, err := normalizeRequestType("chat"); err == nil {
		t.Fatal("chat should be rejected")
	} else if messageOf(t, err) != "requestType must be one of completion, embedding, rerank, stream, responses" {
		t.Fatalf("message=%q", messageOf(t, err))
	}
	if got, err := normalizeRequestType(""); err != nil || got != "" {
		t.Fatalf("blank got %q err=%v", got, err)
	}

	for _, raw := range []string{"success", "error"} {
		got, err := normalizeStatus(raw)
		if err != nil || got != raw {
			t.Fatalf("%q got %q err=%v", raw, got, err)
		}
	}
	if _, err := normalizeStatus("pending"); err == nil {
		t.Fatal("pending should be rejected")
	} else if messageOf(t, err) != "status must be one of success, error" {
		t.Fatalf("message=%q", messageOf(t, err))
	}
}

func TestParseDateRangeMirrorsController(t *testing.T) {
	values := url.Values{"start": {"2026-10-01T00:00:00Z"}, "end": {"2026-10-02T00:00:00Z"}}
	start, end, err := parseDateRange(values)
	if err != nil || start == nil || end == nil {
		t.Fatalf("err=%v", err)
	}
	if !start.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("start=%s", start)
	}
	if start.Location() != time.UTC || end.Location() != time.UTC {
		t.Fatal("dates must be normalized to UTC")
	}

	// 非空但不是合法日期。
	for _, name := range []string{"start", "end"} {
		_, _, err := parseDateRange(url.Values{name: {"not-a-date"}})
		if err == nil {
			t.Fatalf("%s invalid date accepted", name)
		}
		if messageOf(t, err) != name+" must be a valid date" {
			t.Fatalf("%s message=%q", name, messageOf(t, err))
		}
	}

	// start > end。
	_, _, err = parseDateRange(url.Values{
		"start": {"2026-10-03T00:00:00Z"},
		"end":   {"2026-10-01T00:00:00Z"},
	})
	if err == nil || messageOf(t, err) != "start must be earlier than or equal to end" {
		t.Fatalf("start>end err=%v", err)
	}

	// 相等放行；缺省放行。
	if _, _, err := parseDateRange(url.Values{
		"start": {"2026-10-01T00:00:00Z"},
		"end":   {"2026-10-01T00:00:00Z"},
	}); err != nil {
		t.Fatalf("equal range rejected: %v", err)
	}
	start, end, err = parseDateRange(url.Values{})
	if err != nil || start != nil || end != nil {
		t.Fatalf("empty range got %v/%v err=%v", start, end, err)
	}
	// 空白视为缺省。
	start, end, err = parseDateRange(url.Values{"start": {"  "}, "end": {""}})
	if err != nil || start != nil || end != nil {
		t.Fatalf("blank range got %v/%v err=%v", start, end, err)
	}
}

func TestParseDateAcceptsISO8601Forms(t *testing.T) {
	cases := map[string]time.Time{
		"2026-10-16T12:34:56Z":      time.Date(2026, 10, 16, 12, 34, 56, 0, time.UTC),
		"2026-10-16T12:34:56.789Z":  time.Date(2026, 10, 16, 12, 34, 56, 789000000, time.UTC),
		"2026-10-16T20:34:56+08:00": time.Date(2026, 10, 16, 12, 34, 56, 0, time.UTC),
		"2026-10-16T12:34:56":       time.Date(2026, 10, 16, 12, 34, 56, 0, time.UTC),
		"2026-10-16":                time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC),
	}
	for raw, want := range cases {
		got, ok := parseDate(raw)
		if !ok {
			t.Fatalf("%q rejected", raw)
		}
		if !got.UTC().Equal(want) {
			t.Fatalf("%q got %s want %s", raw, got.UTC(), want)
		}
	}
	for _, raw := range []string{"", "  ", "yesterday", "2026-13-40", "2026-10-16T25:00:00Z"} {
		if _, ok := parseDate(raw); ok {
			t.Fatalf("%q accepted", raw)
		}
	}
}

func TestParseListFilterRejectsFirstInvalidParameter(t *testing.T) {
	// 日期范围先于其余参数校验（与控制器 parseLogFilter 的顺序一致）。
	_, err := parseListFilter(url.Values{
		"start":       {"bad"},
		"requestType": {"chat"},
	}, "org-1")
	if messageOf(t, err) != "start must be a valid date" {
		t.Fatalf("message=%q", messageOf(t, err))
	}

	filter, err := parseListFilter(url.Values{
		"model":       {" gpt-4o "},
		"feature":     {"News"},
		"profileId":   {" p1 "},
		"runId":       {" r1 "},
		"nodeId":      {" n1 "},
		"requestType": {"completion"},
		"status":      {"error"},
		"start":       {"2026-10-01T00:00:00Z"},
	}, "org-1")
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if filter.OrgID != "org-1" || filter.Model != "gpt-4o" || filter.Feature != "news" ||
		filter.ProfileID != "p1" || filter.RunID != "r1" || filter.NodeID != "n1" ||
		filter.RequestType != "completion" || filter.Status != "error" || filter.Start == nil || filter.End != nil {
		t.Fatalf("filter=%+v", filter)
	}
}

func TestParseSummaryFilterIgnoresListOnlyParameters(t *testing.T) {
	filter, err := parseSummaryFilter(url.Values{
		"feature":     {"News"},
		"profileId":   {"p1"},
		"runId":       {"r1"},
		"nodeId":      {"n1"},
		"model":       {"gpt-4o"},
		"requestType": {"completion"},
		"status":      {"error"},
	}, "org-1")
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if filter.OrgID != "org-1" || filter.Feature != "news" || filter.ProfileID != "p1" ||
		filter.RunID != "r1" || filter.NodeID != "n1" || filter.Start != nil || filter.End != nil {
		t.Fatalf("filter=%+v", filter)
	}
	// 控制器不接收 requestType/status：非法值在 summary 里不得触发 400。
	if _, err := parseSummaryFilter(url.Values{"status": {"pending"}}, "org-1"); err != nil {
		t.Fatalf("summary must ignore status: %v", err)
	}
}

func TestParsePaginationUsesControllerDefaults(t *testing.T) {
	page, pageSize, err := parsePagination(url.Values{})
	if err != nil || page != 1 || pageSize != 20 {
		t.Fatalf("page=%d pageSize=%d err=%v", page, pageSize, err)
	}
	if _, _, err := parsePagination(url.Values{"pageSize": {"0"}}); err == nil {
		t.Fatal("pageSize=0 should be rejected")
	} else if messageOf(t, err) != "pageSize must be a positive number" {
		t.Fatalf("message=%q", messageOf(t, err))
	}
}

func TestJSLengthCountsUTF16Units(t *testing.T) {
	if got := jsLength("abc"); got != 3 {
		t.Fatalf("ascii got %d", got)
	}
	// 增补平面字符（emoji）在 JS 里算 2。
	if got := jsLength("\U0001F600"); got != 2 {
		t.Fatalf("emoji got %d", got)
	}
	if got := jsLength("a\U0001F600b"); got != 4 {
		t.Fatalf("mixed got %d", got)
	}
}

func messageOf(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	var input *inputError
	if errors.As(err, &input) {
		return input.Message
	}
	return err.Error()
}

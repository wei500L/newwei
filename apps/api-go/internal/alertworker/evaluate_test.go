package alertworker

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func floatPtr(value float64) *float64 { return &value }

func TestShouldTriggerOperators(t *testing.T) {
	cases := []struct {
		name          string
		rule          Rule
		latest        float64
		previous      *float64
		changePercent *float64
		wantTriggered bool
		wantMessage   string
		wantContext   string
	}{
		{
			name:          "gt triggers above",
			rule:          Rule{Operator: "gt", ThresholdValue: floatPtr(4)},
			latest:        5,
			wantTriggered: true,
			wantMessage:   "Value 5 is greater than 4",
			wantContext:   `{"latest":5,"threshold":4}`,
		},
		{
			name:   "gt ignores the boundary",
			rule:   Rule{Operator: "gt", ThresholdValue: floatPtr(4)},
			latest: 4,
		},
		{
			name:          "gte accepts the boundary",
			rule:          Rule{Operator: "gte", ThresholdValue: floatPtr(4)},
			latest:        4,
			wantTriggered: true,
			wantMessage:   "Value 4 is >= 4",
			wantContext:   `{"latest":4,"threshold":4}`,
		},
		{
			name:          "lt triggers below",
			rule:          Rule{Operator: "lt", ThresholdValue: floatPtr(4)},
			latest:        3,
			wantTriggered: true,
			wantMessage:   "Value 3 is below 4",
			wantContext:   `{"latest":3,"threshold":4}`,
		},
		{
			name:   "lt ignores the boundary",
			rule:   Rule{Operator: "lt", ThresholdValue: floatPtr(4)},
			latest: 4,
		},
		{
			name:          "lte accepts the boundary",
			rule:          Rule{Operator: "lte", ThresholdValue: floatPtr(4)},
			latest:        4,
			wantTriggered: true,
			wantMessage:   "Value 4 is <= 4",
			wantContext:   `{"latest":4,"threshold":4}`,
		},
		{
			name:          "eq compares exactly",
			rule:          Rule{Operator: "eq", ThresholdValue: floatPtr(0.5)},
			latest:        0.5,
			wantTriggered: true,
			wantMessage:   "Value 0.5 equals 0.5",
			wantContext:   `{"latest":0.5,"threshold":0.5}`,
		},
		{
			name:   "eq rejects a different value",
			rule:   Rule{Operator: "eq", ThresholdValue: floatPtr(0.5)},
			latest: 0.6,
		},
		{
			name:          "outside_range triggers below the lower bound",
			rule:          Rule{Operator: "outside_range", ThresholdLower: floatPtr(1), ThresholdUpper: floatPtr(2)},
			latest:        0.5,
			wantTriggered: true,
			wantMessage:   "Value 0.5 is outside 1-2",
			wantContext:   `{"latest":0.5,"lower":1,"upper":2}`,
		},
		{
			name:          "outside_range triggers above the upper bound",
			rule:          Rule{Operator: "outside_range", ThresholdLower: floatPtr(1), ThresholdUpper: floatPtr(2)},
			latest:        3,
			wantTriggered: true,
			wantMessage:   "Value 3 is outside 1-2",
			wantContext:   `{"latest":3,"lower":1,"upper":2}`,
		},
		{
			name:   "outside_range keeps the closed interval",
			rule:   Rule{Operator: "outside_range", ThresholdLower: floatPtr(1), ThresholdUpper: floatPtr(2)},
			latest: 1,
		},
		{
			name:   "outside_range without both bounds never triggers",
			rule:   Rule{Operator: "outside_range", ThresholdLower: floatPtr(1)},
			latest: 0,
		},
		{
			name:          "within_range triggers inside",
			rule:          Rule{Operator: "within_range", ThresholdLower: floatPtr(1), ThresholdUpper: floatPtr(2)},
			latest:        1.5,
			wantTriggered: true,
			wantMessage:   "Value 1.5 is within 1-2",
			wantContext:   `{"latest":1.5,"lower":1,"upper":2}`,
		},
		{
			name:   "within_range rejects outside",
			rule:   Rule{Operator: "within_range", ThresholdLower: floatPtr(1), ThresholdUpper: floatPtr(2)},
			latest: 2.5,
		},
		{
			name:          "change_up_pct triggers at the threshold",
			rule:          Rule{Operator: "change_up_pct", ThresholdValue: floatPtr(1)},
			latest:        10,
			changePercent: floatPtr(1.005),
			wantTriggered: true,
			wantMessage:   "Change 1.00% >= 1%",
			wantContext:   `{"changePercent":1.005}`,
		},
		{
			name:          "change_up_pct triggers above",
			rule:          Rule{Operator: "change_up_pct", ThresholdValue: floatPtr(1)},
			latest:        10,
			changePercent: floatPtr(12.5),
			wantTriggered: true,
			wantMessage:   "Change 12.50% >= 1%",
			wantContext:   `{"changePercent":12.5}`,
		},
		{
			name:          "change_up_pct ignores a missing change",
			rule:          Rule{Operator: "change_up_pct", ThresholdValue: floatPtr(1)},
			latest:        10,
			wantTriggered: false,
		},
		{
			name:          "change_down_pct triggers on an equal drop",
			rule:          Rule{Operator: "change_down_pct", ThresholdValue: floatPtr(0.125)},
			latest:        1,
			changePercent: floatPtr(-0.125),
			wantTriggered: true,
			wantMessage:   "Change -0.13% <= -0.125%",
			wantContext:   `{"changePercent":-0.125}`,
		},
		{
			name:   "change_down_pct ignores a smaller drop",
			rule:   Rule{Operator: "change_down_pct", ThresholdValue: floatPtr(1)},
			latest: 1,

			changePercent: floatPtr(-0.5),
		},
		{
			name:   "numeric threshold without a value never triggers",
			rule:   Rule{Operator: "gt"},
			latest: 100,
		},
		{
			name:          "javascript number formatting in messages",
			rule:          Rule{Operator: "gte", ThresholdValue: floatPtr(1e-7)},
			latest:        1e21,
			wantTriggered: true,
			wantMessage:   "Value 1e+21 is >= 1e-7",
			wantContext:   `{"latest":1e+21,"threshold":1e-7}`,
		},
		{
			name:          "integral values print without a fraction",
			rule:          Rule{Operator: "lte", ThresholdValue: floatPtr(1234.5678)},
			latest:        42,
			wantTriggered: true,
			wantMessage:   "Value 42 is <= 1234.5678",
			wantContext:   `{"latest":42,"threshold":1234.5678}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			triggered, message, context := shouldTrigger(tc.rule, tc.latest, tc.previous, tc.changePercent)
			if triggered != tc.wantTriggered {
				t.Fatalf("triggered = %t, want %t", triggered, tc.wantTriggered)
			}
			if !tc.wantTriggered {
				if message != "" || context != nil {
					t.Fatalf("no-trigger result = %q %v", message, context)
				}
				return
			}
			if message != tc.wantMessage {
				t.Fatalf("message = %q, want %q", message, tc.wantMessage)
			}
			if got := string(context.Marshal()); got != tc.wantContext {
				t.Fatalf("context = %s, want %s", got, tc.wantContext)
			}
		})
	}
}

func TestNormalizeMetricSlugAliases(t *testing.T) {
	cases := map[string]string{
		"realtime.adsb.military_flights":      "realtime.opensky.military_flights",
		" realtime.opensky.military_flights ": "realtime.opensky.military_flights",
		"realtime.adsb.snapshot_health":       "realtime.opensky.snapshot_health",
		"pipeline.success_rate":               "pipeline.success_rate",
		"":                                    "",
	}
	for input, want := range cases {
		if got := normalizeMetricSlug(input); got != want {
			t.Errorf("normalizeMetricSlug(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeAlertContextCountry(t *testing.T) {
	cases := []struct {
		name       string
		context    string
		wantCode   string
		wantName   string
		absentCode bool
		absentName bool
	}{
		{name: "empty context", context: "{}", absentCode: true, absentName: true},
		{name: "two letter code", context: `{"country":"US"}`, wantCode: "USA"},
		{name: "three letter code", context: `{"countryCode":"deu"}`, wantCode: "DEU"},
		{name: "country name becomes the name", context: `{"country":"Germany"}`, wantCode: "DEU", wantName: "Germany"},
		{name: "code like country keeps the resolved name", context: `{"country":"DE"}`, wantCode: "DEU"},
		{name: "existing name wins", context: `{"country":"DE","countryName":"Deutschland"}`, wantCode: "DEU", wantName: "Deutschland"},
		{name: "unknown country is left alone", context: `{"country":"Atlantis"}`, absentCode: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			object, ok := parseJSONObject(json.RawMessage(tc.context))
			if !ok {
				t.Fatalf("fixture is not an object: %s", tc.context)
			}
			normalized := normalizeAlertContext(object)
			code, hasCode := stringField(normalized, "countryCode")
			name, hasName := stringField(normalized, "countryName")
			if tc.absentCode {
				if hasCode {
					t.Fatalf("countryCode = %q, want absent", code)
				}
			} else if code != tc.wantCode {
				t.Fatalf("countryCode = %q, want %q", code, tc.wantCode)
			}
			if tc.wantName != "" {
				if !hasName || name != tc.wantName {
					t.Fatalf("countryName = %q/%t, want %q", name, hasName, tc.wantName)
				}
			} else if tc.absentName && hasName {
				t.Fatalf("countryName = %q, want absent", name)
			}
		})
	}
}

func TestDefaultRuleIDs(t *testing.T) {
	cases := []struct {
		prefix string
		key    string
		orgID  string
		want   string
	}{
		{"default-crawl-quality-", "preflight_failure_rate", "org-1", "default-crawl-quality-preflight_failure_rate-org-1"},
		{"default-realtime-signal-", "opensky", "org 1/x", "default-realtime-signal-opensky-org_1_x"},
		{"default-pipeline-", "success_rate", "org.1", "default-pipeline-success_rate-org_1"},
	}
	for _, tc := range cases {
		if got := defaultRuleID(tc.prefix, tc.key, tc.orgID); got != tc.want {
			t.Errorf("defaultRuleID = %q, want %q", got, tc.want)
		}
	}
	longOrg := strings.Repeat("a", 200)
	if got := defaultRuleID("default-pipeline-", "success_rate", longOrg); len(got) != 191 {
		t.Errorf("defaultRuleID length = %d, want 191", len(got))
	}
}

func TestDefaultRuleGroupsCoverEverySystemDefault(t *testing.T) {
	total := 0
	for _, group := range defaultRuleGroups {
		total += len(group.Definitions)
		switch group.MetricProvider {
		case "crawl_task":
			if group.CooldownSeconds != 3600 || len(group.Definitions) != 3 {
				t.Fatalf("crawl group = %+v", group)
			}
		case "realtime_signal":
			if group.CooldownSeconds != 1800 || len(group.Definitions) != 9 {
				t.Fatalf("realtime group = %+v", group)
			}
		case "pipeline_job":
			if group.CooldownSeconds != 1800 || len(group.Definitions) != 5 {
				t.Fatalf("pipeline group = %+v", group)
			}
		default:
			t.Fatalf("unexpected group %q", group.MetricProvider)
		}
	}
	if total != 17 {
		t.Fatalf("default rule count = %d, want 17", total)
	}
}

func TestNotificationBackoffDelayTable(t *testing.T) {
	cases := map[int]int64{1: 60_000, 2: 5 * 60_000, 3: 15 * 60_000, 4: 15 * 60_000, 0: 60_000}
	for attempt, want := range cases {
		if got := notificationBackoffDelay(attempt); got != want {
			t.Errorf("notificationBackoffDelay(%d) = %d, want %d", attempt, got, want)
		}
	}
	if notificationAttempts != 4 {
		t.Fatalf("notificationAttempts = %d", notificationAttempts)
	}
}

func TestClampSeconds(t *testing.T) {
	cases := map[float64]int64{0.5: 1, 1: 1, 90.9: 90, 365 * 24 * 3600: 365 * 24 * 3600, 1e12: 365 * 24 * 3600, -3: 1}
	for input, want := range cases {
		if got := clampSeconds(input); got != want {
			t.Errorf("clampSeconds(%v) = %d, want %d", input, got, want)
		}
	}
}

func TestEnsureTraceID(t *testing.T) {
	if got := ensureTraceID("0123456789ABCDEF"); got != "0123456789ABCDEF" {
		t.Fatalf("trace id = %q", got)
	}
	if got := ensureTraceID("zz-0123456789abcdef-zz"); got != "0123456789abcdef" {
		t.Fatalf("trace id = %q", got)
	}
	generated := ensureTraceID("")
	if len(generated) != 32 {
		t.Fatalf("generated trace id = %q", generated)
	}
}

func TestRandomRowIDShape(t *testing.T) {
	id, err := randomRowID()
	if err != nil {
		t.Fatalf("randomRowID: %v", err)
	}
	if len(id) != 25 || id[0] != 'c' {
		t.Fatalf("row id = %q", id)
	}
	other, err := randomRowID()
	if err != nil {
		t.Fatalf("randomRowID: %v", err)
	}
	if id == other {
		t.Fatal("row ids must be unique")
	}
}

func TestFormatDecimalMatchesNumberToString(t *testing.T) {
	cases := map[float64]string{
		1:         "1",
		1.5:       "1.5",
		0.1:       "0.1",
		1e21:      "1e+21",
		1e-7:      "1e-7",
		1234.5678: "1234.5678",
		-0.5:      "-0.5",
	}
	for input, want := range cases {
		if got := formatDecimal(input); got != want {
			t.Errorf("formatDecimal(%v) = %q, want %q", input, got, want)
		}
	}
}

func TestPublishedEnvelopeShape(t *testing.T) {
	triggeredAt := time.Date(2026, 10, 20, 1, 2, 3, 456_000_000, time.UTC)
	message := "Value 5 is greater than 4"
	envelope := alertEventEnvelope{
		OrgID: "org-1",
		Event: alertEventPayloadBody{
			ID:             "event-1",
			RuleID:         "rule-1",
			RuleName:       "Rule",
			MetricProvider: "system_event",
			MetricSlug:     "realtime.adsb.military_flights",
			TriggeredAt:    gqlDate{time: triggeredAt},
			Message:        &message,
			Severity:       "high",
			MetricValue:    5,
			Status:         "pending",
			Context:        json.RawMessage(`{"latest":5}`),
		},
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(encoded)
	want := `{"orgId":"org-1","event":{"id":"event-1","ruleId":"rule-1","ruleName":"Rule",` +
		`"metricProvider":"system_event","metricSlug":"realtime.adsb.military_flights",` +
		`"triggeredAt":{"$gqlDate":"2026-10-20T01:02:03.456Z"},"message":"Value 5 is greater than 4",` +
		`"severity":"high","metricValue":5,"changePercent":null,"status":"pending","context":{"latest":5}}}`
	if got != want {
		t.Fatalf("envelope = %s\nwant     = %s", got, want)
	}
}

func TestJSONObjectKeepsInsertionOrderOnMerge(t *testing.T) {
	base := newJSONObject()
	base.SetRawNumber("latest", "5")
	base.SetNull("previous")
	base.SetNull("changePercent")
	override, ok := parseJSONObject(json.RawMessage(`{"threshold":4,"latest":9}`))
	if !ok {
		t.Fatal("fixture decode failed")
	}
	base.SetObject(override)
	base.SetString("countryCode", "USA")
	got := string(base.Marshal())
	want := `{"latest":9,"previous":null,"changePercent":null,"threshold":4,"countryCode":"USA"}`
	if got != want {
		t.Fatalf("merged object = %s, want %s", got, want)
	}
}

func TestToStringArray(t *testing.T) {
	object, ok := parseJSONObject(json.RawMessage(`{"notifyUserIds":[" u1 ","",42,null,"u2"]}`))
	if !ok {
		t.Fatal("fixture decode failed")
	}
	got := toStringArray(object, "notifyUserIds")
	if len(got) != 2 || got[0] != "u1" || got[1] != "u2" {
		t.Fatalf("user ids = %#v", got)
	}
	if values := toStringArray(object, "missing"); values != nil {
		t.Fatalf("missing key = %#v", values)
	}
}

func TestOrderedSet(t *testing.T) {
	set := newOrderedSet()
	set.Add("b")
	set.Add("a")
	set.Add("b")
	set.Add("")
	if values := set.Values(); len(values) != 2 || values[0] != "b" || values[1] != "a" {
		t.Fatalf("values = %#v", values)
	}
	if set.Len() != 2 {
		t.Fatalf("len = %d", set.Len())
	}
}

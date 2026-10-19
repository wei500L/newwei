package alertworker

import (
	"encoding/json"
	"testing"
)

func TestExtractMuteUntilMs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want *int64
	}{
		{name: "absent", raw: `{}`},
		{name: "null", raw: `{"muteUntil":null}`},
		{name: "iso string", raw: `{"muteUntil":"2026-10-20T01:00:00.000Z"}`, want: int64ValuePtr(1792458000000)},
		{name: "seconds", raw: `{"muteUntil":1792458000}`, want: int64ValuePtr(1792458000000)},
		{name: "milliseconds", raw: `{"muteUntil":1792458000000}`, want: int64ValuePtr(1792458000000)},
		{name: "alias", raw: `{"mute_until":1792458000}`, want: int64ValuePtr(1792458000000)},
		{name: "object is not parsed and does not fall through", raw: `{"muteUntil":{"at":1},"mutedUntil":1792458000}`},
		{name: "invalid string", raw: `{"muteUntil":"soon"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractMuteUntilMs(json.RawMessage(tc.raw))
			if tc.want == nil {
				if got != nil {
					t.Fatalf("muteUntil = %d, want nil", *got)
				}
				return
			}
			if got == nil || *got != *tc.want {
				t.Fatalf("muteUntil = %v, want %d", got, *tc.want)
			}
		})
	}
}

func TestExtractNotifyIntervalSeconds(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want *int64
	}{
		{name: "absent", raw: `{}`},
		{name: "seconds", raw: `{"notifyIntervalSeconds":90}`, want: int64ValuePtr(90)},
		{name: "seconds clamp", raw: `{"notifyIntervalSeconds":0.5}`, want: int64ValuePtr(1)},
		{name: "string seconds", raw: `{"notifyIntervalSec":" 120 "}`, want: int64ValuePtr(120)},
		{name: "invalid seconds fall back to minutes", raw: `{"notifyIntervalSeconds":"abc","notifyIntervalMinutes":5}`, want: int64ValuePtr(300)},
		{name: "minutes", raw: `{"frequencyMinutes":2}`, want: int64ValuePtr(120)},
		{name: "zero is not positive", raw: `{"notifyIntervalSeconds":0}`},
		{name: "negative is not positive", raw: `{"minIntervalSeconds":-5}`},
		{name: "largest accepted interval", raw: `{"notifyIntervalSeconds":999999999}`, want: int64ValuePtr(365 * 24 * 3600)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractNotifyIntervalSeconds(json.RawMessage(tc.raw))
			if tc.want == nil {
				if got != nil {
					t.Fatalf("interval = %d, want nil", *got)
				}
				return
			}
			if got == nil || *got != *tc.want {
				t.Fatalf("interval = %v, want %d", got, *tc.want)
			}
		})
	}
}

func TestDeliveryThresholdFallback(t *testing.T) {
	value := 5.0
	upper := 10.0
	lower := 1.0
	if got := deliveryThreshold(Rule{ThresholdValue: &value, ThresholdUpper: &upper, ThresholdLower: &lower}); got == nil || *got != value {
		t.Fatalf("threshold = %v, want the value", got)
	}
	if got := deliveryThreshold(Rule{ThresholdUpper: &upper, ThresholdLower: &lower}); got == nil || *got != upper {
		t.Fatalf("threshold = %v, want the upper bound", got)
	}
	if got := deliveryThreshold(Rule{ThresholdLower: &lower}); got == nil || *got != lower {
		t.Fatalf("threshold = %v, want the lower bound", got)
	}
	if got := deliveryThreshold(Rule{}); got != nil {
		t.Fatalf("threshold = %v, want nil", got)
	}
}

func TestFinalAttemptB1(t *testing.T) {
	cases := []struct {
		attemptsMade int
		attempts     int
		want         bool
	}{
		{0, 4, false},
		{1, 4, false},
		{2, 4, false},
		{3, 4, true},
		{0, 1, true},
		{0, 0, true},
	}
	for _, tc := range cases {
		if got := finalAttempt(tc.attemptsMade, tc.attempts); got != tc.want {
			t.Errorf("finalAttempt(%d, %d) = %t, want %t", tc.attemptsMade, tc.attempts, got, tc.want)
		}
	}
}

func TestParseDeliveryChannel(t *testing.T) {
	channel, ok := parseDeliveryChannel(json.RawMessage(`{"id":"c1","type":"webhook","target":"https://example.com/hook","name":"hook","config":{"notifyIntervalSeconds":60}}`))
	if !ok {
		t.Fatal("snapshot decode failed")
	}
	if channel.ID != "c1" || channel.Type != "webhook" || channel.Target != "https://example.com/hook" {
		t.Fatalf("channel = %+v", channel)
	}
	if _, ok := parseDeliveryChannel(nil); ok {
		t.Fatal("nil snapshot must not decode")
	}
	if _, ok := parseDeliveryChannel(json.RawMessage(`"text"`)); ok {
		t.Fatal("a non-object snapshot must not decode")
	}
}

func TestMarshalChannelSnapshotShape(t *testing.T) {
	channel := Channel{
		ID:       "c1",
		OrgID:    "o1",
		Type:     "email",
		Name:     "ops",
		Target:   "ops@example.com",
		IsActive: true,
	}
	snapshot, err := marshalChannelSnapshot(channel)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(snapshot, &decoded); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	for _, key := range []string{"id", "orgId", "type", "name", "target", "config", "isActive", "createdAt", "updatedAt"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("snapshot is missing %q: %s", key, snapshot)
		}
	}
	if string(decoded["config"]) != "null" {
		t.Errorf("config = %s, want null", decoded["config"])
	}
}

func TestMembershipPermissionVerdicts(t *testing.T) {
	read := alertsReadPermission
	other := "items.read"
	entries := []candidateMembership{
		// eligible member with the permission through the linked role
		{UserID: "u-allowed", MembershipID: "m1", Eligible: true, FromLink: true, PermissionName: &read},
		{UserID: "u-allowed", MembershipID: "m1", Eligible: true, FromLink: true, PermissionName: &other},
		// eligible member without the permission
		{UserID: "u-missing", MembershipID: "m2", Eligible: true, FromLink: false, PermissionName: &other},
		// linked roles win over the primary role
		{UserID: "u-linked", MembershipID: "m3", Eligible: true, FromLink: true, PermissionName: &other},
		{UserID: "u-linked", MembershipID: "m3", Eligible: true, FromLink: false, PermissionName: &read},
		// inactive membership: no verdict
		{UserID: "u-inactive", MembershipID: "m4", Eligible: false, FromLink: false, PermissionName: &read},
	}
	verdicts := membershipPermissionVerdicts(entries)
	if verdict, ok := verdicts["u-allowed"]; !ok || !verdict.allowed {
		t.Fatalf("u-allowed verdict = %+v/%t", verdict, ok)
	}
	if verdict, ok := verdicts["u-missing"]; !ok || !verdict.missing || verdict.allowed {
		t.Fatalf("u-missing verdict = %+v/%t", verdict, ok)
	}
	if verdict, ok := verdicts["u-linked"]; !ok || !verdict.missing {
		t.Fatalf("u-linked verdict = %+v/%t, the linked role must win", verdict, ok)
	}
	if _, ok := verdicts["u-inactive"]; ok {
		t.Fatal("an ineligible membership must not produce a verdict")
	}
}

func TestMembershipPermissionVerdictsWithoutPermissions(t *testing.T) {
	entries := []candidateMembership{
		{UserID: "u1", MembershipID: "m1", Eligible: true, FromLink: false},
	}
	verdicts := membershipPermissionVerdicts(entries)
	if verdict, ok := verdicts["u1"]; !ok || !verdict.missing {
		t.Fatalf("verdict = %+v/%t", verdict, ok)
	}
}

func TestNotificationContextSummary(t *testing.T) {
	object, ok := parseJSONObject(json.RawMessage(`{"countryCode":"USA","itemName":"CPI","unit":"%","latest":5,"previous":null}`))
	if !ok {
		t.Fatal("fixture decode failed")
	}
	summary := buildNotificationContextSummary(object)
	if summary == nil || summary.CountryCode == nil || *summary.CountryCode != "USA" {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.ItemName == nil || *summary.ItemName != "CPI" || summary.Unit == nil || *summary.Unit != "%" {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.CountryName != nil || summary.SourceName != nil || summary.RecordedAt != nil {
		t.Fatalf("summary = %+v", summary)
	}
	if buildNotificationContextSummary(nil) != nil {
		t.Fatal("a nil context must produce a nil summary")
	}
	empty, ok := parseJSONObject(json.RawMessage(`{}`))
	if !ok {
		t.Fatal("fixture decode failed")
	}
	if buildNotificationContextSummary(empty) == nil {
		t.Fatal("an empty context object must still produce a summary object")
	}
}

func TestNotificationDataShape(t *testing.T) {
	changePercent := 12.5
	message := "Value 5 is greater than 4"
	data := notificationData{
		AlertEventID:  "event-1",
		RuleID:        "rule-1",
		RuleName:      "Rule",
		Severity:      "high",
		MetricSlug:    "pipeline.success_rate",
		MetricValue:   0.5,
		ChangePercent: &changePercent,
		Presentation: notificationPresentation{
			Kind: presentationKindAlertTriggered,
			Params: notificationPresentationParams{
				AlertEventID:  "event-1",
				RuleID:        "rule-1",
				RuleName:      "Rule",
				Severity:      "high",
				MetricSlug:    "pipeline.success_rate",
				MetricValue:   0.5,
				ChangePercent: &changePercent,
			},
			TechnicalDetail: &message,
		},
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"alertEventId":"event-1","ruleId":"rule-1","ruleName":"Rule","severity":"high",` +
		`"metricSlug":"pipeline.success_rate","metricValue":0.5,"changePercent":12.5,` +
		`"presentation":{"kind":"alert_triggered","params":{"alertEventId":"event-1","ruleId":"rule-1",` +
		`"ruleName":"Rule","severity":"high","metricSlug":"pipeline.success_rate","metricValue":0.5,` +
		`"changePercent":12.5},"technicalDetail":"Value 5 is greater than 4"}}`
	if string(encoded) != want {
		t.Fatalf("notification data = %s\nwant              = %s", encoded, want)
	}
}

func TestNotificationRelayMessage(t *testing.T) {
	encoded, err := json.Marshal(notificationRelayMessage{
		Version:        notificationRelayVersion,
		NotificationID: "n1",
		OrgID:          "o1",
		UserID:         "u1",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(encoded), `{"version":1,"notificationId":"n1","orgId":"o1","userId":"u1"}`; got != want {
		t.Fatalf("relay message = %s, want %s", got, want)
	}
}

func int64ValuePtr(value int64) *int64 { return &value }

package workspacewrite

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// TestPlanWidgetWritesSkipsUnchangedWidgets pins the save optimization: a widget
// whose normalized target fields equal the stored row is not updated, an object
// whose keys are reordered still counts as unchanged, and array order still
// counts as a change.
func TestPlanWidgetWritesSkipsUnchangedWidgets(t *testing.T) {
	title := "Revenue"
	existing := []dashboardWidgetRecord{{
		ID:         "w1",
		Title:      &title,
		Type:       "line",
		DataSource: "economic",
		DataConfig: json.RawMessage(`{"series": ["gdp"], "dimension": {"scope": "org"}}`),
		LayoutX:    0,
		LayoutY:    1,
		LayoutW:    4,
		LayoutH:    3,
		SortOrder:  0,
		Options:    json.RawMessage(`{"legend": true}`),
	}}
	unchanged := dashboardWidgetInput{
		ID:         stringPtrForTest("w1"),
		Title:      &title,
		TitleSet:   true,
		Type:       "line",
		DataSource: "economic",
		DataConfig: json.RawMessage(`{"dimension":{"scope":"org"},"series":["gdp"]}`),
		LayoutX:    0,
		LayoutY:    1,
		LayoutW:    4,
		LayoutH:    3,
		SortOrder:  intPtrForTest(0),
		Options:    json.RawMessage(`{ "legend" : true }`),
	}
	plan, err := planWidgetWrites(existing, []dashboardWidgetInput{unchanged})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Update) != 0 || len(plan.Create) != 0 || len(plan.Delete) != 0 {
		t.Fatalf("unchanged widget planned writes: %+v", plan)
	}

	changed := unchanged
	changed.DataConfig = json.RawMessage(`{"series":["gdp","cpi"],"dimension":{"scope":"org"}}`)
	plan, err = planWidgetWrites(existing, []dashboardWidgetInput{changed})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Update) != 1 || plan.Update[0].ID != "w1" {
		t.Fatalf("changed array order planned %+v", plan.Update)
	}

	omittedTitle := unchanged
	omittedTitle.Title = nil
	omittedTitle.TitleSet = false
	plan, err = planWidgetWrites(existing, []dashboardWidgetInput{omittedTitle})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Update) != 0 {
		t.Fatalf("omitted title marked the widget changed: %+v", plan.Update)
	}
}

// TestPlanWidgetWritesCreateAndDelete pins the create/delete halves: an input
// widget without an id is created, an existing widget the input omits is
// deleted, and an unknown widget id is rejected.
func TestPlanWidgetWritesCreateAndDelete(t *testing.T) {
	existing := []dashboardWidgetRecord{
		{ID: "w1", Type: "line", DataSource: "economic", DataConfig: json.RawMessage(`{}`), Options: json.RawMessage(`{}`)},
		{ID: "w2", Type: "bar", DataSource: "economic", DataConfig: json.RawMessage(`{}`), Options: json.RawMessage(`{}`)},
	}
	newWidget := dashboardWidgetInput{
		Type:       "pie",
		DataSource: "economic",
		DataConfig: json.RawMessage(`{}`),
		Options:    json.RawMessage(`{}`),
	}
	plan, err := planWidgetWrites(existing, []dashboardWidgetInput{newWidget})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Create) != 1 || len(plan.Update) != 0 {
		t.Fatalf("create plan %+v", plan)
	}
	if len(plan.Delete) != 2 || plan.Delete[0] != "w1" || plan.Delete[1] != "w2" {
		t.Fatalf("delete plan %v", plan.Delete)
	}

	unknown := dashboardWidgetInput{
		ID:         stringPtrForTest("missing"),
		Type:       "line",
		DataSource: "economic",
		DataConfig: json.RawMessage(`{}`),
		Options:    json.RawMessage(`{}`),
	}
	if _, err := planWidgetWrites(existing, []dashboardWidgetInput{unknown}); err == nil {
		t.Fatal("unknown widget id was accepted")
	} else if !strings.Contains(err.Error(), "Widget not found on dashboard") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestPlanWidgetWritesUsesInputIndexForSortOrder pins the `sortOrder ?? index`
// default.
func TestPlanWidgetWritesUsesInputIndexForSortOrder(t *testing.T) {
	inputs := []dashboardWidgetInput{
		{Type: "line", DataSource: "economic", DataConfig: json.RawMessage(`{}`), Options: json.RawMessage(`{}`)},
		{Type: "bar", DataSource: "economic", DataConfig: json.RawMessage(`{}`), Options: json.RawMessage(`{}`), SortOrder: intPtrForTest(9)},
	}
	plan, err := planWidgetWrites(nil, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Create) != 2 {
		t.Fatalf("create plan %+v", plan)
	}
	if plan.Create[0].SortOrder != 0 || plan.Create[1].SortOrder != 9 {
		t.Fatalf("sort orders %d %d", plan.Create[0].SortOrder, plan.Create[1].SortOrder)
	}
}

// TestMergeEventFeedbackPreservesUnknownFields pins the feedback merge: unknown
// context and feedback members survive, an explicit null note keeps a null
// member, a supplied note is trimmed, and a non-object context or feedback is
// treated as an empty object.
func TestMergeEventFeedbackPreservesUnknownFields(t *testing.T) {
	raw := json.RawMessage(`{"recordedAt":"2026-01-01T00:00:00.000Z","feedback":{"note":"old","extra":true,"metrics":{"x":1}},"other":7}`)
	actor := "u1"
	merged, err := mergeEventFeedback(raw, feedbackUpdate{
		Status:      "confirmed",
		UpdatedAt:   "2026-02-02T02:02:02.000Z",
		NoteSet:     true,
		UpdatedByID: &actor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if other, ok := jsonObjectMember(merged, "other"); !ok || string(other) != "7" {
		t.Fatalf("unknown context member lost: %s", merged)
	}
	feedback, ok := jsonObjectMember(merged, "feedback")
	if !ok || jsonShapeOf(feedback) != jsonShapeObject {
		t.Fatalf("feedback member missing: %s", merged)
	}
	note, ok := jsonObjectMember(feedback, "note")
	if !ok || string(note) != "null" {
		t.Fatalf("explicit null note not kept: %s", feedback)
	}
	if extra, ok := jsonObjectMember(feedback, "extra"); !ok || string(extra) != "true" {
		t.Fatalf("unknown feedback member lost: %s", feedback)
	}
	if metrics, ok := jsonObjectMember(feedback, "metrics"); !ok || string(metrics) != `{"x":1}` {
		t.Fatalf("feedback metrics lost: %s", feedback)
	}
	if status, ok := jsonObjectMember(feedback, "status"); !ok || string(status) != `"confirmed"` {
		t.Fatalf("feedback status: %s", feedback)
	}
	if updatedBy, ok := jsonObjectMember(feedback, "updatedById"); !ok || string(updatedBy) != `"u1"` {
		t.Fatalf("feedback updatedById: %s", feedback)
	}

	trimmed, err := mergeEventFeedback(json.RawMessage(`[]`), feedbackUpdate{
		Status:    "ignored",
		UpdatedAt: "2026-02-02T02:02:02.000Z",
		Note:      stringPtrForTest("  reviewed  "),
		NoteSet:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	feedback, ok = jsonObjectMember(trimmed, "feedback")
	if !ok {
		t.Fatalf("feedback member missing: %s", trimmed)
	}
	if note, ok := jsonObjectMember(feedback, "note"); !ok || string(note) != `"reviewed"` {
		t.Fatalf("note not trimmed: %s", feedback)
	}
	// A context that is not an object becomes an empty object.
	if trimmed[0] != '{' {
		t.Fatalf("non-object context not replaced: %s", trimmed)
	}

	// No supplied note and no operator means the context is left alone.
	untouched, err := mergeEventFeedback(raw, feedbackUpdate{
		Status:    "ignored",
		UpdatedAt: "2026-02-02T02:02:02.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if untouched != nil {
		t.Fatalf("context should not be rewritten: %s", untouched)
	}
}

// TestJSONEqual pins the comparison rules: object key order is ignored, array
// order is significant, and different scalars are not equal.
func TestJSONEqual(t *testing.T) {
	for _, tc := range []struct {
		left, right string
		equal       bool
	}{
		{`{"a":1,"b":[1,2]}`, `{"b":[1,2],"a":1}`, true},
		{`{"a":1,"b":[1,2]}`, `{"b":[2,1],"a":1}`, false},
		{`{"a":{"x":null}}`, `{"a":{"x":null}}`, true},
		{`null`, `null`, true},
		{`null`, `{}`, false},
		{`[]`, `{}`, false},
	} {
		if got := jsonEqual(json.RawMessage(tc.left), json.RawMessage(tc.right)); got != tc.equal {
			t.Fatalf("jsonEqual(%s, %s) = %v", tc.left, tc.right, got)
		}
	}
}

// TestJSONTextDefaultsToEmptyObject pins the `value ?? {}` write default.
func TestJSONTextDefaultsToEmptyObject(t *testing.T) {
	for _, raw := range []json.RawMessage{nil, json.RawMessage(``), json.RawMessage(`null`)} {
		text, err := jsonText(raw)
		if err != nil {
			t.Fatal(err)
		}
		if text != "{}" {
			t.Fatalf("jsonText(%q) = %q", string(raw), text)
		}
	}
	text, err := jsonText(json.RawMessage(`{"a":1}`))
	if err != nil || text != `{"a":1}` {
		t.Fatalf("jsonText = %q (%v)", text, err)
	}
}

// TestNormalizeEmailTarget pins the extraction rules: candidates are filtered by
// isEmail, deduplicated in first-seen order, and joined with ", ".
func TestNormalizeEmailTarget(t *testing.T) {
	normalized, err := normalizeEmailTarget("Ops@Example.com, Ops@Example.com; second@example.org")
	if err != nil {
		t.Fatal(err)
	}
	if normalized != "Ops@Example.com, second@example.org" {
		t.Fatalf("normalized = %q", normalized)
	}
	if _, err := normalizeEmailTarget("not-an-email"); err == nil {
		t.Fatal("invalid target was accepted")
	} else if !strings.Contains(err.Error(), "Invalid email target") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestNormalizeChannelTargetRejectsUnsafeWebhook pins the synchronous SSRF
// checks the service layer applies to a webhook target.
func TestNormalizeChannelTargetRejectsUnsafeWebhook(t *testing.T) {
	if _, err := normalizeChannelTarget(t.Context(), alertChannelWebhook, "http://localhost:9000/hook"); err == nil {
		t.Fatal("localhost webhook was accepted")
	} else if !strings.Contains(err.Error(), "Unsafe webhook target: Localhost is not allowed") {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := normalizeChannelTarget(t.Context(), alertChannelWebhook, "file:///etc/passwd"); err == nil {
		t.Fatal("non-http webhook was accepted")
	}
	if _, err := normalizeChannelTarget(t.Context(), "in_app", "  user-1  "); err != nil {
		t.Fatal(err)
	}
}

// TestGraphqlFailureMapping pins the error mapping the executor consumes.
func TestGraphqlFailureMapping(t *testing.T) {
	failure := graphqlFailure(badRequest("Invalid email target"))
	if failure == nil || !strings.Contains(failure.Error(), "Invalid email target") {
		t.Fatalf("bad request mapping: %v", failure)
	}
	plain := errors.New("Alert channel not found for this org")
	if got := graphqlFailure(plain); got != plain {
		t.Fatalf("ordinary error remapped: %v", got)
	}
	if graphqlFailure(nil) != nil {
		t.Fatal("nil error remapped")
	}
}

func stringPtrForTest(value string) *string {
	return &value
}

func intPtrForTest(value int) *int {
	return &value
}

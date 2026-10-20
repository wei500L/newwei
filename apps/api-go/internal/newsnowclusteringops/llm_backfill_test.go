package newsnowclusteringops

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func stringPtr(value string) *string { return &value }

func floatPtr(value float64) *float64 { return &value }

func TestBuildLlmBackfillUserPromptMatchesNestJS(t *testing.T) {
	signal := newsSignal{
		ProcessedArticleID: "art-1",
		Timestamp:          time.Date(2026, 10, 20, 0, 6, 0, 0, time.UTC),
		Language:           stringPtr("zh"),
		Title:              stringPtr("Title"),
		Summary:            stringPtr("Summary"),
		Topics:             []string{"politics", "finance"},
		Entities: []clusteringFailureEntityDoc{
			{Name: "Acme", Type: stringPtr("org"), Confidence: floatPtr(0.9)},
			{Name: "Bob"},
			{Name: ""},
		},
	}
	candidates := []AssignmentCandidate{
		{
			EventID:      "event-1",
			Score:        0.9166666,
			MatchOrigin:  "hybrid",
			Title:        stringPtr("Event title"),
			Language:     stringPtr("en"),
			LastAt:       time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC),
			ItemCount:    3,
			PrimaryTopic: stringPtr("politics"),
		},
		{
			EventID:     "event-2",
			Score:       0.5,
			MatchOrigin: "overlap",
			LastAt:      time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC),
		},
	}
	want := strings.Join([]string{
		"Article:",
		"- Title: Title",
		"- Summary: Summary",
		"- Language: zh",
		"- Timestamp: 2026-10-20T00:06:00.000Z",
		"- Topics: politics, finance",
		"- Entities: Acme (org), Bob (unknown), unknown (unknown)",
		"",
		"Candidate events:",
		"1. Event event-1",
		"   - Score: 0.917 (hybrid)",
		"   - Title: Event title",
		"   - Summary: -",
		"   - Language: en",
		"   - Primary topic: politics",
		"   - Primary entity: -",
		"   - Last seen: 2026-10-19T12:00:00.000Z",
		"   - Items: 3",
		"2. Event event-2",
		"   - Score: 0.500 (overlap)",
		"   - Title: -",
		"   - Summary: -",
		"   - Language: -",
		"   - Primary topic: -",
		"   - Primary entity: -",
		"   - Last seen: 2026-10-18T12:00:00.000Z",
		"   - Items: 0",
		"",
		"Return JSON using this shape:",
		`{"action":"assign_existing"|"create_new","eventId":"<candidate event id or null>","confidence":0.0-1.0,"reasoning":"short explanation"}`,
	}, "\n")
	if got := buildLlmBackfillUserPrompt(signal, candidates); got != want {
		t.Fatalf("prompt mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestBuildLlmBackfillUserPromptEmptyFields(t *testing.T) {
	signal := newsSignal{ProcessedArticleID: "art", Timestamp: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	prompt := buildLlmBackfillUserPrompt(signal, nil)
	if !strings.Contains(prompt, "- Title: -\n") ||
		!strings.Contains(prompt, "- Summary: -\n") ||
		!strings.Contains(prompt, "- Language: -\n") ||
		!strings.Contains(prompt, "- Topics: -\n") ||
		!strings.Contains(prompt, "- Entities: -\n") {
		t.Fatalf("empty prompt = %s", prompt)
	}
	if !strings.Contains(prompt, "Candidate events:\n\nReturn JSON") {
		t.Fatalf("no-candidate prompt = %s", prompt)
	}
}

func TestFormatLlmBackfillEntitiesCapsAtEight(t *testing.T) {
	entities := make([]clusteringFailureEntityDoc, 0, 10)
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"} {
		entities = append(entities, clusteringFailureEntityDoc{Name: name, Type: stringPtr("person")})
	}
	got := formatLlmBackfillEntities(entities)
	want := "a (person), b (person), c (person), d (person), e (person), f (person), g (person), h (person)"
	if got != want {
		t.Fatalf("entities = %q", got)
	}
	if got := formatLlmBackfillEntities(nil); got != "-" {
		t.Fatalf("nil entities = %q", got)
	}
}

func TestBuildSignalFingerprint(t *testing.T) {
	signal := newsSignal{
		ProcessedArticleID: "art-1",
		Title:              stringPtr("Title"),
		Summary:            stringPtr("Summary"),
	}
	if got := buildSignalFingerprint(signal); got != "e4b6a01a6acce0af" {
		t.Fatalf("fingerprint = %q", got)
	}
	// A missing title and summary hash as the empty string, like undefined ?? "".
	empty := newsSignal{ProcessedArticleID: "art-1"}
	if got := buildSignalFingerprint(empty); got != "5ce4a3d32626abcb" {
		t.Fatalf("empty fingerprint = %q", got)
	}
}

func TestValidateLlmBackfillDecision(t *testing.T) {
	valid := []string{
		`{"action":"create_new"}`,
		`{"action":"assign_existing","eventId":"event-1","confidence":0.8,"reasoning":"match"}`,
		`{"action":"assign_existing","eventId":null,"confidence":null,"reasoning":null}`,
		`{"action":"create_new","extra":"ignored"}`,
		`{"action":"assign_existing","eventId":"  event-1  "}`,
	}
	for _, raw := range valid {
		if _, ok := validateLlmBackfillDecision([]byte(raw)); !ok {
			t.Fatalf("expected valid: %s", raw)
		}
	}
	invalid := []string{
		`null`,
		`[]`,
		`{}`,
		`{"action":null}`,
		`{"action":"unknown"}`,
		`{"action":"create_new","eventId":""}`,
		`{"action":"create_new","eventId":"   "}`,
		`{"action":"create_new","eventId":123}`,
		`{"action":"create_new","confidence":1.1}`,
		`{"action":"create_new","confidence":-0.1}`,
		`{"action":"create_new","confidence":"0.5"}`,
		`{"action":"create_new","reasoning":"` + strings.Repeat("x", 501) + `"}`,
		`{"action":"create_new","eventId":"` + strings.Repeat("x", 65) + `"}`,
	}
	for _, raw := range invalid {
		if _, ok := validateLlmBackfillDecision([]byte(raw)); ok {
			t.Fatalf("expected invalid: %s", raw)
		}
	}
}

func TestValidateLlmBackfillDecisionTrimsAndKeepsOptionalFields(t *testing.T) {
	raw := `{"action":"assign_existing","eventId":"  event-1  ","confidence":1,"reasoning":"  why  "}`
	decision, ok := validateLlmBackfillDecision([]byte(raw))
	if !ok {
		t.Fatal("decision rejected")
	}
	if decision.Action != "assign_existing" {
		t.Fatalf("action = %q", decision.Action)
	}
	if decision.EventID == nil || *decision.EventID != "event-1" {
		t.Fatalf("eventId = %v", decision.EventID)
	}
	if decision.Confidence == nil || *decision.Confidence != 1 {
		t.Fatalf("confidence = %v", decision.Confidence)
	}
	if decision.Reasoning == nil || *decision.Reasoning != "why" {
		t.Fatalf("reasoning = %v", decision.Reasoning)
	}
}

func TestSafeJSONParseFromText(t *testing.T) {
	fenced := "```json\n{\"action\":\"create_new\"}\n```"
	raw, ok := safeJSONParseFromText(fenced)
	if !ok {
		t.Fatal("fenced JSON rejected")
	}
	var probe struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Action != "create_new" {
		t.Fatalf("decoded = %+v err=%v", probe, err)
	}

	prefixed := "Here is the answer: {\"action\":\"create_new\"} thanks"
	if raw, ok := safeJSONParseFromText(prefixed); !ok || string(raw) != `{"action":"create_new"}` {
		t.Fatalf("prefixed parse = %q ok=%t", raw, ok)
	}

	if _, ok := safeJSONParseFromText("no json here"); ok {
		t.Fatal("expected failure without JSON")
	}
	if _, ok := safeJSONParseFromText(`{"action":`); ok {
		t.Fatal("expected failure for unbalanced JSON")
	}
}

func TestStaleGroupEligible(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	olderThan := now.Add(-LlmBackfillRetryAfter)
	old := olderThan.Add(-time.Second)
	recent := olderThan.Add(time.Second)
	processing := clusteringFailureDoc{Status: ClusteringFailureStatusProcessing, LastAttemptAt: &old}
	if !staleGroupEligible(processing, olderThan) {
		t.Fatal("old processing group should be eligible")
	}
	if staleGroupEligible(clusteringFailureDoc{Status: ClusteringFailureStatusProcessing, LastAttemptAt: &recent}, olderThan) {
		t.Fatal("recent processing group must not be eligible")
	}
	if staleGroupEligible(clusteringFailureDoc{Status: ClusteringFailureStatusProcessing}, olderThan) {
		t.Fatal("a group without lastAttemptAt must not be eligible")
	}
	if staleGroupEligible(clusteringFailureDoc{Status: ClusteringFailureStatusPending, LastAttemptAt: &old}, olderThan) {
		t.Fatal("a pending group must not be recovered by R1")
	}
}

func TestProjectAssignmentCandidatesMergesOriginsAndSorts(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	state := map[string]*candidateScore{
		"hybrid":  {vector: floatPtr(0.6), overlap: floatPtr(0.8)},
		"vector":  {vector: floatPtr(0.9)},
		"overlap": {overlap: floatPtr(0.5)},
	}
	events := []newsEventCandidateDetail{
		{ID: "hybrid", LastAt: now.Add(-time.Hour), Title: stringPtr("hybrid")},
		{ID: "vector", LastAt: now.Add(-2 * time.Hour)},
		{ID: "overlap", LastAt: now.Add(-3 * time.Hour)},
		{ID: "unscored", LastAt: now},
	}
	candidates := projectAssignmentCandidates(state, events, 6)
	if len(candidates) != 3 {
		t.Fatalf("candidates = %d", len(candidates))
	}
	if candidates[0].EventID != "vector" || candidates[0].Score != 0.9 || candidates[0].MatchOrigin != "vector" {
		t.Fatalf("first = %+v", candidates[0])
	}
	if candidates[1].EventID != "hybrid" || candidates[1].Score != 0.8 || candidates[1].MatchOrigin != "hybrid" {
		t.Fatalf("second = %+v", candidates[1])
	}
	if candidates[2].EventID != "overlap" || candidates[2].Score != 0.5 || candidates[2].MatchOrigin != "overlap" {
		t.Fatalf("third = %+v", candidates[2])
	}
	if got := projectAssignmentCandidates(state, events, 1); len(got) != 1 || got[0].EventID != "vector" {
		t.Fatalf("limit = %+v", got)
	}
}

func TestProjectAssignmentCandidatesBreaksTiesByLastAt(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	state := map[string]*candidateScore{
		"old": {overlap: floatPtr(0.7)},
		"new": {overlap: floatPtr(0.7)},
	}
	events := []newsEventCandidateDetail{
		{ID: "old", LastAt: now.Add(-2 * time.Hour)},
		{ID: "new", LastAt: now.Add(-time.Hour)},
	}
	candidates := projectAssignmentCandidates(state, events, 6)
	if candidates[0].EventID != "new" || candidates[1].EventID != "old" {
		t.Fatalf("tie order = %+v", candidates)
	}
}

func TestNewLlmBackfillJobIDShape(t *testing.T) {
	id, err := newLlmBackfillJobID("group-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(id, "news-event-llm-backfill:group-1:") {
		t.Fatalf("job id = %q", id)
	}
	suffix := strings.TrimPrefix(id, "news-event-llm-backfill:group-1:")
	if len(suffix) != 36 || suffix[8] != '-' || suffix[13] != '-' || suffix[18] != '-' || suffix[23] != '-' {
		t.Fatalf("uuid = %q", suffix)
	}
	if suffix[14] != '4' {
		t.Fatalf("uuid version = %q", suffix)
	}
}

func TestLlmBackfillJobJSONMatchesNestPayload(t *testing.T) {
	job := LlmBackfillJob{
		JobType: LlmBackfillJobType,
		OrgID:   "org-1",
		ActorID: "user-1",
		GroupID: "group-1",
		TraceID: "trace-1",
		Trigger: "manual",
	}
	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"jobType", "orgId", "actorId", "groupId", "traceId", "trigger"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("missing key %q in %s", key, encoded)
		}
	}
	if len(fields) != 6 {
		t.Fatalf("unexpected keys: %s", encoded)
	}
}

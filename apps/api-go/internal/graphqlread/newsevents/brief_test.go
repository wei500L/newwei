package newsevents

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func briefStrptr(value string) *string { return &value }

func TestNormalizeLanguage(t *testing.T) {
	cases := map[string]string{
		"":          "zh",
		"   ":       "zh",
		"zh-CN":     "zh",
		"ZH":        "zh",
		"en-US":     "en",
		"EN":        "en",
		"fr":        "fr",
		"abcdefgh":  "abcdefgh",
		"abcdefghi": "zh",
	}
	for input, want := range cases {
		if got := normalizeLanguage(input); got != want {
			t.Errorf("normalizeLanguage(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestBriefFingerprintMatchesNestStringify(t *testing.T) {
	got := briefFingerprint("zh", time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC), []briefSource{{
		URL:                "https://example.com/a?x=1&y=2",
		ProcessedArticleID: briefStrptr("pa1"),
	}})
	wantJSON := `{"version":1,"language":"zh","lastAt":"2026-09-27T12:00:00.000Z","sources":[{"processedArticleId":"pa1","processedItemId":null,"url":"https://example.com/a?x=1&y=2"}]}`
	sum := sha256.Sum256([]byte(wantJSON))
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("fingerprint = %s", got)
	}
}

func TestSelectBriefSourcesCarriesSummaryAndKeyPoints(t *testing.T) {
	published := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	items := []itemRow{{
		URL:                "https://a.example/1",
		SourceLabel:        briefStrptr("Alpha"),
		Title:              briefStrptr("Title"),
		Summary:            briefStrptr("Summary"),
		PublishedAt:        &published,
		ProcessedArticleID: "pa1",
		KeyPoints:          json.RawMessage(`[" one ","one","","two",3]`),
	}}
	sources := selectBriefSources(items, 10)
	if len(sources) != 1 {
		t.Fatalf("sources = %+v", sources)
	}
	if sources[0].Summary == nil || *sources[0].Summary != "Summary" {
		t.Fatalf("summary = %v", sources[0].Summary)
	}
	if strings.Join(sources[0].KeyPoints, "|") != "one|two" {
		t.Fatalf("keyPoints = %#v", sources[0].KeyPoints)
	}
	if sources[0].Index != 1 {
		t.Fatalf("index = %d", sources[0].Index)
	}
}

func TestValidateBriefPayloadSchemaBounds(t *testing.T) {
	valid := `{"detailed_summary":"D","tldr":"T","key_points":[{"text":"a","citations":[1,2]}],"why_it_matters":[],"what_to_watch":[],"latest_update":null,"comparison":null,"limitations":null}`
	payload, ok := validateBriefPayload(json.RawMessage(valid))
	if !ok {
		t.Fatal("valid payload rejected")
	}
	if len(payload.KeyPoints) != 1 || payload.KeyPoints[0].Citations[1] != 2 {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.LatestUpdate != nil || payload.Comparison != nil || payload.Limitations != nil {
		t.Fatalf("nullable leaves = %+v", payload)
	}

	// zod default([]) short-circuits the array bounds, so an absent key_points
	// is valid and becomes an empty list.
	if _, ok := validateBriefPayload(json.RawMessage(`{"detailed_summary":"D","tldr":"T"}`)); !ok {
		t.Fatal("absent key_points must be accepted")
	}
	// A present empty key_points violates min(1).
	if _, ok := validateBriefPayload(json.RawMessage(`{"detailed_summary":"D","tldr":"T","key_points":[]}`)); ok {
		t.Fatal("empty present key_points must be rejected")
	}
	// Missing required leaves.
	if _, ok := validateBriefPayload(json.RawMessage(`{"tldr":"T"}`)); ok {
		t.Fatal("missing detailed_summary must be rejected")
	}
	if _, ok := validateBriefPayload(json.RawMessage(`{"detailed_summary":"D"}`)); ok {
		t.Fatal("missing tldr must be rejected")
	}
	// Non-integer, zero and over-long citation lists are rejected by zod.
	invalidCitations := []string{
		`{"detailed_summary":"D","tldr":"T","key_points":[{"text":"a","citations":[1.5]}]}`,
		`{"detailed_summary":"D","tldr":"T","key_points":[{"text":"a","citations":[0]}]}`,
		`{"detailed_summary":"D","tldr":"T","key_points":[{"text":"a","citations":[1,2,3,4,5,6,7,8,9,10,11,12,13]}]}`,
	}
	for _, raw := range invalidCitations {
		if _, ok := validateBriefPayload(json.RawMessage(raw)); ok {
			t.Fatalf("invalid citations accepted: %s", raw)
		}
	}
	// Eleven key_points exceed max(10).
	if _, ok := validateBriefPayload(json.RawMessage(`{"detailed_summary":"D","tldr":"T","key_points":[{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"},{"text":"e"},{"text":"f"},{"text":"g"},{"text":"h"},{"text":"i"},{"text":"j"},{"text":"k"}]}`)); ok {
		t.Fatal("over-long key_points must be rejected")
	}
}

func TestSanitizePayloadKeepsBlankLatestUpdate(t *testing.T) {
	payload := briefPayload{
		DetailedSummary: " D ",
		Tldr:            " T ",
		KeyPoints:       []briefPoint{{Text: " a ", Citations: []int{1}}},
		LatestUpdate:    &briefPoint{Text: "   ", Citations: []int{1}},
	}
	out := sanitizePayload(payload, 3)
	if out.DetailedSummary != "D" || out.Tldr != "T" {
		t.Fatalf("trim = %+v", out)
	}
	if out.KeyPoints[0].Text != "a" {
		t.Fatalf("point text = %q", out.KeyPoints[0].Text)
	}
	if out.LatestUpdate == nil || out.LatestUpdate.Text != "" {
		t.Fatalf("latest_update = %+v", out.LatestUpdate)
	}
}

func TestSanitizeCitationsFiltersThenCapsThenDedupes(t *testing.T) {
	citations := []int{1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2}
	out := sanitizePoint(briefPoint{Text: "x", Citations: citations}, 3)
	if len(out.Citations) != 1 || out.Citations[0] != 1 {
		t.Fatalf("citations = %#v (slice must run before dedupe)", out.Citations)
	}
	// Out-of-range indexes are removed before the cap.
	out = sanitizePoint(briefPoint{Text: "x", Citations: []int{9, 3, 2}}, 3)
	if len(out.Citations) != 2 || out.Citations[0] != 2 || out.Citations[1] != 3 {
		t.Fatalf("citations = %#v", out.Citations)
	}
}

func TestMapPointsKeepsEmptyCitationSlice(t *testing.T) {
	points := mapPoints([]briefPoint{{Text: "a"}})
	if points[0].Citations == nil || len(points[0].Citations) != 0 {
		t.Fatalf("citations = %#v", points[0].Citations)
	}
}

func TestBriefUserPromptUsesSummaryAndKeyPoints(t *testing.T) {
	published := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	sources := []briefSource{{
		Index:       1,
		URL:         "https://a.example/1",
		SourceLabel: briefStrptr("Alpha"),
		Title:       briefStrptr("Title"),
		Summary:     briefStrptr("Source summary"),
		KeyPoints:   []string{"k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"},
		PublishedAt: &published,
	}}
	prompt := briefUserPrompt(briefEvent{
		Title:   "Event title",
		Summary: briefStrptr("Event summary"),
		StartAt: published,
		LastAt:  published,
	}, sources)
	if !strings.Contains(prompt, "eventSummary: Event summary") {
		t.Fatalf("prompt missing event summary:\n%s", prompt)
	}
	if !strings.Contains(prompt, "summary: Source summary") {
		t.Fatalf("prompt missing source summary:\n%s", prompt)
	}
	if !strings.Contains(prompt, "key_points: k1 | k2 | k3 | k4 | k5 | k6 | k7 | k8") {
		t.Fatalf("prompt key_points = %s", prompt)
	}
	if strings.Contains(prompt, "k9") {
		t.Fatalf("prompt must use only the first eight key points:\n%s", prompt)
	}
	if !strings.Contains(prompt, "time: 2026-09-27T12:00:00.000Z") {
		t.Fatalf("prompt time = %s", prompt)
	}
}

func TestTruncateUTF16UsesCodeUnits(t *testing.T) {
	if got := truncateUTF16("😀😀", 3); got != "😀…" {
		t.Fatalf("truncateUTF16 = %q", got)
	}
	if got := truncateUTF16("hello", 10); got != "hello" {
		t.Fatalf("truncateUTF16 = %q", got)
	}
	if got := truncateUTF16("hello world", 6); got != "hello…" {
		t.Fatalf("truncateUTF16 = %q", got)
	}
}

func TestBriefEventTitleUsesNullishSemantics(t *testing.T) {
	empty := ""
	entity := "entity"
	row := &eventRow{ID: "e1", Title: &empty, PrimaryEntity: &entity}
	if got := briefEventTitle(row); got != "" {
		t.Fatalf("title = %q, want the present empty title", got)
	}
	row = &eventRow{ID: "e1", PrimaryEntity: &entity}
	if got := briefEventTitle(row); got != "entity" {
		t.Fatalf("title = %q", got)
	}
}

func TestExtractBriefJSONHandlesCodeFenceAndProse(t *testing.T) {
	fenced := "```json\n{\"detailed_summary\":\"D\"}\n```"
	raw, ok := extractBriefJSON(fenced)
	if !ok || string(raw) != `{"detailed_summary":"D"}` {
		t.Fatalf("fenced = %s ok=%v", raw, ok)
	}
	prose, ok := extractBriefJSON("Here you go: {\"a\":1} thanks")
	if !ok || string(prose) != `{"a":1}` {
		t.Fatalf("prose = %s ok=%v", prose, ok)
	}
	if _, ok := extractBriefJSON("no json here"); ok {
		t.Fatal("plain text must not parse")
	}
}

func TestReadCachedBriefKeepsEmptyKeyPoints(t *testing.T) {
	document := `{"briefV1":{"version":1,"language":"zh","fingerprint":"fp","generatedAt":"2026-09-27T12:00:00.000Z",
		"sources":[{"index":1,"url":"https://a.example/1"}],
		"payload":{"detailed_summary":"D","tldr":"T","key_points":[]}}}`
	cached := readCachedBrief(json.RawMessage(document))
	if cached == nil {
		t.Fatal("cache with an empty key_points list must stay readable")
	}
	if cached.Language != "zh" || cached.Fingerprint != "fp" || len(cached.Sources) != 1 {
		t.Fatalf("cached = %+v", cached)
	}
	if cached.GeneratedAt.IsZero() {
		t.Fatal("generatedAt")
	}
}

func TestRegisterWithoutBriefRegistersFiveRoots(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, nil, nil, nil, Options{})
	if _, ok := reg.Query("newsEventBrief"); ok {
		t.Fatal("newsEventBrief must stay unregistered while the brief switch is legacy")
	}
	for _, name := range []string{"newsEvents", "newsEvent", "newsEventReferencedArticles", "topicGroups", "eventGroups"} {
		if _, ok := reg.Query(name); !ok {
			t.Fatalf("%s must stay registered", name)
		}
	}
}

func TestRegisterWithBriefRegistersSixRoots(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, nil, nil, nil, Options{BriefEnabled: true})
	for _, name := range []string{"newsEventBrief", "newsEvents", "newsEvent", "newsEventReferencedArticles", "topicGroups", "eventGroups"} {
		if _, ok := reg.Query(name); !ok {
			t.Fatalf("%s must be registered", name)
		}
	}
	if !reg.HasType("NewsEventBriefModel") {
		t.Fatal("NewsEventBriefModel type must be registered")
	}
}

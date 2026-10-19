package crawlstrategyruns

import (
	"strings"
	"testing"
)

func TestValidateTrialRunAcceptsTheDtoFields(t *testing.T) {
	body := []byte(`{
	  "workflowVersionId": "ver-1",
	  "profileId": "profile-1",
	  "newsSourceId": "source-1",
	  "seedUrl": "https://example.com/feed",
	  "runKind": "profile_preview",
	  "maxCandidates": 42,
	  "runtimeOverrides": {"maxDepth": 2}
	}`)
	input, err := validateTrialRun(body)
	if err != nil {
		t.Fatalf("validateTrialRun: %v", err)
	}
	if input.WorkflowVersionID == nil || *input.WorkflowVersionID != "ver-1" {
		t.Errorf("workflowVersionId = %v", input.WorkflowVersionID)
	}
	if input.ProfileID == nil || *input.ProfileID != "profile-1" {
		t.Errorf("profileId = %v", input.ProfileID)
	}
	if input.NewsSourceID == nil || *input.NewsSourceID != "source-1" {
		t.Errorf("newsSourceId = %v", input.NewsSourceID)
	}
	if input.SeedURL == nil || *input.SeedURL != "https://example.com/feed" {
		t.Errorf("seedUrl = %v", input.SeedURL)
	}
	if input.RunKind == nil || *input.RunKind != "profile_preview" {
		t.Errorf("runKind = %v", input.RunKind)
	}
	if input.MaxCandidates == nil || *input.MaxCandidates != 42 {
		t.Errorf("maxCandidates = %v", input.MaxCandidates)
	}
	if string(input.RuntimeOverrides) != `{"maxDepth": 2}` {
		t.Errorf("runtimeOverrides = %s", input.RuntimeOverrides)
	}
}

func TestValidateTrialRunMessagesMirrorClassValidator(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"unknown", `{"unknownField":1}`, "property unknownField should not exist"},
		{"string", `{"profileId":5}`, "profileId must be a string"},
		{"maxlength", `{"newsSourceId":"` + strings.Repeat("x", 192) + `"}`, "newsSourceId must be shorter than or equal to 191 characters"},
		{"url", `{"seedUrl":"example.com/feed"}`, "seedUrl must be a URL address"},
		{"url-scheme", `{"seedUrl":"ftp://example.com/feed"}`, "seedUrl must be a URL address"},
		{"runkind", `{"runKind":"frontier_run"}`, "runKind must be one of the following values: trial, profile_preview, news_source_preview, frontier_compile"},
		{"int", `{"maxCandidates":1.5}`, "maxCandidates must be an integer number"},
		{"min", `{"maxCandidates":0}`, "maxCandidates must not be less than 1"},
		{"max", `{"maxCandidates":501}`, "maxCandidates must not be greater than 500"},
		{"object", `{"runtimeOverrides":[]}`, "runtimeOverrides must be an object"},
	}
	for _, entry := range cases {
		t.Run(entry.name, func(t *testing.T) {
			_, err := validateTrialRun([]byte(entry.body))
			if err == nil {
				t.Fatalf("expected an error")
			}
			if err.Error() != entry.want {
				t.Fatalf("message = %q, want %q", err.Error(), entry.want)
			}
		})
	}
}

func TestValidateTrialRunCollectsEveryMessageInDtoOrder(t *testing.T) {
	body := []byte(`{"profileId":5,"maxCandidates":0}`)
	_, err := validateTrialRun(body)
	if err == nil {
		t.Fatal("expected an error")
	}
	want := "profileId must be a string; maxCandidates must not be less than 1"
	if err.Error() != want {
		t.Fatalf("message = %q, want %q", err.Error(), want)
	}
}

func TestValidateReplayAcceptsEmptyBodyAndOverrides(t *testing.T) {
	input, err := validateReplay([]byte(`{}`))
	if err != nil {
		t.Fatalf("empty body: %v", err)
	}
	if input.SeedURL != nil || input.ProfileID != nil || input.NewsSourceID != nil || input.MaxCandidates != nil {
		t.Fatalf("empty body produced overrides: %+v", input)
	}
	input, err = validateReplay([]byte(`{"seedUrl":"https://example.com/x","maxCandidates":7}`))
	if err != nil {
		t.Fatalf("overrides: %v", err)
	}
	if input.SeedURL == nil || *input.SeedURL != "https://example.com/x" {
		t.Errorf("seedUrl = %v", input.SeedURL)
	}
	if input.MaxCandidates == nil || *input.MaxCandidates != 7 {
		t.Errorf("maxCandidates = %v", input.MaxCandidates)
	}
	if _, err := validateReplay([]byte(`{"runKind":"trial"}`)); err == nil || err.Error() != "property runKind should not exist" {
		t.Fatalf("runKind must be rejected for replay: %v", err)
	}
}

func TestParseFieldsTreatsNonObjectAsEmpty(t *testing.T) {
	fields, err := parseFields([]byte(`[1,2,3]`))
	if err != nil {
		t.Fatalf("non-object body: %v", err)
	}
	if len(fields) != 0 {
		t.Fatalf("fields = %+v", fields)
	}
	if _, err := parseFields([]byte(`{bad`)); err == nil {
		t.Fatal("invalid JSON must fail")
	}
}

func TestSingleSegmentRouteParsing(t *testing.T) {
	cases := []struct {
		path   string
		prefix string
		wantID string
		wantOK bool
	}{
		{"/api/admin/news-sources/src-1/preview", "/api/admin/news-sources/", "", false},
		// The caller trims the action suffix first, mirroring ServeHTTP.
		{"/api/admin/news-sources/src-1", "/api/admin/news-sources/", "src-1", true},
		{"/api/admin/news-sources/a/b", "/api/admin/news-sources/", "", false},
		{"/api/admin/news-sources/", "/api/admin/news-sources/", "", false},
	}
	for _, entry := range cases {
		id, ok := singleSegment(entry.path, entry.prefix)
		if ok != entry.wantOK {
			t.Errorf("singleSegment(%q) ok = %v", entry.path, ok)
			continue
		}
		if ok && id != entry.wantID {
			t.Errorf("singleSegment(%q) = %q", entry.path, id)
		}
	}
}

func TestOnlyTrialKindsAreAccepted(t *testing.T) {
	if !containsString(trialRunKinds, RunKindTrial) || !containsString(trialRunKinds, RunKindFrontierCompile) {
		t.Fatalf("trialRunKinds = %v", trialRunKinds)
	}
	if containsString(trialRunKinds, RunKindFrontierRun) {
		t.Fatal("frontier_run must stay out of the DTO enum")
	}
}

func TestIsAbsoluteHTTPURLMatchesIsUrl(t *testing.T) {
	for _, value := range []string{"https://example.com/x", "http://example.com"} {
		if !isAbsoluteHTTPURL(value) {
			t.Errorf("%q must be accepted", value)
		}
	}
	for _, value := range []string{"example.com", " https://example.com", "ftp://example.com", "https://", "/relative"} {
		if isAbsoluteHTTPURL(value) {
			t.Errorf("%q must be rejected", value)
		}
	}
}

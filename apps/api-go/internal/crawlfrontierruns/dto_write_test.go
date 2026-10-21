package crawlfrontierruns

import (
	"errors"
	"strings"
	"testing"
)

// validateCreateRunJSON runs the body through the same parse + validate pair the
// handler uses.
func validateCreateRunJSON(t *testing.T, body string) (createRunInput, string) {
	t.Helper()
	fields, err := parseObjectBody([]byte(body))
	if err != nil {
		return createRunInput{}, errMessage(t, err)
	}
	input, err := validateCreateRunBody(fields)
	if err != nil {
		return createRunInput{}, errMessage(t, err)
	}
	return input, ""
}

// errMessage unwraps the class-validator style message.
func errMessage(t *testing.T, err error) string {
	t.Helper()
	var input *inputError
	if !errors.As(err, &input) {
		t.Fatalf("error %v is not an inputError", err)
	}
	return input.Message
}

// TestValidateCreateRunAccepts covers the valid shapes: every field present, the
// optional ones omitted, and the @Type(() => Number) string forms.
func TestValidateCreateRunAccepts(t *testing.T) {
	input, message := validateCreateRunJSON(t, `{
		"seedUrl": "https://example.com/a",
		"profileId": "profile-1",
		"executionMode": "native",
		"maxDepth": 4,
		"maxPages": "120",
		"keywords": ["alpha", "Beta", "alpha"]
	}`)
	if message != "" {
		t.Fatalf("unexpected 400: %s", message)
	}
	if input.SeedURL != "https://example.com/a" {
		t.Fatalf("SeedURL = %q", input.SeedURL)
	}
	if input.ProfileID == nil || *input.ProfileID != "profile-1" {
		t.Fatalf("ProfileID = %v", input.ProfileID)
	}
	if input.ExecutionMode == nil || *input.ExecutionMode != "native" {
		t.Fatalf("ExecutionMode = %v", input.ExecutionMode)
	}
	if input.MaxDepth == nil || *input.MaxDepth != 4 {
		t.Fatalf("MaxDepth = %v", input.MaxDepth)
	}
	if input.MaxPages == nil || *input.MaxPages != 120 {
		t.Fatalf("MaxPages = %v", input.MaxPages)
	}
	if len(input.Keywords) != 3 || input.Keywords[1] != "Beta" {
		t.Fatalf("Keywords = %v", input.Keywords)
	}

	minimal, message := validateCreateRunJSON(t, `{"seedUrl":"http://localhost:3000"}`)
	if message != "" {
		t.Fatalf("unexpected 400 for the minimal body: %s", message)
	}
	if minimal.ProfileID != nil || minimal.ExecutionMode != nil || minimal.MaxDepth != nil ||
		minimal.MaxPages != nil || minimal.Keywords != nil {
		t.Fatalf("optional fields should stay nil: %+v", minimal)
	}

	// null is @IsOptional's other "absent" spelling.
	nulls, message := validateCreateRunJSON(t, `{"seedUrl":"https://example.com","profileId":null,
		"executionMode":null,"maxDepth":null,"maxPages":null,"keywords":null}`)
	if message != "" {
		t.Fatalf("unexpected 400 for nulls: %s", message)
	}
	if nulls.ProfileID != nil || nulls.MaxDepth != nil || nulls.Keywords != nil {
		t.Fatalf("null optional fields should stay nil: %+v", nulls)
	}
}

// TestValidateCreateRunSeedURL covers the @IsUrl branch, whose accepted range
// differs from the WHATWG serialisation applied afterwards.
func TestValidateCreateRunSeedURL(t *testing.T) {
	accepted := []string{
		"https://example.com/a",
		"http://localhost:3000",
		"http://localhost",
		"ftp://example.com/file",
		"https://例子.测试/路径",
	}
	for _, seed := range accepted {
		body := `{"seedUrl":"` + seed + `"}`
		if _, message := validateCreateRunJSON(t, body); message != "" {
			t.Fatalf("seedUrl %q should be accepted, got %q", seed, message)
		}
	}
	rejected := []string{
		`{}`,                             // required
		`{"seedUrl":null}`,               // not a string
		`{"seedUrl":123}`,                // not a string
		`{"seedUrl":[]}`,                 // not a string
		`{"seedUrl":"example.com/path"}`, // no protocol
		`{"seedUrl":"javascript:alert(1)"}`,
		`{"seedUrl":"not a url"}`,
		`{"seedUrl":"http://exa mple.com"}`,
	}
	for _, body := range rejected {
		_, message := validateCreateRunJSON(t, body)
		if message != "seedUrl must be a URL address" {
			t.Fatalf("body %s gave %q, want the IsUrl message", body, message)
		}
	}
}

// TestValidateCreateRunOptionalFields covers the per-field constraint messages
// and their order (reverse decorator order, class declaration order).
func TestValidateCreateRunOptionalFields(t *testing.T) {
	long := strings.Repeat("a", 192)
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "profileId too long is checked before IsString",
			body: `{"seedUrl":"https://example.com","profileId":"` + long + `"}`,
			want: "profileId must be shorter than or equal to 191 characters",
		},
		{
			name: "profileId non string reports MaxLength then IsString",
			body: `{"seedUrl":"https://example.com","profileId":5}`,
			want: "profileId must be shorter than or equal to 191 characters; profileId must be a string",
		},
		{
			name: "executionMode out of range",
			body: `{"seedUrl":"https://example.com","executionMode":"deep"}`,
			want: "executionMode must be one of the following values: layered, native, hybrid",
		},
		{
			name: "executionMode non string reports IsIn then IsString",
			body: `{"seedUrl":"https://example.com","executionMode":7}`,
			want: "executionMode must be one of the following values: layered, native, hybrid; executionMode must be a string",
		},
		{
			name: "maxDepth NaN reports Max, Min, IsInt",
			body: `{"seedUrl":"https://example.com","maxDepth":"abc"}`,
			want: "maxDepth must not be greater than 8; maxDepth must not be less than 1; maxDepth must be an integer number",
		},
		{
			name: "maxDepth empty string is Number 0 and only fails Min",
			body: `{"seedUrl":"https://example.com","maxDepth":""}`,
			want: "maxDepth must not be less than 1",
		},
		{
			name: "maxDepth zero fails Min",
			body: `{"seedUrl":"https://example.com","maxDepth":0}`,
			want: "maxDepth must not be less than 1",
		},
		{
			name: "maxDepth above the cap",
			body: `{"seedUrl":"https://example.com","maxDepth":9}`,
			want: "maxDepth must not be greater than 8",
		},
		{
			name: "maxDepth fractional fails IsInt",
			body: `{"seedUrl":"https://example.com","maxDepth":3.5}`,
			want: "maxDepth must be an integer number",
		},
		{
			name: "maxPages above the cap",
			body: `{"seedUrl":"https://example.com","maxPages":501}`,
			want: "maxPages must not be greater than 500",
		},
		{
			name: "maxPages NaN reports all three",
			body: `{"seedUrl":"https://example.com","maxPages":{}}`,
			want: "maxPages must not be greater than 500; maxPages must not be less than 1; maxPages must be an integer number",
		},
		{
			name: "keywords plain string only fails IsArray",
			body: `{"seedUrl":"https://example.com","keywords":"alpha"}`,
			want: "keywords must be an array",
		},
		{
			name: "keywords non string value fails both",
			body: `{"seedUrl":"https://example.com","keywords":3}`,
			want: "each value in keywords must be a string; keywords must be an array",
		},
		{
			name: "keywords with a non string element",
			body: `{"seedUrl":"https://example.com","keywords":["alpha",2]}`,
			want: "each value in keywords must be a string",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, message := validateCreateRunJSON(t, testCase.body); message != testCase.want {
				t.Fatalf("got %q, want %q", message, testCase.want)
			}
		})
	}
}

// TestValidateCreateRunNumberCoercion pins the @Type(() => Number) boundary the
// audit listed: "3.0", " 3 " and "3" are the same integer, while "" is 0.
func TestValidateCreateRunNumberCoercion(t *testing.T) {
	cases := map[string]float64{
		"3":     3,
		"3.0":   3,
		`" 3 "`: 3,
		`"0x3"`: 3,
		"true":  1,
	}
	for literal, want := range cases {
		body := `{"seedUrl":"https://example.com","maxDepth":` + literal + `}`
		input, message := validateCreateRunJSON(t, body)
		if message != "" {
			t.Fatalf("maxDepth %s gave %q", literal, message)
		}
		if input.MaxDepth == nil || *input.MaxDepth != want {
			t.Fatalf("maxDepth %s = %v, want %v", literal, input.MaxDepth, want)
		}
	}
}

// TestValidateCreateRunUnknownField covers the whitelist pass, which the
// ValidationPipe reports before the field constraints.
func TestValidateCreateRunUnknownField(t *testing.T) {
	_, message := validateCreateRunJSON(t,
		`{"seedUrl":"not a url","extra":1,"another":2}`)
	want := "property extra should not exist; property another should not exist; seedUrl must be a URL address"
	if message != want {
		t.Fatalf("got %q, want %q", message, want)
	}
}

// TestValidateBulkBodyIds covers BulkCrawlFrontierIdsDto on the retry route: an
// empty array, the 200 cap, a non-string element and the 191 character limit
// (counted on the untrimmed value).
func TestValidateBulkBodyIds(t *testing.T) {
	run := func(body string) ([]string, string) {
		t.Helper()
		fields, err := parseObjectBody([]byte(body))
		if err != nil {
			return nil, errMessage(t, err)
		}
		ids, err := validateBulkBody(fields)
		if err != nil {
			return nil, errMessage(t, err)
		}
		return ids, ""
	}

	if _, message := run(`{"ids":[]}`); message != "ids should not be empty" {
		t.Fatalf("empty array gave %q", message)
	}
	// A missing property fails every constraint, reported bottom-up.
	if _, message := run(`{}`); message != "each value in ids must be shorter than or equal to 191 characters; "+
		"each value in ids must be a string; ids must contain no more than 200 elements; "+
		"ids should not be empty; ids must be an array" {
		t.Fatalf("missing ids gave %q", message)
	}
	over := make([]string, 201)
	for index := range over {
		over[index] = `"node"`
	}
	if _, message := run(`{"ids":[` + strings.Join(over, ",") + `]}`); message != "ids must contain no more than 200 elements" {
		t.Fatalf("201 ids gave %q", message)
	}
	if _, message := run(`{"ids":["a",7]}`); message != "each value in ids must be shorter than or equal to 191 characters; each value in ids must be a string" {
		t.Fatalf("non string element gave %q", message)
	}
	if _, message := run(`{"ids":["` + strings.Repeat("a", 192) + `"]}`); message != "each value in ids must be shorter than or equal to 191 characters" {
		t.Fatalf("192 characters gave %q", message)
	}
	if _, message := run(`{"ids":["` + strings.Repeat("a", 191) + `"]}`); message != "" {
		t.Fatalf("191 characters should pass, got %q", message)
	}
	ids, message := run(`{"ids":[" node-1 ","node-1","node-2"]}`)
	if message != "" {
		t.Fatalf("valid ids gave %q", message)
	}
	if len(ids) != 3 || ids[0] != " node-1 " {
		t.Fatalf("DTO must keep the untrimmed values, got %v", ids)
	}
}

// TestNormalizeRetryIDs covers the service-layer trim, empty filter and dedupe
// the DTO does not perform.
func TestNormalizeRetryIDs(t *testing.T) {
	got := normalizeRetryIDs([]string{" node-2 ", "", "node-1", "  ", "node-2", "node-1"})
	want := []string{"node-2", "node-1"}
	if len(got) != len(want) {
		t.Fatalf("normalizeRetryIDs = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("normalizeRetryIDs = %v, want %v", got, want)
		}
	}
	if len(normalizeRetryIDs([]string{" ", ""})) != 0 {
		t.Fatalf("blank ids should normalize to empty")
	}
}

// TestMergeKeywordList covers Array.from(new Set([...input, ...profile])):
// first occurrence order, case sensitive, no trimming.
func TestMergeKeywordList(t *testing.T) {
	got := mergeKeywordList(
		[]string{"a", "B", "a", " a "},
		[]string{"B", "c", "a"},
	)
	want := []string{"a", "B", " a ", "c"}
	if len(got) != len(want) {
		t.Fatalf("mergeKeywordList = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("mergeKeywordList = %v, want %v", got, want)
		}
	}
	if got := mergeKeywordList(nil, nil); got == nil || len(got) != 0 {
		t.Fatalf("empty merge should be a non-nil empty list, got %v", got)
	}
}

// TestRunStatusIsCancelableIsTheTerminalPredicate pins the B4 decision: the B4
// guard reuses the cancellation protocol's terminal predicate, so completed and
// canceled runs are the only statuses a retry refuses.
func TestRunStatusIsCancelableIsTheTerminalPredicate(t *testing.T) {
	for status, live := range map[RunStatus]bool{
		RunStatusPending:   true,
		RunStatusQueued:    true,
		RunStatusRunning:   true,
		RunStatusFailed:    true,
		RunStatusCompleted: false,
		RunStatusCanceled:  false,
	} {
		if got := runStatusIsCancelable(status); got != live {
			t.Fatalf("runStatusIsCancelable(%q) = %v, want %v", status, got, live)
		}
	}
}

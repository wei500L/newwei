package crawlfrontierruns

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateListQueryAcceptsEveryField(t *testing.T) {
	query, err := validateListQuery("search=abc&profileId=p&status=running&executionMode=layered&runRole=active&failureKind=captcha&warningFlag=ssrf_blocked&seedStrategy=auto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if query.Search == nil || *query.Search != "abc" {
		t.Fatalf("search = %v", query.Search)
	}
	if query.ProfileID == nil || *query.ProfileID != "p" {
		t.Fatalf("profileId = %v", query.ProfileID)
	}
	if query.Status == nil || *query.Status != "running" {
		t.Fatalf("status = %v", query.Status)
	}
	if query.ExecutionMode == nil || *query.ExecutionMode != "layered" {
		t.Fatalf("executionMode = %v", query.ExecutionMode)
	}
	if query.RunRole == nil || *query.RunRole != "active" {
		t.Fatalf("runRole = %v", query.RunRole)
	}
	if query.FailureKind == nil || *query.FailureKind != "captcha" {
		t.Fatalf("failureKind = %v", query.FailureKind)
	}
	if query.WarningFlag == nil || *query.WarningFlag != "ssrf_blocked" {
		t.Fatalf("warningFlag = %v", query.WarningFlag)
	}
	if query.SeedStrategy == nil || *query.SeedStrategy != "auto" {
		t.Fatalf("seedStrategy = %v", query.SeedStrategy)
	}
}

func TestValidateListQueryEmptyValuesAreIgnored(t *testing.T) {
	query, err := validateListQuery("search=&profileId=&runRole=")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if query.Search != nil || query.ProfileID != nil || query.RunRole != nil {
		t.Fatalf("empty values must not create filters: %+v", query)
	}
}

func TestValidateListQueryMessages(t *testing.T) {
	longSearch := strings.Repeat("a", 201)
	cases := []struct {
		name  string
		query string
		want  string
	}{
		{
			name:  "unknown properties keep URL order",
			query: "foo=1&bar=2",
			want:  "property foo should not exist; property bar should not exist",
		},
		{
			name:  "duplicate parameter is an array",
			query: "search=a&search=b",
			want:  "search must be shorter than or equal to 200 characters; search must be a string",
		},
		{
			name:  "bracket notation is an object",
			query: "search[]=a",
			want:  "search must be shorter than or equal to 200 characters; search must be a string",
		},
		{
			name:  "search too long",
			query: "search=" + longSearch,
			want:  "search must be shorter than or equal to 200 characters",
		},
		{
			name:  "invalid status",
			query: "status=nope",
			want:  "status must be one of the following values: pending, queued, running, completed, failed, canceled",
		},
		{
			name:  "whitelist error precedes property errors",
			query: "status=nope&foo=1",
			want:  "property foo should not exist; status must be one of the following values: pending, queued, running, completed, failed, canceled",
		},
		{
			name:  "duplicate enum",
			query: "executionMode=native&executionMode=hybrid",
			want:  "executionMode must be one of the following values: layered, native, hybrid; executionMode must be a string",
		},
		{
			name:  "invalid seed strategy",
			query: "seedStrategy=nope",
			want:  "seedStrategy must be one of the following values: auto, seed_first, frontier_first, frontier_only",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateListQuery(tc.query)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestValidateBulkBodyMessages(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "missing ids",
			body: "{}",
			want: "each value in ids must be shorter than or equal to 191 characters; " +
				"each value in ids must be a string; " +
				"ids must contain no more than 200 elements; " +
				"ids should not be empty; ids must be an array",
		},
		{
			name: "empty array",
			body: `{"ids":[]}`,
			want: "ids should not be empty",
		},
		{
			name: "non string element",
			body: `{"ids":[1]}`,
			want: "each value in ids must be shorter than or equal to 191 characters; each value in ids must be a string",
		},
		{
			name: "too long element",
			body: `{"ids":["` + strings.Repeat("a", 192) + `"]}`,
			want: "each value in ids must be shorter than or equal to 191 characters",
		},
		{
			name: "string body",
			body: `{"ids":"abc"}`,
			want: "ids must contain no more than 200 elements; ids should not be empty; ids must be an array",
		},
		{
			name: "unknown field first",
			body: `{"other":1}`,
			want: "property other should not exist; " +
				"each value in ids must be shorter than or equal to 191 characters; " +
				"each value in ids must be a string; " +
				"ids must contain no more than 200 elements; " +
				"ids should not be empty; ids must be an array",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fields, err := parseObjectBody([]byte(tc.body))
			if err != nil {
				t.Fatalf("parse body: %v", err)
			}
			_, err = validateBulkBody(fields)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestValidateBulkBodyAcceptsArray(t *testing.T) {
	fields, err := parseObjectBody([]byte(`{"ids":["a","b"]}`))
	if err != nil {
		t.Fatalf("parse body: %v", err)
	}
	ids, err := validateBulkBody(fields)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("ids = %v", ids)
	}
}

func TestValidateBulkBodyRejectsTooManyElements(t *testing.T) {
	elements := make([]string, 0, 201)
	for index := 0; index < 201; index++ {
		elements = append(elements, `"id"`)
	}
	body := `{"ids":[` + strings.Join(elements, ",") + `]}`
	fields, err := parseObjectBody([]byte(body))
	if err != nil {
		t.Fatalf("parse body: %v", err)
	}
	_, err = validateBulkBody(fields)
	if err == nil || err.Error() != "ids must contain no more than 200 elements" {
		t.Fatalf("error = %v", err)
	}
}

func TestParseObjectBodyKeepsFirstPositionAndLastValue(t *testing.T) {
	fields, err := parseObjectBody([]byte(`{"ids":["a"],"other":1,"ids":[]}`))
	if err != nil {
		t.Fatalf("parse body: %v", err)
	}
	if len(fields) != 2 || fields[0].Key != "ids" || fields[1].Key != "other" {
		t.Fatalf("fields = %+v", fields)
	}
	var value []string
	if err := json.Unmarshal(fields[0].Value, &value); err != nil {
		t.Fatalf("decode ids: %v", err)
	}
	if len(value) != 0 {
		t.Fatalf("duplicate key must keep the last value, got %v", value)
	}
}

func TestParseObjectBodyRejectsInvalidJSON(t *testing.T) {
	if _, err := parseObjectBody([]byte("{")); err == nil {
		t.Fatal("invalid JSON must be rejected")
	}
}

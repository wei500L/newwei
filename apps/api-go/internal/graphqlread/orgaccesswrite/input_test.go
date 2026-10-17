package orgaccesswrite

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func inputArgs(input map[string]any) map[string]any {
	return map[string]any{"input": input}
}

// TestCreateOrgInputValidation pins the class-validator message order for the
// slug: Matches before MaxLength, joined with "; " exactly like
// GlobalExceptionFilter.getMessageFromResponse.
func TestCreateOrgInputValidation(t *testing.T) {
	long := strings.Repeat("!", 70)
	_, err := parseCreateOrgInput(inputArgs(map[string]any{
		"name":        "Acme",
		"slug":        long,
		"description": "ok",
	}))
	want := slugFormatMessage + "; slug must be shorter than or equal to 64 characters"
	if err == nil || err.Error() != want {
		t.Fatalf("err %v want %q", err, want)
	}
	var failure *contract.Failure
	mapped := graphqlFailure(err)
	if !errors.As(mapped, &failure) || failure.Status != http.StatusBadRequest || failure.Message != want {
		t.Fatalf("mapped %#v", mapped)
	}

	nameTooLong := strings.Repeat("a", 121)
	_, err = parseCreateOrgInput(inputArgs(map[string]any{"name": nameTooLong, "slug": "acme-corp"}))
	if err == nil || err.Error() != "name must be shorter than or equal to 120 characters" {
		t.Fatalf("name err %v", err)
	}
}

// TestCreateOrgInputAccepted pins the accepted values, including the frontend
// trim semantics that happen later in the service.
func TestCreateOrgInputAccepted(t *testing.T) {
	input, err := parseCreateOrgInput(inputArgs(map[string]any{
		"name":        "  Acme  ",
		"slug":        "  ACME-CORP  ",
		"description": "  hello  ",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if input.Name != "  Acme  " || input.Slug != "  ACME-CORP  " {
		t.Fatalf("parsed %#v", input)
	}
	if input.Description == nil || *input.Description != "  hello  " {
		t.Fatalf("description %#v", input.Description)
	}

	// The DTO runs the slug pattern on the raw, untrimmed value.
	if _, err := parseCreateOrgInput(inputArgs(map[string]any{"name": "Acme", "slug": " acme "})); err == nil {
		t.Fatal("a padded slug passed the raw DTO pattern")
	}
	empty := ""
	if _, err := parseCreateOrgInput(inputArgs(map[string]any{"name": "Acme", "slug": empty})); err == nil {
		t.Fatal("an empty slug passed the DTO pattern")
	}
}

// TestUpdateOrgInputTriState pins the omitted / null / value distinction the
// service relies on.
func TestUpdateOrgInputTriState(t *testing.T) {
	omitted, err := parseUpdateOrgInput(inputArgs(map[string]any{"id": "o1"}))
	if err != nil {
		t.Fatal(err)
	}
	if omitted.NamePresent || omitted.SlugPresent || omitted.DescriptionPresent {
		t.Fatalf("omitted %#v", omitted)
	}

	nulled, err := parseUpdateOrgInput(inputArgs(map[string]any{
		"id":          "o1",
		"name":        nil,
		"description": nil,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !nulled.NamePresent || nulled.Name != nil {
		t.Fatalf("null name %#v", nulled)
	}
	if !nulled.DescriptionPresent || nulled.Description != nil {
		t.Fatalf("null description %#v", nulled)
	}

	valued, err := parseUpdateOrgInput(inputArgs(map[string]any{"id": "o1", "description": "  x  "}))
	if err != nil {
		t.Fatal(err)
	}
	if !valued.DescriptionPresent || valued.Description == nil || *valued.Description != "  x  " {
		t.Fatalf("valued description %#v", valued)
	}
}

// TestRoleAndMembershipInputValidation pins the ArrayNotEmpty message and the
// per-element fallback.
func TestRoleAndMembershipInputValidation(t *testing.T) {
	_, err := parseCreateRoleInput(inputArgs(map[string]any{
		"name":        "editor",
		"permissions": []any{},
	}))
	if err == nil || err.Error() != "permissions should not be empty" {
		t.Fatalf("empty permissions err %v", err)
	}

	_, err = parseUpdateMembershipRolesInput(inputArgs(map[string]any{
		"userId":        "u1",
		"primaryRoleId": "r1",
		"roleIds":       []any{},
	}))
	if err == nil || err.Error() != "roleIds should not be empty" {
		t.Fatalf("empty roleIds err %v", err)
	}

	_, err = parseUpdateMembershipRolesInput(inputArgs(map[string]any{
		"userId":        "u1",
		"primaryRoleId": "r1",
		"roleIds":       []any{"r1", 7},
	}))
	if err == nil || err.Error() != "each value in roleIds must be a string" {
		t.Fatalf("mixed roleIds err %v", err)
	}
}

// TestSetAndActiveInputValidation pins the required scalar messages.
func TestSetAndActiveInputValidation(t *testing.T) {
	_, err := parseSetOrgActiveInput(inputArgs(map[string]any{"id": "o1"}))
	if err == nil || err.Error() != "isActive must be a boolean value" {
		t.Fatalf("missing isActive err %v", err)
	}
	_, err = parseSetUserActiveInput(inputArgs(map[string]any{"userId": "u1", "isActive": "yes"}))
	if err == nil || err.Error() != "isActive must be a boolean value" {
		t.Fatalf("string isActive err %v", err)
	}
	input, err := parseSetUserActiveInput(inputArgs(map[string]any{"userId": "u1", "isActive": false}))
	if err != nil || input.UserID != "u1" || input.IsActive {
		t.Fatalf("parsed %#v err %v", input, err)
	}
}

// TestJsMaxLengthLen pins the validator.js isLength semantics: UTF-16 length
// minus surrogate pairs minus presentation sequences.
func TestJsMaxLengthLen(t *testing.T) {
	cases := []struct {
		value string
		want  int
	}{
		{"abc", 3},
		{"\U0001F600", 1},
		{"a\uFE0F", 1},
		{"a\uFE0F\uFE0F", 2},
		{"\uFE0F\uFE0F", 2},
	}
	for _, testCase := range cases {
		if got := jsMaxLengthLen(testCase.value); got != testCase.want {
			t.Fatalf("jsMaxLengthLen(%q) = %d want %d", testCase.value, got, testCase.want)
		}
	}
}

// TestSlugPattern pins the accepted slug shape.
func TestSlugPattern(t *testing.T) {
	for _, value := range []string{"acme-corp", "a1b", "abc", "a--b", "日本語テスト"} {
		if !slugPattern.MatchString(value) {
			t.Fatalf("slug %q rejected", value)
		}
	}
	for _, value := range []string{"ab", "-abc", "abc-", "a_b", "a b", strings.Repeat("a", 65)} {
		if slugPattern.MatchString(value) {
			t.Fatalf("slug %q accepted", value)
		}
	}
}

// TestTrimmedOptional pins the create/update description normalization.
func TestTrimmedOptional(t *testing.T) {
	if got := trimmedOptional(nil); got != nil {
		t.Fatalf("nil -> %v", *got)
	}
	blank := "   "
	if got := trimmedOptional(&blank); got != nil {
		t.Fatalf("blank -> %v", *got)
	}
	padded := "  hello  "
	got := trimmedOptional(&padded)
	if got == nil || *got != "hello" {
		t.Fatalf("padded -> %v", got)
	}
}

package identityonboarding

import (
	"reflect"
	"strings"
	"testing"
)

// TestParseCreateInviteRequest locks the DTO boundary: unknown members come
// first, roleIds keeps only its two decorators, and a non-string element is a
// business-boundary failure (the source DTO has no per-element rule).
func TestParseCreateInviteRequest(t *testing.T) {
	_, err := parseCreateInviteRequest([]byte(`{"email":"a@example.com","primaryRoleId":"r1","roleIds":["r1"],"skipChecks":true}`))
	if err == nil || !strings.Contains(err.Error(), "property skipChecks should not exist") {
		t.Fatalf("unknown member: %v", err)
	}

	_, err = parseCreateInviteRequest([]byte(`{"email":"a@example.com","primaryRoleId":"r1","roleIds":[]}`))
	if err == nil || !strings.Contains(err.Error(), "roleIds should not be empty") {
		t.Fatalf("empty array: %v", err)
	}

	_, err = parseCreateInviteRequest([]byte(`{"email":"a@example.com","primaryRoleId":"r1","roleIds":"r1"}`))
	if err == nil || !strings.Contains(err.Error(), "roleIds must be an array") {
		t.Fatalf("non-array: %v", err)
	}

	_, err = parseCreateInviteRequest([]byte(`{"email":"nope","primaryRoleId":"r1","roleIds":["r1"]}`))
	if err == nil || !strings.Contains(err.Error(), "email must be an email") {
		t.Fatalf("email: %v", err)
	}

	if _, err := parseCreateInviteRequest([]byte(`{"email":"a@example.com","primaryRoleId":"r1","roleIds":[1]}`)); err == nil {
		t.Fatal("a non-string role id must not become a business value")
	}
}

// TestParseAcceptInviteRequestPresence locks the difference between absent/null
// and an explicit empty string, which the service fallback depends on.
func TestParseAcceptInviteRequestPresence(t *testing.T) {
	request, err := parseAcceptInviteRequest([]byte(`{"password":null,"firstName":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.Password != nil || request.FirstName != nil {
		t.Fatalf("null must be skipped: %+v", request)
	}

	request, err = parseAcceptInviteRequest([]byte(`{"firstName":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.FirstName == nil || *request.FirstName != "" {
		t.Fatalf("explicit empty string must stay present: %+v", request.FirstName)
	}

	if _, err := parseAcceptInviteRequest([]byte(`{"password":"1234567"}`)); err == nil ||
		!strings.Contains(err.Error(), "password must be longer than or equal to 8 characters") {
		t.Fatalf("short password: %v", err)
	}
}

// TestApproveJoinRejectsBypassFields locks the protocol boundary: the controlled
// administrator path cannot be requested by a client, because no such member
// exists in the DTO and an extra one is rejected by the whitelist.
func TestApproveJoinRejectsBypassFields(t *testing.T) {
	for _, body := range []string{
		`{"primaryRoleId":"r1","roleIds":["r1"],"allowSystemAdmin":true}`,
		`{"primaryRoleId":"r1","roleIds":["r1"],"skipChecks":true}`,
	} {
		if _, err := parseApproveJoinRequest([]byte(body)); err == nil ||
			!strings.Contains(err.Error(), "should not exist") {
			t.Fatalf("body %s: %v", body, err)
		}
	}
}

// TestNormalizeRoleIDsKeepsRawPrimary locks the source semantics: the primary id
// is compared untrimmed, so a whitespace-padded id is preserved and later fails
// the role-set check instead of being silently rewritten.
func TestNormalizeRoleIDsKeepsRawPrimary(t *testing.T) {
	got := normalizeRoleIDs([]string{" b ", "a", "a"}, " a ")
	want := []string{" a ", "a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeRoleIDs = %#v, want %#v", got, want)
	}

	if got := readRoleIDs([]byte(`{"not":"an array"}`), "r1"); !reflect.DeepEqual(got, []string{"r1"}) {
		t.Fatalf("readRoleIDs(non-array) = %#v", got)
	}
	if got := readRoleIDs([]byte(`["r2", "", 3, " r3 "]`), "r1"); !reflect.DeepEqual(got, []string{"r1", "r2", "r3"}) {
		t.Fatalf("readRoleIDs = %#v", got)
	}
}

// TestInviteURLAbsolutePath locks new URL('/invite/<token>', base) semantics: the
// base path is replaced and query/fragment are dropped.
func TestInviteURLAbsolutePath(t *testing.T) {
	service := NewService(nil, nil, nil, Config{BaseURL: "http://example.com/console?x=1#y"})
	got, err := service.inviteURL("abc123")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://example.com/invite/abc123" {
		t.Fatalf("url = %s", got)
	}
}

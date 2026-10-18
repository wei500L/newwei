package authlogin

import (
	"strings"
	"testing"
)

// The DTO tests lock the ValidationPipe contract: the same messages, the same
// order and the same treatment of absent / null / empty members as NestJS. They
// matter because a client must not be able to tell which implementation answered.

func errorMessage(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	coded, ok := err.(*httpError)
	if !ok {
		t.Fatalf("expected *httpError, got %T", err)
	}
	return coded.message
}

func TestLoginRequestNullAndEmptyOrgID(t *testing.T) {
	// An explicit null and an omitted member both skip @IsOptional(); an empty
	// string passes @IsString and stays distinguishable for refresh.
	for _, body := range []string{
		`{"email":"a@b.com","password":"12345678"}`,
		`{"email":"a@b.com","password":"12345678","orgId":null}`,
	} {
		request, err := parseLoginRequest([]byte(body))
		if err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		if request.OrgID != nil {
			t.Fatalf("%s: orgId = %v, want nil", body, *request.OrgID)
		}
	}
	request, err := parseLoginRequest([]byte(`{"email":"a@b.com","password":"12345678","orgId":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.OrgID == nil || *request.OrgID != "" {
		t.Fatalf("empty orgId must stay an explicit empty string, got %v", request.OrgID)
	}
}

func TestLoginRequestValidationMessages(t *testing.T) {
	// Declaration order (email, password, orgId) and bottom-up decorator order
	// (MinLength before IsString) are both part of the contract.
	_, err := parseLoginRequest([]byte(`{"email":"nope","password":"short"}`))
	if got := errorMessage(t, err); got != "email must be an email; password must be longer than or equal to 8 characters" {
		t.Fatalf("messages = %q", got)
	}
	_, err = parseLoginRequest([]byte(`{"email":"a@b.com","password":"12345678","extra":1}`))
	if got := errorMessage(t, err); got != "property extra should not exist" {
		t.Fatalf("unknown member message = %q", got)
	}
	_, err = parseLoginRequest([]byte(`{"email":"a@b.com","password":12345678}`))
	if got := errorMessage(t, err); got != "password must be longer than or equal to 8 characters; password must be a string" {
		t.Fatalf("non-string password messages = %q", got)
	}
}

func TestLoginWithCodeKeepsLeadingZeros(t *testing.T) {
	request, err := parseLoginWithCodeRequest([]byte(`{"email":"a@b.com","code":"00000001"}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.Code != "00000001" {
		t.Fatalf("code = %q, want the leading zeros preserved", request.Code)
	}
	// @Matches(/^\d{8}$/) runs before @IsString.
	_, err = parseLoginWithCodeRequest([]byte(`{"email":"a@b.com","code":"1234"}`))
	if got := errorMessage(t, err); got != "code must match /^\\d{8}$/ regular expression" {
		t.Fatalf("code messages = %q", got)
	}
}

func TestVerifyEmailCodeShape(t *testing.T) {
	if _, err := parseVerifyEmailRequest([]byte(`{"code":"12345678"}`)); err != nil {
		t.Fatal(err)
	}
	// A non-matching string fails only @Matches: @IsString still passes, so the
	// message array carries one entry, exactly like class-validator.
	_, err := parseVerifyEmailRequest([]byte(`{"code":"1234567a"}`))
	if got := errorMessage(t, err); got != "code must match /^\\d{8}$/ regular expression" {
		t.Fatalf("messages = %q", got)
	}
	// A non-string fails both, with @Matches reporting first.
	_, err = parseVerifyEmailRequest([]byte(`{"code":12345678}`))
	if got := errorMessage(t, err); got != "code must match /^\\d{8}$/ regular expression; code must be a string" {
		t.Fatalf("non-string messages = %q", got)
	}
}

func TestMfaCodeAcceptsRecoveryCodes(t *testing.T) {
	// VerifyMfaCodeDto is @IsString @MinLength(6): a 10-character recovery code
	// must pass, and there is no digit-only rule.
	request, err := parseMfaCodeRequest([]byte(`{"challengeId":"c1","code":"abcdef1234"}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.Code != "abcdef1234" || request.ChallengeID != "c1" {
		t.Fatalf("request = %+v", request)
	}
	// The inherited `code` property reports before the subclass's challengeId.
	_, err = parseMfaCodeRequest([]byte(`{"challengeId":1,"code":"12345"}`))
	if got := errorMessage(t, err); got != "code must be longer than or equal to 6 characters; challengeId must be a string" {
		t.Fatalf("messages = %q", got)
	}
}

func TestRefreshRequestMinimumLength(t *testing.T) {
	_, err := parseRefreshRequest([]byte(`{"refreshToken":"short"}`))
	if got := errorMessage(t, err); got != "refreshToken must be longer than or equal to 20 characters" {
		t.Fatalf("messages = %q", got)
	}
	// An absent orgId stays nil; refresh relies on that to fall back to the
	// organization embedded in the token.
	request, err := parseRefreshRequest([]byte(`{"refreshToken":"01234567890123456789"}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.OrgID != nil {
		t.Fatal("absent orgId must stay nil")
	}
}

func TestResetPasswordRequest(t *testing.T) {
	// token (@IsString) reports before password, and password's @MinLength runs
	// before its @IsString.
	_, err := parseResetPasswordRequest([]byte(`{"token":1,"password":"short"}`))
	if got := errorMessage(t, err); got != "token must be a string; password must be longer than or equal to 8 characters" {
		t.Fatalf("messages = %q", got)
	}
}

func TestEmailOnlyRequestRejectsUnknownMembers(t *testing.T) {
	_, err := parseEmailOnlyRequest([]byte(`{"email":"a@b.com","orgId":"x"}`))
	if got := errorMessage(t, err); got != "property orgId should not exist" {
		t.Fatalf("messages = %q", got)
	}
}

func TestInvalidBodyIsBadRequest(t *testing.T) {
	_, err := parseLoginRequest([]byte(`[]`))
	if got := errorMessage(t, err); !strings.Contains(got, "Invalid request body") {
		t.Fatalf("messages = %q", got)
	}
}

package authfactors

import (
	"strings"
	"testing"
)

// problemMessage renders the 400 message a decoder produced.
func problemMessage(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected a validation error")
	}
	coded, ok := err.(*httpError)
	if !ok {
		t.Fatalf("error %T is not an httpError", err)
	}
	if coded.status != 400 {
		t.Fatalf("status = %d, want 400", coded.status)
	}
	return coded.message
}

// TestParseVerifyMfaCodeRequest locks VerifyMfaCodeDto: code is a required
// string of at least six characters, there is no numeric coercion, there is no
// maximum length and unknown members are rejected by the whitelist pass.
func TestParseVerifyMfaCodeRequest(t *testing.T) {
	for _, body := range []string{`{"code":"123456"}`, `{"code":"abcdef"}`, `{"code":"000000"}`, `{"code":"1234567890"}`} {
		dto, err := parseVerifyMfaCodeRequest([]byte(body))
		if err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		if dto.Code == "" {
			t.Fatalf("%s: empty code", body)
		}
	}

	// Too short: only the MinLength message (the value is still a string).
	message := problemMessage(t, mustFailVerify(t, `{"code":"12345"}`))
	if message != "code must be longer than or equal to 6 characters" {
		t.Fatalf("short code message = %q", message)
	}

	// Missing: MinLength is evaluated before IsString, so both messages appear
	// in that order.
	message = problemMessage(t, mustFailVerify(t, `{}`))
	if message != "code must be longer than or equal to 6 characters; code must be a string" {
		t.Fatalf("missing code message = %q", message)
	}

	// A number is never coerced into a string.
	message = problemMessage(t, mustFailVerify(t, `{"code":123456}`))
	if !strings.Contains(message, "code must be a string") {
		t.Fatalf("numeric code message = %q", message)
	}
	if !strings.Contains(message, "code must be longer than or equal to 6 characters") {
		t.Fatalf("numeric code message = %q", message)
	}

	// The whitelist message comes before any per-property message.
	message = problemMessage(t, mustFailVerify(t, `{"code":"12345","extra":1}`))
	if !strings.HasPrefix(message, "property extra should not exist; ") {
		t.Fatalf("whitelist order = %q", message)
	}

	// A JSON null body is treated as an empty object.
	message = problemMessage(t, mustFailVerify(t, `null`))
	if !strings.Contains(message, "code must be a string") {
		t.Fatalf("null body message = %q", message)
	}

	// A non-object body is rejected outright.
	message = problemMessage(t, mustFailVerify(t, `[]`))
	if message != "Invalid request body" {
		t.Fatalf("array body message = %q", message)
	}
}

func mustFailVerify(t *testing.T, body string) error {
	t.Helper()
	_, err := parseVerifyMfaCodeRequest([]byte(body))
	if err == nil {
		t.Fatalf("%s: expected an error", body)
	}
	return err
}

// TestParseOidcConfigRequestDefaults locks the accepted shape and the optional
// semantics: required strings may be empty, optional null values are skipped,
// and scopes keeps its raw elements for the service to filter.
func TestParseOidcConfigRequestDefaults(t *testing.T) {
	dto, err := parseOidcConfigRequest([]byte(`{"enabled":false,"issuerUrl":"","clientId":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if dto.Enabled || dto.IssuerURL != "" || dto.ClientID != "" {
		t.Fatalf("dto = %+v", dto)
	}
	if dto.DiscoveryURL != nil || dto.ClientSecret != nil || dto.ButtonLabel != nil || dto.RequireEmailVerified != nil {
		t.Fatalf("optional fields must stay nil: %+v", dto)
	}
	if dto.Scopes != nil {
		t.Fatalf("absent scopes = %v", dto.Scopes)
	}

	// Explicit nulls on optional properties are accepted and become nil.
	dto, err = parseOidcConfigRequest([]byte(`{"enabled":true,"issuerUrl":"a","clientId":"b","discoveryUrl":null,"clientSecret":null,"scopes":null,"buttonLabel":null,"requireEmailVerified":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if dto.DiscoveryURL != nil || dto.ClientSecret != nil || dto.Scopes != nil || dto.ButtonLabel != nil || dto.RequireEmailVerified != nil {
		t.Fatalf("explicit nulls must become nil: %+v", dto)
	}

	// A mixed scopes array is accepted verbatim: there is no
	// @IsString({ each: true }).
	dto, err = parseOidcConfigRequest([]byte(`{"enabled":true,"issuerUrl":"a","clientId":"b","scopes":["openid",1,""]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(dto.Scopes) != 3 {
		t.Fatalf("scopes = %v", dto.Scopes)
	}
}

// TestParseOidcConfigRequestValidation locks the per-property messages and their
// declaration order.
func TestParseOidcConfigRequestValidation(t *testing.T) {
	message := problemMessage(t, mustFailOidc(t, `{}`))
	want := "enabled must be a boolean value; issuerUrl must be a string; clientId must be a string"
	if message != want {
		t.Fatalf("empty body message = %q, want %q", message, want)
	}

	// A numeric enabled and a string "true" are both rejected: there is no
	// implicit conversion.
	for _, body := range []string{
		`{"enabled":1,"issuerUrl":"a","clientId":"b"}`,
		`{"enabled":"true","issuerUrl":"a","clientId":"b"}`,
	} {
		message = problemMessage(t, mustFailOidc(t, body))
		if !strings.Contains(message, "enabled must be a boolean value") {
			t.Fatalf("%s message = %q", body, message)
		}
	}

	// A non-array scopes is rejected by the DTO.
	message = problemMessage(t, mustFailOidc(t, `{"enabled":true,"issuerUrl":"a","clientId":"b","scopes":"openid"}`))
	if message != "scopes must be an array" {
		t.Fatalf("scopes message = %q", message)
	}

	// A wrong-typed optional property is rejected.
	message = problemMessage(t, mustFailOidc(t, `{"enabled":true,"issuerUrl":"a","clientId":"b","requireEmailVerified":"yes"}`))
	if message != "requireEmailVerified must be a boolean value" {
		t.Fatalf("requireEmailVerified message = %q", message)
	}

	// The whitelist message comes first and every message follows in
	// declaration order.
	message = problemMessage(t, mustFailOidc(t, `{"zzz":1,"enabled":1,"issuerUrl":2,"clientId":3}`))
	if !strings.HasPrefix(message, "property zzz should not exist; ") {
		t.Fatalf("whitelist order = %q", message)
	}
	if strings.Index(message, "enabled must be") > strings.Index(message, "issuerUrl must be") {
		t.Fatalf("declaration order violated: %q", message)
	}
	if strings.Index(message, "issuerUrl must be") > strings.Index(message, "clientId must be") {
		t.Fatalf("declaration order violated: %q", message)
	}
}

func mustFailOidc(t *testing.T, body string) error {
	t.Helper()
	_, err := parseOidcConfigRequest([]byte(body))
	if err == nil {
		t.Fatalf("%s: expected an error", body)
	}
	return err
}

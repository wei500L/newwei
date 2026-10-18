package authfactors

import (
	"database/sql"
	"testing"
)

// TestReadScopesRule locks the readScopes contract: a non-array value or a
// filtered-empty array falls back to the default three, non-empty strings are
// kept verbatim (no trim, no dedupe, no forced openid), and the blank test
// itself is applied to the trimmed text.
func TestReadScopesRule(t *testing.T) {
	defaults := []string{"openid", "email", "profile"}

	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"sql null", "", defaults},
		{"json null", "null", defaults},
		{"object", `{"a":"b"}`, defaults},
		{"string", `"openid"`, defaults},
		{"empty array", `[]`, defaults},
		{"all blank", `["", "   "]`, defaults},
		{"non string entries only", `[1, true, null, {}]`, defaults},
		{"simple", `["openid","profile"]`, []string{"openid", "profile"}},
		{"keeps whitespace verbatim", `[" openid "]`, []string{" openid "}},
		{"keeps duplicates and order", `["b","a","b"]`, []string{"b", "a", "b"}},
		{"filters mixed entries", `["openid", 1, "", "  ", null, "email"]`, []string{"openid", "email"}},
	}
	for _, tc := range cases {
		got := readScopes([]byte(tc.raw))
		if len(got) != len(tc.want) {
			t.Fatalf("%s: readScopes(%s) = %v, want %v", tc.name, tc.raw, got, tc.want)
		}
		for index := range got {
			if got[index] != tc.want[index] {
				t.Fatalf("%s: readScopes(%s) = %v, want %v", tc.name, tc.raw, got, tc.want)
			}
		}
	}
}

// TestDefaultOidcScopesAreIndependent locks that the fallback slice is not a
// shared array a caller could mutate.
func TestDefaultOidcScopesAreIndependent(t *testing.T) {
	first := defaultOidcScopes()
	first[0] = "mutated"
	second := defaultOidcScopes()
	if second[0] != "openid" {
		t.Fatalf("default scopes were mutated: %v", second)
	}
}

// TestJSONBooleanTruthy locks the Boolean(storedValue) semantics used by
// hasClientSecret.
func TestJSONBooleanTruthy(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{"", false},
		{"null", false},
		{"false", false},
		{"0", false},
		{`""`, false},
		{`"ciphertext"`, true},
		{`" "`, true},
		{`{"__enc":"system-settings:v1"}`, true},
		{"[]", true},
		{"true", true},
		{"1", true},
	}
	for _, tc := range cases {
		if got := jsonBooleanTruthy([]byte(tc.raw)); got != tc.want {
			t.Fatalf("jsonBooleanTruthy(%s) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

// TestNullableTrimmed locks `value?.trim() || null` for the optional string
// columns.
func TestNullableTrimmed(t *testing.T) {
	if got := nullableTrimmed(nil); got != nil {
		t.Fatalf("nil input = %q, want SQL NULL", got)
	}
	blank := "   "
	if got := nullableTrimmed(&blank); got != nil {
		t.Fatalf("blank input = %q, want SQL NULL", got)
	}
	empty := ""
	if got := nullableTrimmed(&empty); got != nil {
		t.Fatalf("empty input = %q, want SQL NULL", got)
	}
	padded := "  https://idp.example.com/.well-known/openid-configuration  "
	if got := string(nullableTrimmed(&padded)); got != "https://idp.example.com/.well-known/openid-configuration" {
		t.Fatalf("trimmed input = %q", got)
	}
}

// TestOidcResponseFromRowLocksNullsAndSecrets locks the response rendering: SQL
// NULL discoveryUrl/buttonLabel become empty strings, a missing scopes column
// falls back to the default three, and hasClientSecret reflects the stored
// value without any decryption attempt.
func TestOidcResponseFromRowLocksNullsAndSecrets(t *testing.T) {
	row := oidcConfigRow{
		Enabled:              true,
		IssuerURL:            "https://idp.example.com",
		DiscoveryURL:         sql.NullString{},
		ClientID:             "client-1",
		ClientSecret:         []byte(`"stored-secret"`),
		Scopes:               nil,
		ButtonLabel:          sql.NullString{},
		RequireEmailVerified: true,
	}
	response := oidcResponseFromRow(row)
	if response.DiscoveryURL != "" || response.ButtonLabel != "" {
		t.Fatalf("SQL NULL columns must render as empty strings: %+v", response)
	}
	if !response.HasClientSecret {
		t.Fatalf("hasClientSecret must reflect the stored value: %+v", response)
	}
	if len(response.Scopes) != 3 || response.Scopes[0] != "openid" {
		t.Fatalf("scopes = %v", response.Scopes)
	}
	if response.IssuerURL != "https://idp.example.com" || response.ClientID != "client-1" {
		t.Fatalf("response = %+v", response)
	}

	// An encrypted envelope is still "has a secret" even when no key exists:
	// the flag is Boolean(storedValue), not "can it be decrypted".
	envelopeRow := row
	envelopeRow.ClientSecret = []byte(`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"aXY=","tag":"dGFn","data":"ZGF0YQ=="}`)
	if !oidcResponseFromRow(envelopeRow).HasClientSecret {
		t.Fatal("an envelope must count as a stored secret")
	}

	// SQL NULL renders false.
	nullRow := row
	nullRow.ClientSecret = nil
	if oidcResponseFromRow(nullRow).HasClientSecret {
		t.Fatal("SQL NULL must render hasClientSecret false")
	}
}

package authfactors

import (
	"strings"
	"testing"
)

// TestGenerateRecoveryCodesShape locks the ten character uppercase hex shape and
// the count of one generated set.
func TestGenerateRecoveryCodesShape(t *testing.T) {
	codes, err := generateRecoveryCodes(recoveryCodeCount)
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != recoveryCodeCount {
		t.Fatalf("count = %d, want %d", len(codes), recoveryCodeCount)
	}
	seen := make(map[string]bool, len(codes))
	for _, code := range codes {
		if len(code) != 10 {
			t.Fatalf("code %q length = %d, want 10", code, len(code))
		}
		if code != strings.ToUpper(code) {
			t.Fatalf("code %q must be uppercase", code)
		}
		for _, ch := range code {
			if !strings.ContainsRune("0123456789ABCDEF", ch) {
				t.Fatalf("code %q contains %q outside the hex alphabet", code, ch)
			}
		}
		if seen[code] {
			t.Fatalf("duplicate code %q", code)
		}
		seen[code] = true
	}
}

// TestNormalizeRecoveryCode locks the trim + uppercase normalization used by the
// recovery-code branch. A recovery code must never be rejected as a malformed
// six digit TOTP code.
func TestNormalizeRecoveryCode(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ab12cd34ef", "AB12CD34EF"},
		{"  AB12CD34EF  ", "AB12CD34EF"},
		{"\tAb12Cd34Ef\n", "AB12CD34EF"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := normalizeRecoveryCode(tc.in); got != tc.want {
			t.Fatalf("normalizeRecoveryCode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if hashRecoveryCode(" ab12cd34ef ") != hashRecoveryCode("AB12CD34EF") {
		t.Fatal("the lookup hash must be computed over the normalized code")
	}
	if hashRecoveryCode("AB12CD34EF") == hashRecoveryCode("AB12CD34E0") {
		t.Fatal("different codes must not share a hash")
	}
}

// TestHashOpaqueTokenMatchesSHA256Protocol locks the stored representation
// against a published SHA-256 vector: lowercase hex, no salt, no bcrypt.
func TestHashOpaqueTokenMatchesSHA256Protocol(t *testing.T) {
	const sha256OfABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := hashOpaqueToken("abc"); got != sha256OfABC {
		t.Fatalf("hashOpaqueToken(abc) = %q", got)
	}
	if len(hashOpaqueToken("")) != 64 {
		t.Fatal("the digest must always be 64 hex characters")
	}
	if got := hashOpaqueToken("ABC"); got == hashOpaqueToken("abc") {
		t.Fatal("the digest is case sensitive; normalization happens before hashing")
	}
}

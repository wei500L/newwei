// Table test for the access-token blacklist value semantics.
//
// The keys and values are shared with the NestJS AccessTokenBlacklistService
// through Redis, so the read side must reproduce
// `Boolean(JSON.parse(value))` exactly: only false / null / 0 / "" are "not
// revoked". Arrays and objects are truthy in JavaScript regardless of their
// size, so a stored `[]` or `{}` means revoked — treating them as falsy would
// turn a poison value into a silent bypass of the revocation list.
package authn

import (
	"context"
	"testing"
)

func TestJSTruthyJSON(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		want    bool
		wantErr bool
	}{
		// The value NestJS actually writes (CacheService.set(key, true, ttl)).
		{"written-true", "true", true, false},
		{"false", "false", false, false},
		{"null", "null", false, false},
		{"zero", "0", false, false},
		{"zero-float", "0.0", false, false},
		{"non-zero", "1", true, false},
		{"negative", "-1", true, false},
		{"empty-string-literal", `""`, false, false},
		{"non-empty-string-literal", `"false"`, true, false},
		// Boolean([]) and Boolean({}) are true in JavaScript.
		{"empty-array", "[]", true, false},
		{"empty-object", "{}", true, false},
		{"array", `[{"a":1}]`, true, false},
		{"object", `{"a":1}`, true, false},
		// CacheService.get short-circuits a falsy stored value before parsing.
		{"empty-stored-value", "", false, false},
		// Everything else is a JSON.parse throw -> fail-closed 500.
		{"not-json", "revoked", true, true},
		{"truncated", "{", true, true},
		{"whitespace-only", "   ", true, true},
	}
	for _, tc := range cases {
		got, err := jsTruthyJSON(tc.value)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: jsTruthyJSON(%q) = %v, nil; want error", tc.name, tc.value, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: jsTruthyJSON(%q) error = %v, want nil", tc.name, tc.value, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%s: jsTruthyJSON(%q) = %v, want %v", tc.name, tc.value, got, tc.want)
		}
	}
}

// TestRevokedSkipsEmptyJTI locks the NestJS `if (!tokenId) return false;`
// short circuit: a token without jti must not be reported revoked and must not
// touch Redis (the nil client would panic if it were used).
func TestRevokedSkipsEmptyJTI(t *testing.T) {
	blacklist := NewRedisBlacklist(nil)
	revoked, err := blacklist.Revoked(context.Background(), "")
	if err != nil {
		t.Fatalf("Revoked(\"\") error = %v, want nil", err)
	}
	if revoked {
		t.Fatalf("Revoked(\"\") = true, want false")
	}
}

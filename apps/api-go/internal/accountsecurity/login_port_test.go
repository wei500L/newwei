package accountsecurity

import "testing"

// jsTruthyText decides whether a blacklist entry means "revoked", so every case
// below is a security decision. JavaScript's falsy set is exactly false, null, 0
// and "" — "[]" and "{}" are truthy, and reading them as "not revoked" would
// fail open on a revoked token.
func TestJSTruthyTextMatchesJavaScriptTruthiness(t *testing.T) {
	cases := []struct {
		value   string
		want    bool
		wantErr bool
	}{
		{value: `true`, want: true},
		{value: `false`, want: false},
		{value: `null`, want: false},
		{value: `0`, want: false},
		{value: `1`, want: true},
		{value: `-7`, want: true},
		{value: `""`, want: false},
		{value: `"x"`, want: true},
		// Boolean([]) and Boolean({}) are true in JavaScript regardless of size.
		{value: `[]`, want: true},
		{value: `[1]`, want: true},
		{value: `{}`, want: true},
		{value: `{"a":1}`, want: true},
		// NestJS short-circuits with `value ? JSON.parse(value) : null`, so an
		// empty stored value never reaches JSON.parse and means "not revoked".
		{value: ``, want: false},
		// Anything else is a parse failure the caller maps to a fail-closed 500.
		{value: `not-json`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.value, func(t *testing.T) {
			got, err := jsTruthyText(tc.value)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("jsTruthyText(%q) = %v, want an error", tc.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("jsTruthyText(%q) error: %v", tc.value, err)
			}
			if got != tc.want {
				t.Errorf("jsTruthyText(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

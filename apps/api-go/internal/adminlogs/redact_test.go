package adminlogs

import (
	"reflect"
	"testing"
)

func TestRedactSensitiveFields(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"password-equals", "password=plain123", "password=[REDACTED]"},
		{"password-colon-quoted", "password: 'abc'", "password:[REDACTED]"},
		{"token", "token=abc", "token=[REDACTED]"},
		{"api-key-camel", "apiKey=xyz", "apiKey=[REDACTED]"},
		{"api-key-snake", "api_key=xyz", "api_key=[REDACTED]"},
		{"secret", "secret=abc", "secret=[REDACTED]"},
		{"credential", "credential=abc", "credential=[REDACTED]"},
		{"bearer", "Bearer secret.jwt.token", "Bearer [REDACTED]"},
		{"bearer-keeps-other-patterns", "Bearer secret.jwt.token password=plain123",
			"Bearer [REDACTED] password=[REDACTED]"},
		{"basic", "Basic dXNlcjpwYXNz", "Basic [REDACTED]"},
		{"untouched", "nothing sensitive here", "nothing sensitive here"},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := redactSensitiveFields(tc.input); got != tc.want {
				t.Fatalf("redactSensitiveFields(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestIsSensitiveKey(t *testing.T) {
	cases := map[string]bool{
		"authorization":       true,
		"proxy-authorization": true,
		"x-api-key":           true,
		"x_api_key":           true,
		"api_key":             true,
		"apikey":              true,
		"token":               true,
		"access_token":        true,
		"refresh_token":       true,
		"password":            true,
		"passphrase":          true,
		"secret":              true,
		"API_KEY":             true,
		"  Token  ":           true,
		"my_api_key":          true,
		"nested":              false,
		"message":             false,
		"":                    false,
	}
	for key, want := range cases {
		if got := isSensitiveKey(key); got != want {
			t.Fatalf("isSensitiveKey(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestRedactDeep(t *testing.T) {
	input := map[string]any{
		"authorization": "Bearer secret.jwt.token",
		"nested": map[string]any{
			"api_key": "plain",
			"safe":    "value",
		},
		"list":   []any{"password=plain123", "keep"},
		"count":  3,
		"absent": nil,
	}
	want := map[string]any{
		"authorization": "[REDACTED]",
		"nested": map[string]any{
			"api_key": "[REDACTED]",
			"safe":    "value",
		},
		"list":   []any{"password=[REDACTED]", "keep"},
		"count":  3,
		"absent": nil,
	}
	got := redactDeep(input, 0)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("redactDeep = %#v, want %#v", got, want)
	}
}

func TestRedactDeepDepthLimit(t *testing.T) {
	if got := redactDeep("password=plain123", maxRedactDepth); got != "password=[REDACTED]" {
		t.Fatalf("depth == limit should still redact, got %v", got)
	}
	if got := redactDeep("password=plain123", maxRedactDepth+1); got != "password=plain123" {
		t.Fatalf("depth > limit should pass through, got %v", got)
	}
}

func TestEscapeRegex(t *testing.T) {
	if got := escapeRegex("a.b*c"); got != `a\.b\*c` {
		t.Fatalf("escapeRegex dots/stars = %q", got)
	}
	if got := escapeRegex("plain"); got != "plain" {
		t.Fatalf("escapeRegex plain = %q", got)
	}
	if got := escapeRegex(`path\to`); got != `path\\to` {
		t.Fatalf("escapeRegex backslash = %q", got)
	}
}

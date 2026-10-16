package newssources

import "testing"

func TestUnsafeSourceURLReasonsMatchNest(t *testing.T) {
	cases := []struct {
		raw    string
		reason string
	}{
		{"http://127.0.0.1/", "Localhost is not allowed: 127.0.0.1"},
		{"http://169.254.169.254/", "Private/internal IP address is not allowed: 169.254.169.254"},
		{"http://metadata.google.internal/computeMetadata/v1/", "Cloud metadata endpoint is not allowed: metadata.google.internal"},
		{"https://example.com", ""},
	}
	for _, tc := range cases {
		if got := validateSSRFSync(tc.raw); got != tc.reason {
			t.Fatalf("%s reason=%q want %q", tc.raw, got, tc.reason)
		}
	}
}

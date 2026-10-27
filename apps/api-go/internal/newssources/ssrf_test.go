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

// TestSSRFNumericHostFormsMatchWHATWG covers the IPv4 spellings that new URL()
// canonicalises (decimal, octal, short parts) but net.ParseIP does not parse.
// The NestJS validator sees the canonical address, so every form below has to be
// rejected exactly like its dotted-quad equivalent.
func TestSSRFNumericHostFormsMatchWHATWG(t *testing.T) {
	cases := []struct {
		raw    string
		reason string
	}{
		{"http://127.1/", "Private/internal IP address is not allowed: 127.1"},
		{"http://127.0.1/", "Private/internal IP address is not allowed: 127.0.1"},
		{"http://192.168.1/", "Private/internal IP address is not allowed: 192.168.1"},
		{"http://10/", "Private/internal IP address is not allowed: 10"},
		{"http://017700000001/", "Private/internal IP address is not allowed: 017700000001"},
		{"http://0x7f000001/", "Localhost is not allowed: 0x7f000001"},
		{"http://1.2.3.4.5/", "Invalid IPv4 address is not allowed: 1.2.3.4.5"},
		// Public numeric forms stay allowed: 134744072 is 8.8.8.8.
		{"http://134744072/", ""},
		{"http://8.8.8.8/", ""},
		// A dotted-quad-mapped public IPv6 literal is not an IPv4 host.
		{"http://[::ffff:8.8.8.8]/", ""},
		// Hosts whose last label does not end in a number stay ordinary names.
		{"http://123.example.com/", ""},
		{"http://example.123abc/", ""},
	}
	for _, tc := range cases {
		if got := validateSSRFSync(tc.raw); got != tc.reason {
			t.Fatalf("%s reason=%q want %q", tc.raw, got, tc.reason)
		}
	}
}

// TestSSRFUnicodeHostFormsMatchNodeURL covers the UTS #46 mapping the WHATWG
// host parser applies before the rules run: a compatibility spelling of a
// metadata host is blocked, an ordinary IDN host stays allowed.
func TestSSRFUnicodeHostFormsMatchNodeURL(t *testing.T) {
	cases := []struct {
		raw    string
		reason string
	}{
		{"http://ｍｅｔａｄａｔａ.google.internal/", "Cloud metadata endpoint is not allowed: metadata.google.internal"},
		{"http://例え.jp/", ""},
		{"http://bücher.example/", ""},
	}
	for _, tc := range cases {
		if got := validateSSRFSync(tc.raw); got != tc.reason {
			t.Fatalf("%s reason=%q want %q", tc.raw, got, tc.reason)
		}
	}
}

// TestSSRFPercentEncodedHostIsRejected keeps the RFC 3986 boundary: net/url
// refuses %-escaped ASCII hosts while parsing, so the URL never reaches the
// host rules as a decoded name.
func TestSSRFPercentEncodedHostIsRejected(t *testing.T) {
	if got := validateSSRFSync("http://%31%32%37.0.0.1/"); got == "" {
		t.Fatal("percent-encoded loopback host accepted")
	}
}

// TestSSRFIPv6ZoneLiteralIsRejected covers RFC 6874 zone identifiers, which
// net.ParseIP refuses but Node still classifies as an IP literal.
func TestSSRFIPv6ZoneLiteralIsRejected(t *testing.T) {
	got := validateSSRFSync("http://[fe80::1%25eth0]/")
	want := "Private/internal IP address is not allowed: fe80::1%eth0"
	if got != want {
		t.Fatalf("reason=%q want %q", got, want)
	}
}

// TestSSRFHostTrailingDotMatchesWHATWG keeps "localhost." and
// "metadata.google.internal." classified like their dotless spelling, which is
// what the WHATWG host parser produces.
func TestSSRFHostTrailingDotMatchesWHATWG(t *testing.T) {
	cases := []struct {
		raw    string
		reason string
	}{
		{"http://localhost./", "Localhost is not allowed: localhost"},
		{"http://metadata.google.internal./x", "Cloud metadata endpoint is not allowed: metadata.google.internal"},
		{"http://127.0.0.1./", "Localhost is not allowed: 127.0.0.1"},
		{"http://example.com./", ""},
	}
	for _, tc := range cases {
		if got := validateSSRFSync(tc.raw); got != tc.reason {
			t.Fatalf("%s reason=%q want %q", tc.raw, got, tc.reason)
		}
	}
}

package crawlfrontierruns

import "testing"

// TestNormalizeSeedURL covers new URL(value).toString() for the values the
// create-run DTO can deliver after @IsUrl has accepted them, plus the boundary
// cases the audit called out: host case, a missing path, the scheme default
// port, IDN hosts and spaces.
func TestNormalizeSeedURL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "host is lower-cased", in: "https://Example.COM", want: "https://example.com/"},
		{name: "missing path becomes slash", in: "https://example.com", want: "https://example.com/"},
		{name: "https default port is dropped", in: "https://example.com:443/path", want: "https://example.com/path"},
		{name: "http default port is dropped", in: "http://example.com:80", want: "http://example.com/"},
		{name: "ftp default port is dropped", in: "ftp://example.com:21/file", want: "ftp://example.com/file"},
		{name: "non default port is kept", in: "https://example.com:8443/x", want: "https://example.com:8443/x"},
		{name: "port loses leading zeros", in: "https://example.com:08443/x", want: "https://example.com:8443/x"},
		{name: "ftp scheme is preserved", in: "ftp://example.com", want: "ftp://example.com/"},
		{name: "dot segments resolve", in: "https://example.com/a/../b", want: "https://example.com/b"},
		{name: "trailing dot segment keeps the slash", in: "https://example.com/a/./", want: "https://example.com/a/"},
		{name: "backslash is a separator", in: `https://example.com/a\b`, want: "https://example.com/a/b"},
		{name: "idn host is punycoded", in: "https://例子.测试", want: "https://xn--fsqu00a.xn--0zwm56d/"},
		{name: "idn host with uppercase", in: "https://MÜNCHEN.de", want: "https://xn--mnchen-3ya.de/"},
		{name: "space in path is encoded", in: "https://example.com/a b/", want: "https://example.com/a%20b/"},
		{name: "non ascii path is utf8 percent encoded", in: "https://example.com/中文", want: "https://example.com/%E4%B8%AD%E6%96%87"},
		{name: "existing percent escape stays", in: "https://example.com/%E4%B8%AD", want: "https://example.com/%E4%B8%AD"},
		{name: "userinfo is preserved", in: "https://user:pass@example.com/", want: "https://user:pass@example.com/"},
		{name: "ipv6 literal keeps brackets", in: "https://[::1]:8080/x", want: "https://[::1]:8080/x"},
		{name: "query apostrophe is encoded for a special scheme", in: "https://example.com?q=it's", want: "https://example.com/?q=it%27s"},
		{name: "fragment is kept", in: "https://example.com#frag", want: "https://example.com/#frag"},
		{name: "query and fragment together", in: "https://example.com/p?a=1&b=2#c", want: "https://example.com/p?a=1&b=2#c"},
		{name: "leading slashes after the scheme collapse", in: "https:///example.com/x", want: "https://example.com/x"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := normalizeSeedURL(testCase.in)
			if !ok {
				t.Fatalf("normalizeSeedURL(%q) reported invalid", testCase.in)
			}
			if got != testCase.want {
				t.Fatalf("normalizeSeedURL(%q) = %q, want %q", testCase.in, got, testCase.want)
			}
		})
	}
}

// TestNormalizeSeedURLRejects covers the inputs for which new URL() throws, and
// the unreachable schemes isURL already filters out.
func TestNormalizeSeedURLRejects(t *testing.T) {
	for _, value := range []string{
		"",
		"   ",
		"not-a-url",
		"example.com/path",
		"mailto:someone@example.com",
		"javascript:alert(1)",
		"https://",
		"https:///",
		"https://example.com:99999/x",
		"https://example.com:abc/x",
		"https://exa mple.com/",
	} {
		t.Run(value, func(t *testing.T) {
			if got, ok := normalizeSeedURL(value); ok {
				t.Fatalf("normalizeSeedURL(%q) = %q, want rejected", value, got)
			}
		})
	}
}

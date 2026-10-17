package classificationrssops

import "testing"

// TestClassifySourceByLabelAndURL pins the classifier precedence: the blog
// blacklist wins over the authoritative list, then domains and labels are tried.
func TestClassifySourceByLabelAndURL(t *testing.T) {
	policy := getDefaultNewsEventSourcePolicy()
	cases := []struct {
		name  string
		label *string
		url   *string
		want  ClassifiedSourceType
	}{
		{"authoritative domain", nil, strPtr("https://www.reuters.com/world"), ClassifiedSourceAuthoritative},
		{"authoritative subdomain", nil, strPtr("https://edition.cnn.com/2026/01/01"), ClassifiedSourceAuthoritative},
		{"authoritative label", strPtr("Reuters"), nil, ClassifiedSourceAuthoritative},
		{"multi-word label", strPtr("Associated Press"), nil, ClassifiedSourceAuthoritative},
		{"blog domain wins over the label", strPtr("Reuters"), strPtr("https://reuters.substack.com/post"), ClassifiedSourceBlog},
		{"blog label", strPtr("My Newsletter"), nil, ClassifiedSourceBlog},
		{"unknown host", nil, strPtr("https://random.example.org/post"), ClassifiedSourceUnknown},
		{"no input", nil, nil, ClassifiedSourceUnknown},
		{"relative url is not a host", nil, strPtr("example.com/post"), ClassifiedSourceUnknown},
	}
	for _, tc := range cases {
		if got := classifySourceByLabelAndURL(tc.label, tc.url, policy); got != tc.want {
			t.Fatalf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

// TestNormalizeDomainAndLabel pins the sanitizers used by the policy loader.
func TestNormalizeDomainAndLabel(t *testing.T) {
	if got := normalizeDomain("  WWW.Example.COM.  "); got != "example.com" {
		t.Fatalf("normalizeDomain = %q", got)
	}
	if got := normalizeDomain("exa mple.com"); got != "example.com" {
		t.Fatalf("normalizeDomain with a space = %q", got)
	}
	if got := normalizeLabel("  Reuters  News!  "); got != "reuters news" {
		t.Fatalf("normalizeLabel = %q", got)
	}
	if got := normalizeLabel("新华社"); got != "新华社" {
		t.Fatalf("CJK label = %q", got)
	}
}

// TestToRegistrableDomain pins the compound public suffix handling.
func TestToRegistrableDomain(t *testing.T) {
	cases := []struct{ host, want string }{
		{"edition.cnn.com", "cnn.com"},
		{"news.bbc.co.uk", "bbc.co.uk"},
		{"example.com", "example.com"},
		{"localhost", "localhost"},
	}
	for _, tc := range cases {
		got := toRegistrableDomain(&tc.host)
		if got == nil || *got != tc.want {
			t.Fatalf("toRegistrableDomain(%q) = %v, want %q", tc.host, got, tc.want)
		}
	}
}

// TestParseSourcePolicyRecord pins the stored-policy forms: a full list form, a
// version-2 delta form and malformed input.
func TestParseSourcePolicyRecord(t *testing.T) {
	fallback := getDefaultNewsEventSourcePolicy()

	full := parseSourcePolicyRecord([]byte(`{"authoritativeDomains":["example.com"],"authoritativeLabels":["Example"],"blogDomains":[],"blogLabels":[]}`), fallback)
	if len(full.AuthoritativeDomains) != 1 || full.AuthoritativeDomains[0] != "example.com" {
		t.Fatalf("full policy = %#v", full.AuthoritativeDomains)
	}
	if len(full.BlogDomains) != 0 {
		t.Fatalf("an explicit empty array must stay empty: %#v", full.BlogDomains)
	}

	delta := parseSourcePolicyRecord([]byte(`{"version":2,"delta":{"authoritativeDomainsAdd":["added.example"],"authoritativeDomainsRemove":["reuters.com"]}}`), fallback)
	found := false
	for _, domain := range delta.AuthoritativeDomains {
		if domain == "added.example" {
			found = true
		}
		if domain == "reuters.com" {
			t.Fatalf("removed domain is still present")
		}
	}
	if !found {
		t.Fatalf("delta addition missing: %#v", delta.AuthoritativeDomains)
	}

	malformed := parseSourcePolicyRecord([]byte(`not-json`), fallback)
	if len(malformed.AuthoritativeDomains) != len(fallback.AuthoritativeDomains) {
		t.Fatalf("malformed record must fall back to the defaults")
	}
	if empty := parseSourcePolicyRecord([]byte(`null`), fallback); len(empty.AuthoritativeDomains) != len(fallback.AuthoritativeDomains) {
		t.Fatalf("null record must fall back to the defaults")
	}
}

// TestBuildCategoryPrefixRegex pins the anchored, escaped prefix pattern.
func TestBuildCategoryPrefixRegex(t *testing.T) {
	if got := buildCategoryPrefixRegex("tech/ai"); got != "^tech/ai(?:/|$)" {
		t.Fatalf("regex = %q", got)
	}
	if got := buildCategoryPrefixRegex("a.b+c"); got != `^a\.b\+c(?:/|$)` {
		t.Fatalf("escaped regex = %q", got)
	}
}

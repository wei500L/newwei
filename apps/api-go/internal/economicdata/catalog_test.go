package economicdata

import "testing"

func TestCatalogMatchesDefinitionCounts(t *testing.T) {
	definitions := Catalog()
	if len(definitions) != 183 {
		t.Fatalf("definitions = %d, want 183", len(definitions))
	}
	seen := map[string]bool{}
	counts := map[ProviderKind]int{}
	for _, definition := range definitions {
		if definition.Slug == "" || definition.ID == "" {
			t.Fatalf("definition without slug/id: %+v", definition)
		}
		if seen[definition.Slug] {
			t.Fatalf("duplicate slug %s", definition.Slug)
		}
		seen[definition.Slug] = true
		counts[definition.ProviderKind]++
	}
	want := map[ProviderKind]int{ProviderAkshare: 154, ProviderFinnhub: 22, ProviderFred: 6, ProviderYfinance: 1}
	for kind, count := range want {
		if counts[kind] != count {
			t.Fatalf("%s = %d, want %d", kind, counts[kind], count)
		}
	}
}

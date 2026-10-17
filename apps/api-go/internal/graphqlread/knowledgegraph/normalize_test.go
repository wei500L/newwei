package knowledgegraph

import (
	"reflect"
	"testing"
)

func TestNormalizeSearchKeysTickerExpansion(t *testing.T) {
	suffixed := normalizeSearchKeys("600519.SH")
	wantSuffixed := []string{"600519.sh", "600519", "sh600519"}
	if !reflect.DeepEqual(suffixed, wantSuffixed) {
		t.Fatalf("600519.SH = %v, want %v", suffixed, wantSuffixed)
	}
	bare := normalizeSearchKeys("600519")
	wantBare := []string{
		"600519",
		"600519.sh", "sh600519",
		"600519.sz", "sz600519",
		"600519.bj", "bj600519",
	}
	if !reflect.DeepEqual(bare, wantBare) {
		t.Fatalf("600519 = %v, want %v", bare, wantBare)
	}
	prefixed := normalizeSearchKeys("SZ600519")
	wantPrefixed := []string{"sz600519", "600519", "600519.sz"}
	if !reflect.DeepEqual(prefixed, wantPrefixed) {
		t.Fatalf("SZ600519 = %v, want %v", prefixed, wantPrefixed)
	}
}

func TestNormalizeSearchKeysStripsCompanySuffixes(t *testing.T) {
	cases := map[string][]string{
		"贵州茅台酒股份有限公司": {
			"贵州茅台酒股份有限公司",
			"贵州茅台酒",
			"贵州茅台酒股份",
		},
		"贵州茅台酒集团有限公司": {
			"贵州茅台酒集团有限公司",
			"贵州茅台酒集团",
			"贵州茅台酒",
		},
		"Acme Corp": {
			"acme corp",
			"acme",
		},
	}
	for input, want := range cases {
		if got := normalizeSearchKeys(input); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s = %v, want %v", input, got, want)
		}
	}
}

func TestNormalizeSearchKeysDropsBracketedNames(t *testing.T) {
	got := normalizeSearchKeys("  贵州茅台酒股份有限公司（600519） ")
	want := []string{
		"贵州茅台酒股份有限公司（600519）",
		"贵州茅台酒股份有限公司",
		"贵州茅台酒",
		"贵州茅台酒股份",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bracket name = %v, want %v", got, want)
	}
}

func TestNormalizeSearchKeysCollapsesWhitespace(t *testing.T) {
	got := normalizeSearchKeys("  Acme \t\n  Holdings  ")
	want := []string{"acme holdings"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("whitespace = %v, want %v", got, want)
	}
	if keys := normalizeSearchKeys("   "); len(keys) != 0 {
		t.Fatalf("blank name = %v", keys)
	}
}

func TestParseTickerRejectsNonTickers(t *testing.T) {
	for _, input := range []string{"60051", "6005191", "600519.HK", "SH60051", "贵州茅台"} {
		if parseTicker(input) != nil {
			t.Fatalf("%s parsed as a ticker", input)
		}
	}
	if !looksLikeTicker(" BJ600519 ") {
		t.Fatal("BJ600519 should be a ticker")
	}
}

package aisrelay

import (
	"encoding/json"
	"testing"
)

// Candidate classification contract, from apps/ais-relay/src/candidate-classification.ts:
// a vessel is a military candidate when its ShipType is 35 or 50-59, when its upper-cased
// name starts with a naval prefix, or when it contains a military keyword.

func relayTestMeta(t *testing.T, payload string) map[string]json.RawMessage {
	t.Helper()

	var meta map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &meta); err != nil {
		t.Fatalf("json.Unmarshal(%s) error = %v", payload, err)
	}
	return meta
}

func TestNormalizeMmsiMatchesJavaScript(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		// A finite number becomes String(Math.trunc(value)).
		{"integer number", `123456789`, "123456789", true},
		{"fractional number truncates", `123456789.9`, "123456789", true},
		{"negative truncates toward zero", `-123.9`, "-123", true},
		// String(Math.trunc(-0)) is "0", not "-0".
		{"negative zero", `-0`, "0", true},
		// String(1e21) is "1e+21": the truncation path uses JS number formatting.
		{"exponent form", `1e21`, "1e+21", true},
		// A string goes through normalizeString: trimmed, and blank is absent.
		{"padded string", `"  123456789  "`, "123456789", true},
		{"blank string", `"   "`, "", false},
		{"empty string", `""`, "", false},
		{"non numeric string is kept", `"unknown"`, "unknown", true},
		// Non string, non number values are absent.
		{"null", `null`, "", false},
		{"boolean", `true`, "", false},
		{"object", `{"a":1}`, "", false},
		{"array", `[1,2]`, "", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizeMmsiRaw(json.RawMessage(testCase.raw))
			if testCase.ok {
				if got == nil {
					t.Fatalf("normalizeMmsiRaw(%s) = nil, want %q", testCase.raw, testCase.want)
				}
				if *got != testCase.want {
					t.Fatalf("normalizeMmsiRaw(%s) = %q, want %q", testCase.raw, *got, testCase.want)
				}
				return
			}
			if got != nil {
				t.Fatalf("normalizeMmsiRaw(%s) = %q, want absent", testCase.raw, *got)
			}
		})
	}
}

func TestGetNumberMatchesJavaScript(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want float64
		ok   bool
	}{
		{"number", `5`, 5, true},
		{"zero is present", `0`, 0, true},
		{"fraction", `-0.5`, -0.5, true},
		{"numeric string", `"5"`, 5, true},
		{"padded numeric string", `"  7  "`, 7, true},
		{"hex string", `"0x10"`, 16, true},
		{"exponent string", `"1e3"`, 1000, true},
		// getNumber checks `value.trim() !== ""` before Number(), so blanks are absent
		// rather than 0.
		{"empty string", `""`, 0, false},
		{"blank string", `"   "`, 0, false},
		{"non numeric string", `"abc"`, 0, false},
		{"infinite string", `"Infinity"`, 0, false},
		{"null", `null`, 0, false},
		{"missing", ``, 0, false},
		{"boolean", `true`, 0, false},
		{"array", `[1]`, 0, false},
		{"object", `{"a":1}`, 0, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := getNumberRaw(json.RawMessage(testCase.raw))
			if !testCase.ok {
				if got != nil {
					t.Fatalf("getNumberRaw(%s) = %v, want absent", testCase.raw, *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("getNumberRaw(%s) = absent, want %v", testCase.raw, testCase.want)
			}
			if *got != testCase.want {
				t.Fatalf("getNumberRaw(%s) = %v, want %v", testCase.raw, *got, testCase.want)
			}
		})
	}
}

func TestCandidateShipTypeRules(t *testing.T) {
	cases := []struct {
		shipType string
		want     bool
	}{
		// 35 is military operations; 50-59 is the special craft band the Node relay
		// treats as a candidate. Everything else must not match on type alone.
		{`35`, true},
		{`50`, true},
		{`52`, true},
		{`59`, true},
		{`34`, false},
		{`36`, false},
		{`49`, false},
		{`60`, false},
		{`70`, false},
		{`0`, false},
		// The type may arrive as a numeric string, which getNumber accepts.
		{`"35"`, true},
		{`"50"`, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.shipType, func(t *testing.T) {
			meta := relayTestMeta(t, `{"ShipType":`+testCase.shipType+`,"ShipName":"Neutral Trader"}`)
			if got := isLikelyMilitaryCandidate(meta); got != testCase.want {
				t.Fatalf("ShipType %s: isLikelyMilitaryCandidate = %v, want %v", testCase.shipType, got, testCase.want)
			}
		})
	}
}

func TestCandidateNavalPrefixes(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// Every alternative of NAVAL_PREFIX_RE followed by the required boundary.
		{"USS Cole", true},
		{"USNS Supply", true},
		{"HMS Victory", true},
		{"HMAS Ballarat", true},
		{"HMCS Halifax", true},
		{"INS Vikramaditya", true},
		{"JS Kaga", true},
		{"ROKS Sejong", true},
		{"TCG Anadolu", true},
		{"FS Courbet", true},
		{"BNS Bangabandhu", true},
		{"RFS Admiral", true},
		{"PLAN Shandong", true},
		{"PLA Navy Ship", true},
		{"CGC Bertholf", true},
		{"PNS Tariq", true},
		{"KRI Diponegoro", true},
		{"ITS Cavour", true},
		{"SNS Asturias", true},
		{"MMSI 123", true},
		{"USCG Munro", true},
		{"CCG Cutter", true},
		{"PCG Vessel", true},
		{"CG Cutter", true},
		// The prefix is followed by `\b` or by "-"/whitespace.
		{"HMS-Victory", true},
		{"HMS\tVictory", true},
		{"HMS\u00a0Victory", true},
		// A prefix that runs straight into the rest of a word has no boundary and must
		// not match: `\b` requires a non-word character or the end of the string.
		{"USSVictory", false},
		{"HMSVictory", false},
		{"PLANShandong", false},
		// The anchor is at the start: a prefix in the middle is not a match.
		{"The USS Cole", false},
		// Case is ignored because the name is upper-cased before matching.
		{"uss cole", true},
		// A bare prefix at the end of the string is a word boundary.
		{"HMS", true},
		// Unrelated names must not match.
		{"Cargo One", false},
		{"Merchant Vessel", false},
		{"", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			meta := relayTestMeta(t, `{"ShipName":`+relayTestJSONString(t, testCase.name)+`}`)
			if got := isLikelyMilitaryCandidate(meta); got != testCase.want {
				t.Fatalf("ShipName %q: isLikelyMilitaryCandidate = %v, want %v", testCase.name, got, testCase.want)
			}
		})
	}
}

func TestCandidateMilitaryKeywords(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"WARSHIP", true},
		{"NAVY", true},
		{"NAVAL", true},
		{"COAST GUARD Cutter", true},
		// `COAST\s+GUARD` accepts any run of whitespace, and JS `\s` includes the
		// Unicode spaces that Go's `\s` would miss.
		{"COAST  GUARD", true},
		{"COAST\tGUARD", true},
		{"COAST\u00a0GUARD", true},
		{"COAST\u3000GUARD", true},
		{"PATROL", true},
		{"CUSTOMS", true},
		{"POLICE", true},
		// Keywords match on word boundaries, so an embedded keyword does not count.
		{"SUPERNAVY", false},
		{"COASTGUARD", false},
		// Keyword detection is case insensitive.
		{"coast guard", true},
		{"navy", true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			meta := relayTestMeta(t, `{"ShipName":`+relayTestJSONString(t, testCase.name)+`}`)
			if got := isLikelyMilitaryCandidate(meta); got != testCase.want {
				t.Fatalf("ShipName %q: isLikelyMilitaryCandidate = %v, want %v", testCase.name, got, testCase.want)
			}
		})
	}
}

func TestCandidateNonASCIINameHandling(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  bool
	}{
		// JS upper-cases "ß" to "SS", so this name becomes "USS BOAT" and matches the USS
		// prefix. A plain rune-by-rune Go upper-case would leave "Uß BOAT" and miss it.
		{"sharp s creates a naval prefix", "U\u00df Boat", true},
		// The fi ligature expands to FI, which alone is not a pattern, but the sharp-s rule
		// above is the discriminating case; here both implementations agree.
		{"ligature without keyword", "o\ufb00shore supply", false},
		{"accented name", "\u00c9toile", false},
		{"cyrillic name", "\u041d\u0430\u0432\u0430\u0440\u0438\u043d", false},
		// A non-ASCII name that still contains an ASCII keyword matches.
		{"cyrillic plus keyword", "\u041d\u0430\u0432\u0430\u0440\u0438\u043d NAVY", true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			meta := relayTestMeta(t, `{"ShipName":`+relayTestJSONString(t, testCase.input)+`}`)
			if got := isLikelyMilitaryCandidate(meta); got != testCase.want {
				t.Fatalf("ShipName %q: isLikelyMilitaryCandidate = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestCandidateFieldLookupIsCaseSensitive(t *testing.T) {
	// The Node relay reads meta.ShipType / meta.ShipName as object properties, so a
	// differently cased key is simply absent. encoding/json's struct decoding falls back to
	// a case-insensitive match, which is why the payload member lookup stays map based.
	cases := []struct {
		name    string
		payload string
	}{
		{"lowercase ship type", `{"shiptype":35}`},
		{"uppercase ship name", `{"SHIPNAME":"USS Cole"}`},
		{"mixed case ship name", `{"Shipname":"USS Cole"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if isLikelyMilitaryCandidate(relayTestMeta(t, testCase.payload)) {
				t.Fatalf("payload %s was treated as a candidate; field lookup must be case sensitive", testCase.payload)
			}
		})
	}
}

func TestCandidateIgnoresMissingOrBlankName(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    bool
	}{
		{"no name field", `{"ShipType":70}`, false},
		{"blank name", `{"ShipName":"   "}`, false},
		{"non string name", `{"ShipName":42}`, false},
		{"null name", `{"ShipName":null}`, false},
		// A blank name does not block the type rule.
		{"blank name with military type", `{"ShipName":"   ","ShipType":35}`, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isLikelyMilitaryCandidate(relayTestMeta(t, testCase.payload)); got != testCase.want {
				t.Fatalf("payload %s: isLikelyMilitaryCandidate = %v, want %v", testCase.payload, got, testCase.want)
			}
		})
	}
}

func relayTestJSONString(t *testing.T, value string) string {
	t.Helper()

	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal(%q) error = %v", value, err)
	}
	return string(encoded)
}

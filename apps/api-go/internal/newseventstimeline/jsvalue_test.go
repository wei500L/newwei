package newseventstimeline

import (
	"testing"
	"time"
)

// TestJSRound pins Math.round, including the 0.49999999999999994 case where
// math.Floor(x+0.5) would return 1.
func TestJSRound(t *testing.T) {
	cases := []struct {
		input float64
		want  float64
	}{
		{0.49999999999999994, 0},
		{0.5, 1},
		{0.4999, 0},
		{1.5, 2},
		{2.5, 3},
		{-0.5, 0},
		{-1.5, -1},
		{-2.5, -2},
		{1e-9, 0},
		{1476.4, 1476},
		{1476.5, 1477},
	}
	for _, test := range cases {
		if got := jsRound(test.input); got != test.want {
			t.Errorf("jsRound(%v) = %v, want %v", test.input, got, test.want)
		}
	}
}

// TestJSToFixed pins Number.prototype.toFixed, including the exact-half cases
// where Go's FormatFloat resolves ties to even.
func TestJSToFixed(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   string
	}{
		{0.0625, 3, "0.063"},
		{12.25, 1, "12.3"},
		{1.005, 2, "1.00"},
		{2.675, 2, "2.67"},
		{0.05, 1, "0.1"},
		{1.45, 1, "1.4"},
		{2.5, 0, "3"},
		{-0.0001, 3, "-0.000"},
		{0, 1, "0.0"},
		{-0, 3, "0.000"},
		{100, 1, "100.0"},
		{0.510825623, 3, "0.511"},
		{-1.5, 0, "-2"},
		{0.0004, 3, "0.000"},
		{0.0005, 3, "0.001"},
	}
	for _, test := range cases {
		if got := jsToFixed(test.value, test.digits); got != test.want {
			t.Errorf("jsToFixed(%v, %d) = %q, want %q", test.value, test.digits, got, test.want)
		}
	}
}

// TestJSTrimAndSpaces pins the JavaScript whitespace set: U+FEFF is trimmed and
// U+0085 is not, which is the opposite of strings.TrimSpace.
func TestJSTrimAndSpaces(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"\ufeff a \ufeff", "a"},
		{"\u0085a", "\u0085a"},
		{"\u00a0a\u3000", "a"},
		{"\u2000\u200aa", "a"},
		{"\t\n\v\f\r a", "a"},
		{"a\u2028\u2029", "a"},
		{"  ", ""},
	}
	for _, test := range cases {
		if got := jsTrim(test.input); got != test.want {
			t.Errorf("jsTrim(%q) = %q, want %q", test.input, got, test.want)
		}
	}
	// U+0085 must not be treated as whitespace on its own either.
	if jsIsSpace('\u0085') {
		t.Error("jsIsSpace(U+0085) = true, JavaScript does not treat NEL as whitespace")
	}
	if !jsIsSpace('\ufeff') {
		t.Error("jsIsSpace(U+FEFF) = false, JavaScript treats the BOM as whitespace")
	}
}

// TestJSCaseMapping pins the full case mappings that simple per-rune casing gets
// wrong.
func TestJSCaseMapping(t *testing.T) {
	if got := jsToUpper("ß"); got != "SS" {
		t.Errorf(`jsToUpper("ß") = %q, want "SS"`, got)
	}
	if got := jsToLower("İ"); got != "i̇" {
		t.Errorf(`jsToLower("İ") = %q, want "i̇"`, got)
	}
	if got := jsToUpper("straße"); got != "STRASSE" {
		t.Errorf(`jsToUpper("straße") = %q, want "STRASSE"`, got)
	}
}

// TestCapitalizeWord pins charAt(0).toUpperCase() + slice(1).
func TestCapitalizeWord(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"tech", "Tech"},
		{"ßtest", "SStest"},
		{"", "Mixed"},
		{"   ", "Mixed"},
		{"éclair", "Éclair"},
		// charAt(0) splits the surrogate pair and a lone surrogate uppercases to
		// itself, so the result is the input.
		{"𝄞abc", "𝄞abc"},
	}
	for _, test := range cases {
		if got := capitalizeWord(test.input); got != test.want {
			t.Errorf("capitalizeWord(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

// TestObjectKeyOrder pins the Object.keys order rule: canonical array indices
// ascending first, then the remaining keys in insertion order.
func TestObjectKeyOrder(t *testing.T) {
	cases := []struct {
		input []string
		want  []string
	}{
		{[]string{"10", "2", "b", "a"}, []string{"2", "10", "b", "a"}},
		{[]string{"b", "a"}, []string{"b", "a"}},
		{[]string{"0", "01", "1"}, []string{"0", "1", "01"}},
		{[]string{"4294967295", "5"}, []string{"5", "4294967295"}},
		{[]string{"-1", "1.5", "x"}, []string{"-1", "1.5", "x"}},
		{[]string{"tech/ai", "uncategorized"}, []string{"tech/ai", "uncategorized"}},
	}
	for _, test := range cases {
		got := objectKeyOrder(test.input)
		if len(got) != len(test.want) {
			t.Fatalf("objectKeyOrder(%v) = %v, want %v", test.input, got, test.want)
		}
		for index := range got {
			if got[index] != test.want[index] {
				t.Fatalf("objectKeyOrder(%v) = %v, want %v", test.input, got, test.want)
			}
		}
	}
}

// TestUTF16Order pins the default sort comparator on code units.
func TestUTF16Order(t *testing.T) {
	values := []string{"c02", "c10", "c2", "B", "a"}
	// Byte order and UTF-16 code-unit order agree for these ASCII ids: digits
	// sort before uppercase letters and uppercase before lowercase.
	want := []string{"B", "a", "c02", "c10", "c2"}
	for index := 0; index < len(values); index++ {
		for other := index + 1; other < len(values); other++ {
			if utf16Less(values[other], values[index]) {
				values[index], values[other] = values[other], values[index]
			}
		}
	}
	for index := range values {
		if values[index] != want[index] {
			t.Fatalf("utf16 sort = %v, want %v", values, want)
		}
	}
}

// TestParseJSTimestamp pins the Date.parse subset used for bucket retention.
func TestParseJSTimestamp(t *testing.T) {
	want := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	utc, ok := parseJSTimestamp("2026-10-20T00:00:00.000Z")
	if !ok || utc != want {
		t.Fatalf("parseJSTimestamp toISOString = %d/%v, want %d", utc, ok, want)
	}
	dateOnly, ok := parseJSTimestamp("2026-10-20")
	if !ok || dateOnly != want {
		t.Fatalf("parseJSTimestamp date-only = %d/%v, want %d (UTC midnight)", dateOnly, ok, want)
	}
	withOffset, ok := parseJSTimestamp("2026-10-20T03:00:00.000+03:00")
	if !ok || withOffset != want {
		t.Fatalf("parseJSTimestamp offset = %d/%v, want %d", withOffset, ok, want)
	}
	for _, invalid := range []string{"", "not-a-date", "2026-13-01", "2026-10-20T25:00:00Z", "10/20/2026"} {
		if _, ok := parseJSTimestamp(invalid); ok {
			t.Errorf("parseJSTimestamp(%q) parsed an unsupported form", invalid)
		}
	}
}

// TestNextWallClockDelay pins the wall-clock alignment shared by both schedulers.
func TestNextWallClockDelay(t *testing.T) {
	midTick := time.Date(2026, 10, 20, 10, 7, 30, 0, time.UTC)
	if got := nextWallClockDelay(midTick, tickInterval); got != 2*time.Minute+30*time.Second {
		t.Errorf("nextWallClockDelay(%v, 10m) = %v, want 2m30s", midTick, got)
	}
	// A boundary that is already in the past never fires immediately; the next
	// tick is a full interval later, like @nestjs/schedule's strictly-future cron.
	aligned := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	if got := nextWallClockDelay(aligned, tickInterval); got != tickInterval {
		t.Errorf("nextWallClockDelay(%v, 10m) = %v, want 10m", aligned, got)
	}
	almostHourly := time.Date(2026, 10, 20, 10, 59, 0, 0, time.UTC)
	if got := nextWallClockDelay(almostHourly, time.Hour); got != time.Minute {
		t.Errorf("nextWallClockDelay(%v, 1h) = %v, want 1m", almostHourly, got)
	}
}

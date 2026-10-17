package classificationrssops

import "testing"

// TestNormalizePathRejectsSlashOnly pins the defect-2 guard precondition: a path
// made only of slashes normalizes to nil instead of an empty string.
func TestNormalizePathRejectsSlashOnly(t *testing.T) {
	for _, raw := range []string{"///", "/", "   ", "", " / // "} {
		if got := normalizePath(raw); got != nil {
			t.Fatalf("normalizePath(%q) = %q, want nil", raw, *got)
		}
	}
}

// TestNormalizePathCollapsesAndLowercases pins the documented normalization.
func TestNormalizePathCollapsesAndLowercases(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"  Tech/AI//Models  ", "tech/ai/models"},
		{"/Tech/AI/", "tech/ai"},
		{"Tech", "tech"},
	}
	for _, tc := range cases {
		got := normalizePath(tc.raw)
		if got == nil || *got != tc.want {
			t.Fatalf("normalizePath(%q) = %v, want %q", tc.raw, got, tc.want)
		}
	}
}

// TestNormalizePathCapsAt160Units pins the length cap.
func TestNormalizePathCapsAt160Units(t *testing.T) {
	long := ""
	for len(long) < 200 {
		long += "a"
	}
	got := normalizePath(long)
	if got == nil || utf16Length(*got) != 160 {
		t.Fatalf("normalizePath length = %v", got)
	}
}

// TestNormalizeTextAndQuickTags pins the text and quick-tag helpers.
func TestNormalizeTextAndQuickTags(t *testing.T) {
	if normalizeText("   ", 500) != nil {
		t.Fatalf("blank text must normalize to nil")
	}
	if got := normalizeText("  hello  ", 500); got == nil || *got != "hello" {
		t.Fatalf("normalizeText = %v", got)
	}
	tags := normalizeQuickTags([]string{" AI ", "ai", "", "News", "NEWS"})
	if len(tags) != 2 || tags[0] != "ai" || tags[1] != "news" {
		t.Fatalf("normalizeQuickTags = %#v", tags)
	}
	long := ""
	for len(long) < 80 {
		long += "x"
	}
	capped := normalizeQuickTags([]string{long})
	if len(capped) != 1 || utf16Length(capped[0]) != 60 {
		t.Fatalf("quick tag cap = %#v", capped)
	}
}

// TestExtractCategoryPrefixAndBand pins the summary keys.
func TestExtractCategoryPrefixAndBand(t *testing.T) {
	if got := extractCategoryPrefix(nil); got != "unknown" {
		t.Fatalf("nil path prefix = %q", got)
	}
	if got := extractCategoryPrefix(strPtr("tech/ai/models")); got != "tech/ai" {
		t.Fatalf("prefix = %q, want tech/ai", got)
	}
	if got := extractCategoryPrefix(strPtr("///")); got != "unknown" {
		t.Fatalf("slash-only prefix = %q", got)
	}
	if toConfidenceBand(0.39) != ConfidenceBandLow ||
		toConfidenceBand(0.4) != ConfidenceBandMedium ||
		toConfidenceBand(0.74) != ConfidenceBandMedium ||
		toConfidenceBand(0.75) != ConfidenceBandHigh {
		t.Fatalf("confidence band boundaries drifted")
	}
}

// TestValidObjectIDMatchesMongoose pins the 12/24 rule behind defect 1.
func TestValidObjectIDMatchesMongoose(t *testing.T) {
	valid := []string{
		"507f1f77bcf86cd799439011",
		"507F1F77BCF86CD799439011",
		"abcdefghijkl",
	}
	invalid := []string{
		"not-an-object-id",
		"",
		"507f1f77bcf86cd79943901",
		"507f1f77bcf86cd7994390111",
		"507f1f77bcf86cd79943901z",
	}
	for _, value := range valid {
		if !validObjectID(value) {
			t.Fatalf("validObjectID(%q) = false, want true", value)
		}
	}
	for _, value := range invalid {
		if validObjectID(value) {
			t.Fatalf("validObjectID(%q) = true, want false", value)
		}
	}
}

// TestParseQualityWindow pins the default and the 400 message.
func TestParseQualityWindow(t *testing.T) {
	if window, err := parseQualityWindow(""); err != nil || window != QualityWindow24h {
		t.Fatalf("default window = %v (%v)", window, err)
	}
	if window, err := parseQualityWindow("7d"); err != nil || window != QualityWindow7d {
		t.Fatalf("7d window = %v (%v)", window, err)
	}
	_, err := parseQualityWindow("30d")
	if status, message, ok := statusOf(err); !ok || status != 400 {
		t.Fatalf("invalid window error = %v", err)
	} else if message != "window must be one of the following values: 1h, 24h, 7d" {
		t.Fatalf("invalid window message = %q", message)
	}
}

// TestParseOptionalBooleanQuery pins the onlyUnreviewed transform.
func TestParseOptionalBooleanQuery(t *testing.T) {
	cases := []struct {
		raw     string
		value   bool
		present bool
		invalid bool
	}{
		{"", false, false, false},
		{"true", true, true, false},
		{"1", true, true, false},
		{"FALSE", false, true, false},
		{"0", false, true, false},
		{"maybe", false, false, true},
	}
	for _, tc := range cases {
		value, present, err := parseOptionalBooleanQuery(tc.raw)
		if tc.invalid {
			if err == nil {
				t.Fatalf("onlyUnreviewed=%q must be rejected", tc.raw)
			}
			continue
		}
		if err != nil || value != tc.value || present != tc.present {
			t.Fatalf("onlyUnreviewed=%q -> %v/%v (%v)", tc.raw, value, present, err)
		}
	}
}

// TestParseOptionalIntQuery pins the limit clamping inside the DTO bounds.
func TestParseOptionalIntQuery(t *testing.T) {
	if value, err := parseOptionalIntQuery("", "limit", 1, 200); err != nil || value != nil {
		t.Fatalf("empty limit = %v (%v)", value, err)
	}
	if value, err := parseOptionalIntQuery("12", "limit", 1, 200); err != nil || value == nil || *value != 12 {
		t.Fatalf("limit=12 -> %v (%v)", value, err)
	}
	if _, err := parseOptionalIntQuery("0", "limit", 1, 200); err == nil {
		t.Fatalf("limit=0 must be rejected")
	}
	if _, err := parseOptionalIntQuery("201", "limit", 1, 200); err == nil {
		t.Fatalf("limit=201 must be rejected")
	}
	if _, err := parseOptionalIntQuery("abc", "limit", 1, 200); err == nil {
		t.Fatalf("limit=abc must be rejected")
	}
}

// TestParseJSTimeAndCursor pins the cursor parsing leniency.
func TestParseJSTimeAndCursor(t *testing.T) {
	if parseJSDate("not-a-date") != nil {
		t.Fatalf("invalid date must parse to nil")
	}
	if parseJSDate("2026-10-17T12:00:00.000Z") == nil {
		t.Fatalf("ISO timestamp must parse")
	}
	if parseJSDate("2026-10-17") == nil {
		t.Fatalf("date-only string must parse")
	}
	if parseCursor(nil) != nil {
		t.Fatalf("nil cursor must stay nil")
	}
	if parseCursor(strPtr("nope")) != nil {
		t.Fatalf("unparseable cursor must be ignored")
	}
}

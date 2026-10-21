package crawlworker

import (
	"strings"
	"testing"
)

func TestTruncateTextUsesUTF16CodeUnits(t *testing.T) {
	cases := []struct {
		name  string
		value string
		max   int
		want  string
	}{
		{"shorter", "hello", 10, "hello"},
		{"exact length", "hello", 5, "hello"},
		{"trims the input", "  hello  ", 10, "hello"},
		{"cut", "abcdef", 4, "abc…"},
		{"cut at one", "abc", 1, "…"},
		{"zero max", "abc", 0, ""},
		{"trailing spaces before the ellipsis", "ab   cd", 5, "ab…"},
		{"astral character below the cut", "a😀bc", 4, "a😀…"},
		{"astral character split by the cut", "a😀bc", 3, "a…"},
		{"astral character alone", "😀", 2, "😀"},
		{"astral character truncated", "😀😀", 3, "😀…"},
		{"dangling high surrogate before whitespace", "ab \U0001F600", 4, "ab…"},
	}
	for _, testCase := range cases {
		if got := truncateText(testCase.value, testCase.max); got != testCase.want {
			t.Errorf("%s: truncateText(%q,%d) = %q, want %q",
				testCase.name, testCase.value, testCase.max, got, testCase.want)
		}
	}
}

func TestTruncateTextMeasuresLikeJavaScript(t *testing.T) {
	// "a😀bc" is 5 UTF-16 code units but 4 runes. A rune-based truncation would
	// keep the string at max 4 and return "a😀b…"; JavaScript keeps it unchanged.
	if utf16Length("a😀bc") != 5 {
		t.Fatalf("utf16Length = %d, want 5", utf16Length("a😀bc"))
	}
	if got := truncateText("a😀bc", 5); got != "a😀bc" {
		t.Fatalf("truncateText at the exact unit length = %q", got)
	}
	long := strings.Repeat("x", 3_999) + "😀tail"
	if got := truncateText(long, maxErrorText); utf16Length(got) != maxErrorText {
		t.Fatalf("truncated length = %d UTF-16 units, want %d", utf16Length(got), maxErrorText)
	}
	// The VARCHAR(191) fallback keeps the same unit semantics.
	got := truncateText(strings.Repeat("y", 200), mysqlVarchar191)
	if utf16Length(got) != mysqlVarchar191 {
		t.Fatalf("191 truncation length = %d units", utf16Length(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("191 truncation = %q, want a trailing ellipsis", got[len(got)-5:])
	}
}

func TestTrimTextUsesTheJavaScriptWhitespaceSet(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{"spaces", "  value  ", "value"},
		{"tabs and newlines", "\t\nvalue\r\n", "value"},
		{"no-break space", "\u00a0value\u00a0", "value"},
		{"zero width no-break space", "\ufeffvalue\ufeff", "value"},
		{"ideographic space", "\u3000value\u3000", "value"},
		{"narrow no-break space", "\u202fvalue\u202f", "value"},
		{"line separator", "\u2028value\u2029", "value"},
		// Go's unicode.IsSpace trims U+0085 (NEXT LINE); ECMAScript does not.
		{"next line is not whitespace in JavaScript", "\u0085value", "\u0085value"},
	}
	for _, testCase := range cases {
		if got := trimText(testCase.value); got != testCase.want {
			t.Errorf("%s: trimText(%q) = %q, want %q", testCase.name, testCase.value, got, testCase.want)
		}
	}
}

func TestTrimEndText(t *testing.T) {
	if got := trimEndText("value\t \u00a0"); got != "value" {
		t.Fatalf("trimEndText = %q", got)
	}
	if got := trimEndText("  value"); got != "  value" {
		t.Fatalf("trimEndText must not trim the leading space: %q", got)
	}
}

package crawl4ai

import (
	"strings"
	"testing"
)

// TestBuildJSCodePayloadNormalizesLikeNestJS pins the trim/filter step of
// Crawl4aiClient.normalizeJsCode: blank entries are dropped before the array
// size limit applies, the trimmed text is what the request carries, and one
// script is sent as a string while several are sent as an array.
func TestBuildJSCodePayloadNormalizesLikeNestJS(t *testing.T) {
	t.Run("blank entries are dropped and the script is trimmed", func(t *testing.T) {
		payload, err := buildJSCodePayload(
			[]string{"", "   ", "  document.querySelector('a').click()  ", "\t"},
			true,
		)
		if err != nil {
			t.Fatal(err)
		}
		want := `"document.querySelector('a').click()"`
		if string(payload) != want {
			t.Fatalf("payload = %s, want %s", payload, want)
		}
	})

	t.Run("several scripts keep the array shape", func(t *testing.T) {
		payload, err := buildJSCodePayload(
			[]string{"window.scrollTo(0, 1)", "window.scrollTo(0, 2)"},
			true,
		)
		if err != nil {
			t.Fatal(err)
		}
		want := `["window.scrollTo(0, 1)","window.scrollTo(0, 2)"]`
		if string(payload) != want {
			t.Fatalf("payload = %s, want %s", payload, want)
		}
	})

	t.Run("blank entries do not count towards the array limit", func(t *testing.T) {
		// Six entries but only two real scripts: NestJS normalizes first, so the
		// five-script limit does not fire.
		payload, err := buildJSCodePayload(
			[]string{"window.scrollTo(0, 1)", "", "  ", "", "", "window.scrollTo(0, 2)"},
			true,
		)
		if err != nil {
			t.Fatal(err)
		}
		if len(payload) == 0 {
			t.Fatal("expected a payload for the two real scripts")
		}
	})

	t.Run("six real scripts are rejected", func(t *testing.T) {
		scripts := make([]string, 0, maxJSScriptsCount+1)
		for index := 0; index <= maxJSScriptsCount; index++ {
			scripts = append(scripts, "window.scrollTo(0, 1)")
		}
		if _, err := buildJSCodePayload(scripts, true); err == nil {
			t.Fatal("expected the array limit to reject six scripts")
		}
	})

	t.Run("a disabled feature drops jsCode", func(t *testing.T) {
		payload, err := buildJSCodePayload([]string{"window.scrollTo(0, 1)"}, false)
		if err != nil {
			t.Fatal(err)
		}
		if payload != nil {
			t.Fatalf("payload = %s, want nil", payload)
		}
	})
}

// TestValidateJSCodeLengthCountsUTF16Units pins the length limit unit: the
// NestJS validator compares String.prototype.length (UTF-16 code units), so a
// script with non-ASCII text must not be rejected earlier by its byte length.
func TestValidateJSCodeLengthCountsUTF16Units(t *testing.T) {
	// 999 CJK characters plus "//": 1001 UTF-16 code units but 2999 bytes.
	accepted := "//" + strings.Repeat("注", maxJSScriptLength/2-1)
	if blocked := validateJSCode(accepted); len(blocked) != 0 {
		t.Fatalf("blocked = %v, want none: the script is within the UTF-16 limit", blocked)
	}

	// 2002 ASCII code units exceed the limit in both runtimes.
	rejected := "//" + strings.Repeat("a", maxJSScriptLength+1)
	if blocked := validateJSCode(rejected); len(blocked) == 0 {
		t.Fatal("expected the length limit to reject a script over the limit")
	}
}

// TestNormalizeJSCodeListUsesJSWhitespace pins String.prototype.trim: U+FEFF is
// trimmed by JavaScript while Go's unicode.IsSpace keeps it.
func TestNormalizeJSCodeListUsesJSWhitespace(t *testing.T) {
	normalized := normalizeJSCodeList([]string{"\ufeffwindow.scrollTo(0, 1)\ufeff"})
	if len(normalized) != 1 {
		t.Fatalf("normalized = %v", normalized)
	}
	if normalized[0] != "window.scrollTo(0, 1)" {
		t.Fatalf("script = %q", normalized[0])
	}
}

package aisrelay

import (
	"encoding/json"
	"math"
	"testing"
)

// JavaScript primitive semantics the wire contract depends on. Expected values are
// derived from the ECMAScript specification (Number::toString, Math.round,
// String.prototype.trim, Number(string), String.prototype.toUpperCase) rather than
// from capturing output of the Node relay, which this batch must not run.

func TestJSONNumberFormattingMatchesJavaScript(t *testing.T) {
	// Both values below must be computed at run time: a Go constant expression evaluates
	// 0.1+0.2 exactly and would lose the binary artefact that JavaScript shows, and the
	// literal -0.0 is an untyped constant zero (negative zero needs math.Copysign).
	negativeZero := math.Copysign(0, -1)
	left, right := 0.1, 0.2
	binaryArtefact := left + right

	cases := []struct {
		name  string
		value float64
		want  string
	}{
		// Integers and simple decimals print without a fractional part.
		{"integer", 100, "100"},
		{"latitude", 26.5, "26.5"},
		{"negative latitude", -79.5, "-79.5"},
		{"integer valued float", 27, "27"},
		// ±0 both render as "0": String(-0) === "0" and JSON.stringify(-0) === "0".
		{"positive zero", 0, "0"},
		{"negative zero", negativeZero, "0"},
		// The fixed/exponential threshold sits at 1e21, not at Go's 1e6.
		{"below exponential threshold", 1234567, "1234567"},
		{"largest fixed magnitude", 1e20, "100000000000000000000"},
		{"exponential threshold", 1e21, "1e+21"},
		{"exponent is signed and unpadded", 1e-7, "1e-7"},
		{"smallest fixed magnitude", 1e-6, "0.000001"},
		{"large exponent", 1e300, "1e+300"},
		{"subnormal", 5e-324, "5e-324"},
		{"max float", 1.7976931348623157e308, "1.7976931348623157e+308"},
		// Shortest round-trip decimal, exactly as JS prints it.
		{"binary float artefact", binaryArtefact, "0.30000000000000004"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := jsNumberString(testCase.value); got != testCase.want {
				t.Fatalf("jsNumberString(%v) = %q, want %q", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestJSONNumberMarshalMatchesFormatting(t *testing.T) {
	// The snapshot structs carry jsNumber fields; marshalling must emit the bare number
	// rather than a quoted string or a Go-formatted float.
	payload := struct {
		Sequence int      `json:"sequence"`
		Lat      jsNumber `json:"lat"`
		Lon      jsNumber `json:"lon"`
		Speed    jsNumber `json:"speed"`
	}{Sequence: 1, Lat: -0.5, Lon: 1e21, Speed: 12.5}

	encoded, err := encodeJSJSON(payload)
	if err != nil {
		t.Fatalf("encodeJSJSON() error = %v", err)
	}
	const want = `{"sequence":1,"lat":-0.5,"lon":1e+21,"speed":12.5}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s, want %s", encoded, want)
	}
}

func TestJSRound(t *testing.T) {
	// Math.round rounds an exact tie toward +Infinity: Math.round(-1.5) === -1 and
	// Math.round(-0.5) === -0, unlike math.Round which rounds away from zero.
	cases := []struct {
		value float64
		want  int
	}{
		{0.4, 0},
		{0.5, 1},
		{1.5, 2},
		{2.5, 3},
		{-0.5, 0},
		{-1.5, -1},
		{-2.5, -2},
		{0.49999999999999994, 0},
		{-75, -75},
	}
	for _, testCase := range cases {
		if got := jsRoundToInt(testCase.value); got != testCase.want {
			t.Fatalf("jsRoundToInt(%v) = %d, want %d", testCase.value, got, testCase.want)
		}
	}
}

func TestJSTrunc(t *testing.T) {
	// Math.trunc drops the fraction toward zero.
	cases := map[float64]float64{1.9: 1, -1.9: -1, -0.5: 0, 88: 88}
	for value, want := range cases {
		if got := jsTrunc(value); got != want {
			t.Fatalf("jsTrunc(%v) = %v, want %v", value, got, want)
		}
	}
}

func TestJSTrimUsesJavaScriptWhitespaceSet(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"ascii spaces", "  USS Test  ", "USS Test"},
		{"tab and newline", "\t\nname\r\n", "name"},
		{"no-break space", "\u00a0name\u00a0", "name"},
		{"ideographic space", "\u3000name\u3000", "name"},
		{"byte order mark", "\ufeffname\ufeff", "name"},
		{"line separator", "\u2028name\u2029", "name"},
		// U+0085 NEL is Unicode whitespace but NOT ECMAScript whitespace, so JS trim
		// leaves it in place (and so must the Go port).
		{"next line is not js whitespace", "\u0085name", "\u0085name"},
		{"whitespace only", "   ", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := jsTrim(testCase.input); got != testCase.want {
				t.Fatalf("jsTrim(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestParseJSNumberMatchesNumberCoercion(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  float64
		ok    bool
	}{
		{"decimal", "42", 42, true},
		{"surrounding whitespace", " 42 ", 42, true},
		{"fraction", "12.5", 12.5, true},
		{"leading dot", ".5", 0.5, true},
		{"trailing dot", "5.", 5, true},
		{"exponent", "1e3", 1000, true},
		{"explicit plus", "+5", 5, true},
		{"hexadecimal", "0x10", 16, true},
		{"binary", "0b101", 5, true},
		{"octal", "0o17", 15, true},
		// Number("") is 0 and Number("   ") is 0; callers that treat a blank value as
		// absent check it first, exactly like the Node getNumber.
		{"empty string", "", 0, true},
		{"blank string", "   ", 0, true},
		// Non-finite results are rejected, matching Number.isFinite usage.
		{"infinity", "Infinity", 0, false},
		{"signed infinity", "-Infinity", 0, false},
		{"nan literal", "NaN", 0, false},
		{"garbage", "abc", 0, false},
		{"trailing garbage", "3004abc", 0, false},
		// Go's strconv accepts digit separators as literal syntax; JS number literals have
		// none, so Number("1_000") is NaN.
		{"separator", "1_000", 0, false},
		{"hex separator", "0x1_0", 0, false},
		{"exponent separator", "1e1_0", 0, false},
		// Go accepts hex float literals, JavaScript does not: Number("0x1p-2") is NaN.
		{"go only hex float", "0x1p-2", 0, false},
		{"negative hex is nan in js", "-0x10", 0, false},
		// Overflowing literals are not finite in JS either (Number("1e400") is Infinity).
		{"overflow", "1e400", 0, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := parseJSNumber(testCase.input)
			if ok != testCase.ok {
				t.Fatalf("parseJSNumber(%q) ok = %v, want %v", testCase.input, ok, testCase.ok)
			}
			if ok && got != testCase.want {
				t.Fatalf("parseJSNumber(%q) = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestJSToUpperExpandsLigaturesLikeJavaScript(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"ascii name", "Cargo One", "CARGO ONE"},
		// JS full uppercase mapping expands these; strings.ToUpper would leave the source
		// rune alone and the ASCII naval patterns would stop matching.
		{"sharp s expands to SS", "\u00df", "SS"},
		{"sharp s inside a name", "stra\u00dfe", "STRASSE"},
		{"fi ligature", "\ufb01nance", "FINANCE"},
		{"ff ligature", "o\ufb00shore", "OFFSHORE"},
		{"st ligature", "\ufb06arboard", "STARBOARD"},
		// Single-rune mappings are unchanged.
		{"ascii lowercase", "uss", "USS"},
		{"greek", "\u03b1\u03b2", "\u0391\u0392"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := jsToUpper(testCase.input); got != testCase.want {
				t.Fatalf("jsToUpper(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestISOMillisMatchesToISOString(t *testing.T) {
	cases := []struct {
		millis int64
		want   string
	}{
		{0, "1970-01-01T00:00:00.000Z"},
		{1700000000000, "2023-11-14T22:13:20.000Z"},
		{1700000000123, "2023-11-14T22:13:20.123Z"},
		{1, "1970-01-01T00:00:00.001Z"},
	}
	for _, testCase := range cases {
		if got := isoMillis(testCase.millis); got != testCase.want {
			t.Fatalf("isoMillis(%d) = %q, want %q", testCase.millis, got, testCase.want)
		}
	}
}

func TestEncodeJSJSONSkipsHTMLEscapingAndLineSeparatorEscapes(t *testing.T) {
	// encoding/json escapes <, >, & and always escapes U+2028/U+2029; JSON.stringify does
	// neither, so the relay's vessel names must survive unescaped.
	payload := struct {
		Name string `json:"name"`
	}{Name: "A&B <c> \u2028 \u2029"}

	encoded, err := encodeJSJSON(payload)
	if err != nil {
		t.Fatalf("encodeJSJSON() error = %v", err)
	}
	const want = "{\"name\":\"A&B <c> \u2028 \u2029\"}"
	if string(encoded) != want {
		t.Fatalf("encoded = %q, want %q", encoded, want)
	}
	if decoded := string(mustUnmarshalString(t, encoded)); decoded != payload.Name {
		t.Fatalf("round trip = %q, want %q", decoded, payload.Name)
	}
}

func TestEncodeJSJSONKeepsEscapedBackslashSequences(t *testing.T) {
	// A payload that literally contains the text \u2028 is still valid JSON text after the
	// unescaping pass: the backslash itself is escaped, so it must not be rewritten.
	payload := struct {
		Name string `json:"name"`
	}{Name: `literal \u2028 text`}

	encoded, err := encodeJSJSON(payload)
	if err != nil {
		t.Fatalf("encodeJSJSON() error = %v", err)
	}
	var decoded struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("encoded payload is not valid JSON: %v (%s)", err, encoded)
	}
	if decoded.Name != payload.Name {
		t.Fatalf("round trip = %q, want %q", decoded.Name, payload.Name)
	}
}

func mustUnmarshalString(t *testing.T, encoded []byte) string {
	t.Helper()

	var decoded struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	return decoded.Name
}

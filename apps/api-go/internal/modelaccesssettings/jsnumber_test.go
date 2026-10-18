package modelaccesssettings

import (
	"encoding/json"
	"math"
	"testing"
)

// TestJSStringToNumber pins JavaScript's Number(string) for the stored-value
// coercions the read paths perform.
func TestJSStringToNumber(t *testing.T) {
	cases := []struct {
		input string
		want  float64
		nan   bool
	}{
		{input: "15000", want: 15000},
		{input: " 15000 ", want: 15000},
		{input: "", want: 0},
		{input: "   ", want: 0},
		{input: "0x10", want: 16},
		{input: "0X10", want: 16},
		{input: "0b11", want: 3},
		{input: "0o17", want: 15},
		{input: "-0x10", nan: true},
		{input: "+0x10", nan: true},
		{input: "1_000", nan: true},
		{input: "1,2", nan: true},
		{input: "Infinity", want: math.Inf(1)},
		{input: "+Infinity", want: math.Inf(1)},
		{input: "-Infinity", want: math.Inf(-1)},
		{input: "infinity", nan: true},
		{input: "INFINITY", nan: true},
		{input: "inf", nan: true},
		{input: "Inf", nan: true},
		{input: "nan", nan: true},
		{input: "NaN", nan: true},
		{input: "1e999", want: math.Inf(1)},
		{input: "1e-999", want: 0},
		{input: ".5", want: 0.5},
		{input: "5.", want: 5},
		{input: "+5", want: 5},
		{input: "abc", nan: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.input, func(t *testing.T) {
			got := jsStringToNumber(testCase.input)
			if testCase.nan {
				if !math.IsNaN(got) {
					t.Fatalf("jsStringToNumber(%q) = %v, want NaN", testCase.input, got)
				}
				return
			}
			if got != testCase.want && !(math.IsInf(testCase.want, 0) && math.IsInf(got, 0) && math.Signbit(got) == math.Signbit(testCase.want)) {
				t.Fatalf("jsStringToNumber(%q) = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestJSNumberFromJSON pins Number(value) for decoded JSON values.
func TestJSNumberFromJSON(t *testing.T) {
	cases := []struct {
		raw  string
		want float64
		nan  bool
	}{
		{raw: `5`, want: 5},
		{raw: `"5"`, want: 5},
		{raw: `" 0x10 "`, want: 16},
		{raw: `true`, want: 1},
		{raw: `false`, want: 0},
		{raw: `null`, want: 0},
		{raw: `[]`, want: 0},
		{raw: `[5]`, want: 5},
		{raw: `[[5]]`, want: 5},
		{raw: `[1,2]`, nan: true},
		{raw: `{}`, nan: true},
		{raw: `""`, want: 0},
		{raw: `"abc"`, nan: true},
		{raw: `1e999`, want: math.Inf(1)},
	}
	for _, testCase := range cases {
		t.Run(testCase.raw, func(t *testing.T) {
			got, present := jsNumberFromJSON(json.RawMessage(testCase.raw))
			if !present {
				t.Fatalf("present = false for %s", testCase.raw)
			}
			if testCase.nan {
				if !math.IsNaN(got) {
					t.Fatalf("jsNumberFromJSON(%s) = %v, want NaN", testCase.raw, got)
				}
				return
			}
			if got != testCase.want && !(math.IsInf(testCase.want, 0) && math.IsInf(got, 0)) {
				t.Fatalf("jsNumberFromJSON(%s) = %v, want %v", testCase.raw, got, testCase.want)
			}
		})
	}
	if _, present := jsNumberFromJSON(nil); present {
		t.Fatalf("an absent field must report present=false")
	}
}

// TestStoredIntegerRules pins asPositiveInt/asNonNegativeInt including Math.floor.
func TestStoredIntegerRules(t *testing.T) {
	if got, ok := asPositiveInt(json.RawMessage(`10.9`)); !ok || got != 10 {
		t.Fatalf("asPositiveInt(10.9) = %d, %v", got, ok)
	}
	if _, ok := asPositiveInt(json.RawMessage(`0`)); ok {
		t.Fatalf("0 is not positive")
	}
	if _, ok := asPositiveInt(json.RawMessage(`-1`)); ok {
		t.Fatalf("-1 is not positive")
	}
	if got, ok := asNonNegativeInt(json.RawMessage(`0`)); !ok || got != 0 {
		t.Fatalf("asNonNegativeInt(0) = %d, %v", got, ok)
	}
	if _, ok := asNonNegativeInt(json.RawMessage(`-0.5`)); ok {
		t.Fatalf("-0.5 is negative")
	}
	if got, ok := asPositiveInt(json.RawMessage(`" 42 "`)); !ok || got != 42 {
		t.Fatalf("asPositiveInt(\" 42 \") = %d, %v", got, ok)
	}
}

// TestEnvBooleanVocabulary pins the envBoolean preprocessor.
func TestEnvBooleanVocabulary(t *testing.T) {
	truthy := []string{"true", "TRUE", " 1 ", "yes", "Y", "on"}
	for _, value := range truthy {
		parsed, set, invalid := jsEnvBoolean(value)
		if invalid || !set || !parsed {
			t.Fatalf("jsEnvBoolean(%q) = %v, %v, %v", value, parsed, set, invalid)
		}
	}
	falsy := []string{"false", "0", "no", "n", "OFF", " off "}
	for _, value := range falsy {
		parsed, set, invalid := jsEnvBoolean(value)
		if invalid || !set || parsed {
			t.Fatalf("jsEnvBoolean(%q) = %v, %v, %v", value, parsed, set, invalid)
		}
	}
	if _, set, invalid := jsEnvBoolean(""); set || invalid {
		t.Fatalf("an empty value must be treated as unset")
	}
	for _, value := range []string{"2", "maybe", "truthy"} {
		if _, _, invalid := jsEnvBoolean(value); !invalid {
			t.Fatalf("jsEnvBoolean(%q) must report a configuration error", value)
		}
	}
}

// TestJSWhitespaceSet pins the JavaScript whitespace vocabulary.
func TestJSWhitespaceSet(t *testing.T) {
	whitespace := []rune{'\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2000', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'}
	for _, r := range whitespace {
		if !isJSWhitespace(r) {
			t.Fatalf("%U must be JavaScript whitespace", r)
		}
	}
	for _, r := range []rune{'\u0085', '\u200b', '\u180e', 'a'} {
		if isJSWhitespace(r) {
			t.Fatalf("%U must not be JavaScript whitespace", r)
		}
	}
	if got := jsTrimSpace("\u00a0x\u2028"); got != "x" {
		t.Fatalf("jsTrimSpace = %q", got)
	}
	if !containsJSLineTerminator("a\u2028b") || containsJSLineTerminator("a b") {
		t.Fatalf("containsJSLineTerminator is wrong")
	}
}

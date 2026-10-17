package situationsignals

import (
	"encoding/json"
	"testing"
)

func TestParseJSNumberString(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  float64
		valid bool
	}{
		{"empty is zero", "", 0, true},
		{"whitespace is zero", "   ", 0, true},
		{"integer", "42", 42, true},
		{"padded integer", " \t 42 \n ", 42, true},
		{"negative", "-7", -7, true},
		{"explicit plus", "+7", 7, true},
		{"decimal", "3.5", 3.5, true},
		{"leading dot", ".5", 0.5, true},
		{"trailing dot", "5.", 5, true},
		{"exponent", "1e3", 1000, true},
		{"exponent with plus", "1e+3", 1000, true},
		{"exponent with minus", "15e-1", 1.5, true},
		{"hex", "0x1f", 31, true},
		{"hex upper", "0X1F", 31, true},
		{"binary", "0b101", 5, true},
		{"octal", "0o17", 15, true},
		{"signed hex is NaN", "-0x10", 0, false},
		{"empty hex is NaN", "0x", 0, false},
		{"bad hex digit", "0x1g", 0, false},
		{"underscore separator is NaN", "1_000", 0, false},
		{"trailing garbage", "12abc", 0, false},
		{"leading garbage", "abc12", 0, false},
		{"lone sign", "+", 0, false},
		{"lone dot", ".", 0, false},
		{"double dot", "1.2.3", 0, false},
		{"nan literal", "NaN", 0, false},
		{"infinity literal", "Infinity", 0, false},
		{"negative infinity literal", "-Infinity", 0, false},
		{"vertical tab padding", "\v8\f", 8, true},
		{"non-breaking space padding", "\u00a08\u00a0", 8, true},
		{"infinity overflow", "1e999", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseJSNumberString(tc.input)
			if ok != tc.valid {
				t.Fatalf("valid = %v, want %v (value %v)", ok, tc.valid, got)
			}
			if ok && got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestJSNumberValue(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		present bool
		want    float64
		valid   bool
	}{
		{"absent is NaN", "", false, 0, false},
		{"null is zero", "null", true, 0, true},
		{"true is one", "true", true, 1, true},
		{"false is zero", "false", true, 0, true},
		{"number", "12.5", true, 12.5, true},
		{"numeric string", `"12.5"`, true, 12.5, true},
		{"empty string is zero", `""`, true, 0, true},
		{"non numeric string", `"abc"`, true, 0, false},
		{"empty array is zero", "[]", true, 0, true},
		{"single element array", "[7]", true, 7, true},
		{"single string array", `["7"]`, true, 7, true},
		{"multi element array is NaN", "[1,2]", true, 0, false},
		{"object is NaN", `{"a":1}`, true, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := json.RawMessage(tc.raw)
			got, ok := jsNumber(raw, tc.present)
			if ok != tc.valid {
				t.Fatalf("valid = %v, want %v (value %v)", ok, tc.valid, got)
			}
			if ok && got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestJSNumberishDecoding(t *testing.T) {
	type sample struct {
		Value jsNumberish `json:"value"`
	}
	var absent sample
	if err := json.Unmarshal([]byte(`{}`), &absent); err != nil {
		t.Fatal(err)
	}
	if _, ok := absent.Value.Number(); ok {
		t.Fatal("an absent key must resolve to NaN")
	}
	if absent.Value.IsSet() {
		t.Fatal("an absent key must not be marked set")
	}

	var nullValue sample
	if err := json.Unmarshal([]byte(`{"value":null}`), &nullValue); err != nil {
		t.Fatal(err)
	}
	if number, ok := nullValue.Value.Number(); !ok || number != 0 {
		t.Fatalf("null must resolve to 0, got %v/%v", number, ok)
	}
	if !nullValue.Value.IsSet() {
		t.Fatal("null must be marked set")
	}

	var stringValue sample
	if err := json.Unmarshal([]byte(`{"value":"200"}`), &stringValue); err != nil {
		t.Fatal(err)
	}
	if number, ok := stringValue.Value.Number(); !ok || number != 200 {
		t.Fatalf("string must resolve to 200, got %v/%v", number, ok)
	}
}

func TestTrimmedStringDecoding(t *testing.T) {
	type sample struct {
		Value trimmedString `json:"value"`
	}
	var doc sample
	if err := json.Unmarshal([]byte(`{"value":"  hello  "}`), &doc); err != nil {
		t.Fatal(err)
	}
	if value, ok := doc.Value.Value(); !ok || value != "hello" {
		t.Fatalf("value = %q/%v", value, ok)
	}
	if err := json.Unmarshal([]byte(`{"value":"   "}`), &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc.Value.Value(); ok {
		t.Fatal("a blank string must not resolve")
	}
	if err := json.Unmarshal([]byte(`{"value":5}`), &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc.Value.Value(); ok {
		t.Fatal("a number must not resolve as a trimmed string")
	}
}

func TestJsFloorAndClampInt(t *testing.T) {
	if jsFloor(2.9) != 2 || jsFloor(-0.5) != -1 {
		t.Fatalf("jsFloor = %v %v", jsFloor(2.9), jsFloor(-0.5))
	}
	if clampInt(5, 1, 10) != 5 || clampInt(0, 1, 10) != 1 || clampInt(11, 1, 10) != 10 {
		t.Fatal("clampInt bounds")
	}
}

package crawlfrontierruns

import (
	"encoding/json"
	"math"
	"testing"
)

// decodeNumber unmarshals one raw JSON value into jsNumberish.
func decodeNumber(t *testing.T, raw string) jsNumberish {
	t.Helper()
	var value jsNumberish
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return value
}

func TestJSNumberishCoercion(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want float64
		ok   bool
	}{
		{name: "number", raw: "3.5", want: 3.5, ok: true},
		{name: "integer string", raw: `"12"`, want: 12, ok: true},
		{name: "padded string", raw: `" 7 "`, want: 7, ok: true},
		{name: "empty string", raw: `""`, want: 0, ok: true},
		{name: "whitespace string", raw: `"   "`, want: 0, ok: true},
		{name: "infinity string", raw: `"Infinity"`, ok: false},
		{name: "negative infinity string", raw: `"-Infinity"`, ok: false},
		{name: "plus infinity string", raw: `"+Infinity"`, ok: false},
		{name: "hex string", raw: `"0x10"`, want: 16, ok: true},
		{name: "octal string", raw: `"0o7"`, want: 7, ok: true},
		{name: "binary string", raw: `"0b11"`, want: 3, ok: true},
		{name: "signed hex string", raw: `"-0x10"`, ok: false},
		{name: "underscore string", raw: `"1_0"`, ok: false},
		{name: "hex float string", raw: `"0x1p3"`, ok: false},
		{name: "lowercase infinity word", raw: `"inf"`, ok: false},
		{name: "nan word", raw: `"nan"`, ok: false},
		{name: "plain word", raw: `"abc"`, ok: false},
		{name: "exponent string", raw: `"1e3"`, want: 1000, ok: true},
		{name: "leading dot", raw: `".5"`, want: 0.5, ok: true},
		{name: "trailing dot", raw: `"5."`, want: 5, ok: true},
		{name: "lone sign", raw: `"+"`, ok: false},
		{name: "empty exponent", raw: `"1e"`, ok: false},
		{name: "overflowing exponent", raw: `"1e999"`, ok: false},
		{name: "true", raw: "true", want: 1, ok: true},
		{name: "false", raw: "false", want: 0, ok: true},
		{name: "null", raw: "null", want: 0, ok: true},
		{name: "empty array", raw: "[]", want: 0, ok: true},
		{name: "single number array", raw: "[5]", want: 5, ok: true},
		{name: "single string array", raw: `["5"]`, want: 5, ok: true},
		{name: "single nested array", raw: "[[5]]", want: 5, ok: true},
		{name: "single null array", raw: "[null]", want: 0, ok: true},
		{name: "single word array", raw: `["abc"]`, ok: false},
		{name: "multi element array", raw: "[1,2]", ok: false},
		{name: "object", raw: `{"a":1}`, ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeNumber(t, tc.raw)
			if got.OK != tc.ok {
				t.Fatalf("OK = %v, want %v (value %v)", got.OK, tc.ok, got.Value)
			}
			if tc.ok && got.Value != tc.want {
				t.Fatalf("Value = %v, want %v", got.Value, tc.want)
			}
		})
	}
}

func TestJSNumberToString(t *testing.T) {
	cases := []struct {
		value float64
		want  string
	}{
		{value: 0, want: "0"},
		{value: 2, want: "2"},
		{value: 2.5, want: "2.5"},
		{value: 1000000, want: "1000000"},
		{value: 1e21, want: "1e+21"},
		{value: 1e-7, want: "1e-7"},
		{value: math.Inf(1), want: "Infinity"},
		{value: math.Inf(-1), want: "-Infinity"},
		{value: math.NaN(), want: "NaN"},
	}
	for _, tc := range cases {
		if got := jsNumberToString(tc.value); got != tc.want {
			t.Fatalf("jsNumberToString(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestFiniteNumber(t *testing.T) {
	if got := finiteNumber(decodeNumber(t, `"abc"`)); got != nil {
		t.Fatalf("non-numeric value must map to nil, got %v", *got)
	}
	got := finiteNumber(decodeNumber(t, `"12"`))
	if got == nil || *got != 12 {
		t.Fatalf("numeric string must map to 12, got %v", got)
	}
}

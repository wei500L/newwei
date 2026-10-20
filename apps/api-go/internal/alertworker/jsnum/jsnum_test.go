package jsnum

import (
	"math"
	"testing"
)

// TestFormat pins the ECMAScript Number::toString(10) spelling, including the
// fixed/exponential thresholds and the negative-zero rule.
func TestFormat(t *testing.T) {
	cases := []struct {
		name  string
		value float64
		want  string
	}{
		{name: "positive zero", value: 0, want: "0"},
		{name: "negative zero", value: math.Copysign(0, -1), want: "0"},
		{name: "one", value: 1, want: "1"},
		{name: "minus one", value: -1, want: "-1"},
		{name: "one and a half", value: 1.5, want: "1.5"},
		{name: "one tenth", value: 0.1, want: "0.1"},
		{name: "hundred", value: 100, want: "100"},
		{name: "largest fixed power of ten", value: 1e20, want: "100000000000000000000"},
		{name: "first exponential power of ten", value: 1e21, want: "1e+21"},
		{name: "exponential with mantissa", value: 1.5e21, want: "1.5e+21"},
		{name: "last fixed negative power", value: 1e-6, want: "0.000001"},
		{name: "first exponential negative power", value: 1e-7, want: "1e-7"},
		{name: "exponential negative mantissa", value: 1.23e-7, want: "1.23e-7"},
		{name: "integer beyond 2^53", value: 123456789012345678901, want: "123456789012345680000"},
		{name: "float addition artifact", value: 0.30000000000000004, want: "0.30000000000000004"},
		{name: "alert message value", value: 1234.5678, want: "1234.5678"},
		{name: "negative exponential", value: -1.5e-7, want: "-1.5e-7"},
		{name: "nullary not a number", value: math.NaN(), want: "NaN"},
		{name: "positive infinity", value: math.Inf(1), want: "Infinity"},
		{name: "negative infinity", value: math.Inf(-1), want: "-Infinity"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := Format(testCase.value); got != testCase.want {
				t.Fatalf("Format(%v) = %q, want %q", testCase.value, got, testCase.want)
			}
		})
	}
}

// TestToFixedHalfway pins the exactly-representable halfway cases from the
// owner's report: 0.125 and -0.125 are exact doubles, so they round away from
// zero, while 1.005 and 2.55 are just below the halfway point.
func TestToFixedHalfway(t *testing.T) {
	cases := []struct {
		name   string
		value  float64
		digits int
		want   string
	}{
		{name: "1.005 is below the half", value: 1.005, digits: 2, want: "1.00"},
		{name: "2.55 is below the half", value: 2.55, digits: 1, want: "2.5"},
		{name: "1.45 is below the half", value: 1.45, digits: 1, want: "1.4"},
		{name: "positive exact half rounds away", value: 0.125, digits: 2, want: "0.13"},
		{name: "negative exact half rounds away", value: -0.125, digits: 2, want: "-0.13"},
		{name: "positive integer half", value: 0.5, digits: 0, want: "1"},
		{name: "negative integer half", value: -0.5, digits: 0, want: "-1"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := ToFixed(testCase.value, testCase.digits); got != testCase.want {
				t.Fatalf("ToFixed(%v, %d) = %q, want %q", testCase.value, testCase.digits, got, testCase.want)
			}
		})
	}
}

// TestToFixedGeneral covers zero padding, the 1e21 escape hatch, the
// documented out-of-range fallback, and sign handling around zero.
func TestToFixedGeneral(t *testing.T) {
	cases := []struct {
		name   string
		value  float64
		digits int
		want   string
	}{
		{name: "zero", value: 0, digits: 2, want: "0.00"},
		{name: "negative zero", value: math.Copysign(0, -1), digits: 2, want: "0.00"},
		{name: "integral value", value: 1, digits: 2, want: "1.00"},
		{name: "three decimals", value: 1.005, digits: 3, want: "1.005"},
		{name: "thousands", value: 1234.5678, digits: 3, want: "1234.568"},
		{name: "zero digits", value: 42.9, digits: 0, want: "43"},
		{name: "magnitude at the toString boundary", value: 1e21, digits: 2, want: "1e+21"},
		{name: "tiny negative keeps the sign", value: -0.001, digits: 2, want: "-0.00"},
		{name: "negative value", value: -12.345, digits: 2, want: "-12.35"},
		{name: "digits below range fall back", value: 1.5, digits: -1, want: "1.5"},
		{name: "digits above range fall back", value: 1.5, digits: 101, want: "1.5"},
		{name: "not a number", value: math.NaN(), digits: 2, want: "NaN"},
		{name: "infinity", value: math.Inf(1), digits: 2, want: "Infinity"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := ToFixed(testCase.value, testCase.digits); got != testCase.want {
				t.Fatalf("ToFixed(%v, %d) = %q, want %q", testCase.value, testCase.digits, got, testCase.want)
			}
		})
	}
}

// TestToFixedHundredDigits checks the upper digits bound does not lose the
// integer part or produce an exponent.
func TestToFixedHundredDigits(t *testing.T) {
	got := ToFixed(1, 100)
	want := "1." + stringsOfZeros(100)
	if got != want {
		t.Fatalf("ToFixed(1, 100) = %q, want %q", got, want)
	}
}

// stringsOfZeros is a tiny helper that keeps the long literal readable.
func stringsOfZeros(count int) string {
	buffer := make([]byte, count)
	for index := range buffer {
		buffer[index] = '0'
	}
	return string(buffer)
}

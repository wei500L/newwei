package realtimesignals

import (
	"encoding/json"
	"math"
	"testing"
)

func TestJSToFixedMatchesNumberPrototype(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   string
	}{
		{1.005, 2, "1.00"}, // the binary value is below 1.005
		{1.5, 0, "2"},
		{2.5, 0, "3"},
		{-1.5, 0, "-2"},
		{-0.0001, 2, "-0.00"},
		{0, 2, "0.00"},
		{123.456, 2, "123.46"},
		{1e-7, 3, "0.000"},
		{12.345, 3, "12.345"},
	}
	for _, testCase := range cases {
		if got := jsToFixed(testCase.value, testCase.digits); got != testCase.want {
			t.Fatalf("jsToFixed(%v, %d) = %q, want %q", testCase.value, testCase.digits, got, testCase.want)
		}
	}
}

func TestJSRoundMatchesMathRound(t *testing.T) {
	cases := []struct {
		value float64
		want  float64
	}{
		{0.5, 1},
		{-0.5, 0},
		{-1.5, -1},
		{2.5, 3},
		{0.49999999999999994, 0}, // Math.round does not use floor(x+0.5)
		{-2.6, -3},
		{3.4, 3},
	}
	for _, testCase := range cases {
		if got := jsRound(testCase.value); got != testCase.want {
			t.Fatalf("jsRound(%v) = %v, want %v", testCase.value, got, testCase.want)
		}
	}
}

func TestToFiniteNumberAppliesJSNumberCoercion(t *testing.T) {
	cases := []struct {
		raw   string
		want  float64
		valid bool
	}{
		{`12`, 12, true},
		{`"12"`, 12, true},
		{`" 12 "`, 12, true},
		{`""`, 0, true},
		{`"0x10"`, 16, true},
		{`"1e3"`, 1000, true},
		{`"abc"`, 0, false},
		{`true`, 0, false},
		{`null`, 0, false},
		{`{}`, 0, false},
	}
	for _, testCase := range cases {
		got, ok := toFiniteNumber(json.RawMessage(testCase.raw))
		if ok != testCase.valid || (testCase.valid && math.Abs(got-testCase.want) > 1e-9) {
			t.Fatalf("toFiniteNumber(%s) = %v/%t, want %v/%t", testCase.raw, got, ok, testCase.want, testCase.valid)
		}
	}
}

func TestJSNumberStringMatchesStringNumber(t *testing.T) {
	cases := map[float64]string{
		5:    "5",
		0.1:  "0.1",
		-2.5: "-2.5",
		1e21: "1e+21",
		1e-7: "1e-7",
	}
	for value, want := range cases {
		if got := jsNumberString(value); got != want {
			t.Fatalf("jsNumberString(%v) = %q, want %q", value, got, want)
		}
	}
	if got := jsNumberString(math.Copysign(0, -1)); got != "0" {
		t.Fatalf("jsNumberString(-0) = %q, want \"0\"", got)
	}
}

func TestJSTrimRemovesByteOrderMark(t *testing.T) {
	if got := jsTrim("\uFEFF hello \u00A0"); got != "hello" {
		t.Fatalf("jsTrim = %q, want hello", got)
	}
}

func TestParseJSTimeMillisAcceptsCollectorShapes(t *testing.T) {
	iso := int64(1723473000000) // 2024-08-12T14:30:00.000Z
	for _, value := range []string{
		"2024-08-12T14:30:00.000Z",
		"2024-08-12T14:30:00Z",
		"20240812143000",
		"20240812T143000Z",
	} {
		got, ok := parseJSTimeMillis(value)
		if !ok || got != iso {
			t.Fatalf("parseJSTimeMillis(%q) = %d/%t, want %d", value, got, ok, iso)
		}
	}
	day, ok := parseJSTimeMillis("20240812")
	if !ok || formatISO(day) != "2024-08-12T00:00:00.000Z" {
		t.Fatalf("parseJSTimeMillis(20240812) = %d/%t", day, ok)
	}
	if _, ok := parseJSTimeMillis("not-a-date"); ok {
		t.Fatal("parseJSTimeMillis accepted an invalid value")
	}
}

func TestToIsoTimestampNormalizesNumerics(t *testing.T) {
	if got := toIsoTimestamp(json.RawMessage(`1723473000000`)); got != "2024-08-12T14:30:00.000Z" {
		t.Fatalf("epoch millis = %s", got)
	}
	if got := toIsoTimestamp(json.RawMessage(`"2024-08-12T14:30:00.000Z"`)); got != "2024-08-12T14:30:00.000Z" {
		t.Fatalf("iso string = %s", got)
	}
}

func TestEncodeFormPairsPreservesURLSearchParamsOrder(t *testing.T) {
	got := encodeFormPairs(
		[2]string{"event_type", "Protests"},
		[2]string{"event_date", "2024-08-12|2024-09-11"},
	)
	want := "event_type=Protests&event_date=2024-08-12%7C2024-09-11"
	if got != want {
		t.Fatalf("encodeFormPairs = %q, want %q", got, want)
	}
}

func TestSortStringsJSUsesUTF16Order(t *testing.T) {
	values := []string{"b", "A", "a"}
	sortStringsJS(values)
	want := []string{"A", "a", "b"}
	for index := range want {
		if values[index] != want[index] {
			t.Fatalf("sortStringsJS = %v, want %v", values, want)
		}
	}
}

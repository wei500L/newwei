package analysisruns

import (
	"strings"
	"testing"
)

func TestJSValueFormatting(t *testing.T) {
	cases := map[float64]string{
		0:                  "0",
		1.5:                "1.5",
		100:                "100",
		0.000001:           "0.000001",
		0.0000001:          "1e-7",
		1e20:               "100000000000000000000",
		1e21:               "1e+21",
		-2.25:              "-2.25",
		123.40000000000001: "123.40000000000001",
	}
	for value, want := range cases {
		if got := jsNumberString(value); got != want {
			t.Fatalf("jsNumberString(%v) = %q, want %q", value, got, want)
		}
	}
}

func TestJSToFixedRounding(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   string
	}{
		{2.5, 0, "3"},
		{1.5, 0, "2"},
		{-2.5, 0, "-3"},
		{-1.5, 0, "-2"},
		{0.125, 2, "0.13"},
		{1.005, 2, "1.00"},
		{-0.0, 2, "0.00"},
		{12.345, 2, "12.35"},
	}
	for _, test := range cases {
		if got := jsToFixed(test.value, test.digits); got != test.want {
			t.Fatalf("jsToFixed(%v,%d) = %q, want %q", test.value, test.digits, got, test.want)
		}
	}
}

func TestUTF16LengthUsesCodeUnits(t *testing.T) {
	if got := utf16Len("abc"); got != 3 {
		t.Fatalf("ascii length = %d", got)
	}
	if got := utf16Len("你好"); got != 2 {
		t.Fatalf("bmp length = %d", got)
	}
	if got := utf16Len("😀"); got != 2 {
		t.Fatalf("astral length = %d, want 2 UTF-16 units", got)
	}
	if got := utf16Len("a😀b"); got != 4 {
		t.Fatalf("mixed length = %d", got)
	}
}

func TestAnomalyFindingsOrderAndReasons(t *testing.T) {
	series := make([]SeriesPoint, 0, 21)
	for index := 0; index < 20; index++ {
		value := 5.0
		if index%2 == 1 {
			value = 15
		}
		series = append(series, SeriesPoint{Timestamp: "t" + integerString(index), Value: value})
	}
	series = append(series, SeriesPoint{Timestamp: "t20", Value: 1000})
	findings := EvaluateSeries(series)
	if len(findings) != 4 {
		t.Fatalf("findings = %d, want 4 (%+v)", len(findings), findings)
	}
	wantPrefixes := []string{"Z-Score ", "Rolling spike ", "Trend 3d change ", "Volume "}
	for index, want := range wantPrefixes {
		if !strings.HasPrefix(findings[index].Reason, want) {
			t.Fatalf("finding %d reason = %q, want prefix %q", index, findings[index].Reason, want)
		}
	}
	if findings[0].Point.Value != 1000 || findings[1].Point.Value != 1000 ||
		findings[2].Point.Value != 1000 || findings[3].Point.Value != 1000 {
		t.Fatalf("all detectors should hit the final point: %+v", findings)
	}
	if !strings.Contains(findings[0].Reason, ">= 3") {
		t.Fatalf("z-score reason = %q", findings[0].Reason)
	}
	if !strings.Contains(findings[3].Reason, ">= 3x 10.00") {
		t.Fatalf("volume reason = %q", findings[3].Reason)
	}
}

func TestAnomalyZeroStandardDeviationHasNoFindings(t *testing.T) {
	series := make([]SeriesPoint, 0, 30)
	for index := 0; index < 30; index++ {
		series = append(series, SeriesPoint{Timestamp: "t", Value: 5})
	}
	if findings := EvaluateSeries(series); len(findings) != 0 {
		t.Fatalf("constant series findings = %+v, want none", findings)
	}
}

func TestTrendThresholdIncludesBoundary(t *testing.T) {
	// start=100, end=110 is exactly 10% and must be included.
	findings := detectTrend([]SeriesPoint{
		{Timestamp: "a", Value: 100},
		{Timestamp: "b", Value: 105},
		{Timestamp: "c", Value: 110},
	})
	if len(findings) != 1 {
		t.Fatalf("findings = %+v, want one boundary trend", findings)
	}
	if findings[0].Reason != "Trend 3d change 10.00%" {
		t.Fatalf("reason = %q", findings[0].Reason)
	}
}

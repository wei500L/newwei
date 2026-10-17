package kgimpact

import (
	"math"
	"testing"
)

func TestPearsonPerfectPositive(t *testing.T) {
	x := []float64{1, 2, 3, 4, 5}
	y := []float64{1, 2, 3, 4, 5}
	correlation, pValue := pearsonCorrelation(x, y)
	if math.Abs(correlation-1) > 1e-9 {
		t.Fatalf("correlation = %v, want 1", correlation)
	}
	if pValue != 0 {
		t.Fatalf("pValue = %v, want 0 for df=3 with t=Inf", pValue)
	}
}

func TestPearsonPerfectNegative(t *testing.T) {
	x := []float64{1, 2, 3, 4, 5}
	y := []float64{5, 4, 3, 2, 1}
	correlation, pValue := pearsonCorrelation(x, y)
	if math.Abs(correlation+1) > 1e-9 {
		t.Fatalf("correlation = %v, want -1", correlation)
	}
	if pValue != 0 {
		t.Fatalf("pValue = %v, want 0", pValue)
	}
}

func TestPearsonModeratePositive(t *testing.T) {
	x := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	y := []float64{2, 1, 4, 3, 6, 5, 8, 7, 10, 9}
	correlation, pValue := pearsonCorrelation(x, y)
	if correlation <= 0.9 || correlation >= 1 {
		t.Fatalf("correlation = %v, want (0.9,1)", correlation)
	}
	if pValue <= 0 || pValue >= 0.05 {
		t.Fatalf("pValue = %v, want (0,0.05)", pValue)
	}
}

func TestPearsonZeroVariance(t *testing.T) {
	correlation, pValue := pearsonCorrelation([]float64{1, 1, 1}, []float64{1, 2, 3})
	if correlation != 0 || pValue != 1 {
		t.Fatalf("zero variance = (%v,%v), want (0,1)", correlation, pValue)
	}
	correlation, pValue = pearsonCorrelation([]float64{1}, []float64{2})
	if correlation != 0 || pValue != 1 {
		t.Fatalf("single point = (%v,%v), want (0,1)", correlation, pValue)
	}
}

func TestNormalCDFMatchesStandardNormal(t *testing.T) {
	cases := []struct {
		x    float64
		want float64
	}{
		{0, 0.5},
		{1.96, 0.975},
		{-1.96, 0.025},
	}
	for _, testCase := range cases {
		if got := normalCDF(testCase.x); math.Abs(got-testCase.want) > 0.001 {
			t.Fatalf("normalCDF(%v) = %v, want ~%v", testCase.x, got, testCase.want)
		}
	}
}

func TestApproximatePValueBranches(t *testing.T) {
	if got := approximatePValue(2, 10); math.Abs(got-10.0/14.0) > 1e-12 {
		t.Fatalf("small df pValue = %v, want %v", got, 10.0/14.0)
	}
	if got := approximatePValue(1.96, 40); got <= 0 || got >= 0.06 {
		t.Fatalf("large df pValue = %v, want ~0.05", got)
	}
}

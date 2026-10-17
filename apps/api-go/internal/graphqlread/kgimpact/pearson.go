package kgimpact

import "math"

// pearsonCorrelation mirrors EntityImpactGraphService.pearsonCorrelation.
func pearsonCorrelation(x, y []float64) (float64, float64) {
	n := len(x)
	if n < 2 {
		return 0, 1
	}

	meanX := 0.0
	for _, value := range x {
		meanX += value
	}
	meanX /= float64(n)
	meanY := 0.0
	for _, value := range y {
		meanY += value
	}
	meanY /= float64(n)

	var sumXY, sumX2, sumY2 float64
	for i := 0; i < n; i++ {
		dx := x[i] - meanX
		dy := y[i] - meanY
		sumXY += dx * dy
		sumX2 += dx * dx
		sumY2 += dy * dy
	}

	if sumX2 == 0 || sumY2 == 0 {
		return 0, 1
	}

	correlation := sumXY / math.Sqrt(sumX2*sumY2)
	t := correlation * math.Sqrt(float64(n-2)/(1-correlation*correlation))
	pValue := approximatePValue(math.Abs(t), n-2)
	return correlation, pValue
}

// approximatePValue mirrors EntityImpactGraphService.approximatePValue.
func approximatePValue(t float64, df int) float64 {
	if df > 30 {
		return 2 * (1 - normalCDF(t))
	}
	return float64(df) / (float64(df) + t*t)
}

// normalCDF mirrors EntityImpactGraphService.normalCDF.
func normalCDF(x float64) float64 {
	const (
		a1 = 0.254829592
		a2 = -0.284496736
		a3 = 1.421413741
		a4 = -1.453152027
		a5 = 1.061405429
		p  = 0.3275911
	)

	sign := 1.0
	if x < 0 {
		sign = -1
	}
	x = math.Abs(x) / math.Sqrt2

	t := 1.0 / (1.0 + p*x)
	y := 1.0 - ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*math.Exp(-x*x)

	return 0.5 * (1.0 + sign*y)
}

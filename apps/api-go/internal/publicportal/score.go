package publicportal

import (
	"math"
	"time"
)

func clamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// roundJS 对齐 Math.round(value * scale) / divisor。正数上与 Go math.Round 一致。
func roundJS(value, scale, divisor float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Round(value*scale) / divisor
}

type heatProfile struct {
	Breaking  bool
	HeatScore float64
}

// heatFrom 对齐 NewsEventsService.getEventHeatMap 的单事件公式。
func heatFrom(now, lastAt time.Time, itemsLast1h, itemsLast4h, uniqueSources int) heatProfile {
	if itemsLast4h <= 0 || lastAt.IsZero() {
		return heatProfile{}
	}
	recencyHours := now.Sub(lastAt).Hours()
	recency := math.Exp(-recencyHours / 6)
	heat := recency * (math.Log1p(float64(itemsLast4h)) + 1.5*math.Log1p(float64(itemsLast1h)) + 0.75*math.Log1p(float64(uniqueSources)))
	isRecent := recencyHours <= 4
	hasFastGrowth := itemsLast1h >= 2 && uniqueSources >= 2
	hasHighVolume := itemsLast4h >= 5 && uniqueSources >= 3
	hasHighHeat := heat >= 1.6
	return heatProfile{
		Breaking:  isRecent && (hasFastGrowth || hasHighVolume || hasHighHeat),
		HeatScore: roundJS(heat, 100, 100),
	}
}

type authorityProfile struct {
	SourceType               string
	CredibilityScore         float64
	UniqueSourceCount        int
	AuthoritativeSourceCount int
	BlogSourceCount          int
	Corroborated             bool
}

func emptyAuthority() authorityProfile {
	return authorityProfile{SourceType: "unknown"}
}

// authorityFromAggregates 对齐 NewsEventsService.getEventAuthorityMap 的打分。
func authorityFromAggregates(unique, authoritativeSources, blogSources, authoritativeItems, _ int, totalItems int) authorityProfile {
	sourceType := "unknown"
	switch {
	case authoritativeSources > 0 && blogSources == 0:
		sourceType = "authoritative"
	case authoritativeSources > 0 && blogSources > 0:
		sourceType = "mixed"
	case authoritativeSources == 0 && blogSources > 0:
		sourceType = "blog"
	}
	if totalItems <= 0 || unique <= 0 {
		return authorityProfile{
			SourceType:               sourceType,
			UniqueSourceCount:        unique,
			AuthoritativeSourceCount: authoritativeSources,
			BlogSourceCount:          blogSources,
		}
	}
	corroboration := clamp01(math.Log1p(float64(unique)) / math.Log1p(6))
	authoritativeCoverage := 0.0
	if unique > 0 {
		authoritativeCoverage = float64(authoritativeSources) / float64(unique)
	}
	authoritativeItemShare := 0.0
	if totalItems > 0 {
		authoritativeItemShare = float64(authoritativeItems) / float64(totalItems)
	}
	crossVerification := 0.05
	switch {
	case authoritativeSources >= 3:
		crossVerification = 1
	case authoritativeSources == 2:
		crossVerification = 0.82
	case authoritativeSources == 1:
		crossVerification = 0.46
	case unique >= 4:
		crossVerification = 0.34
	case unique >= 2:
		crossVerification = 0.2
	}
	blogPenalty := math.Min(0.38, (float64(blogSources)/math.Max(1, float64(unique)))*0.38)
	credibility := clamp01(
		0.44*authoritativeCoverage +
			0.24*corroboration +
			0.18*authoritativeItemShare +
			0.14*crossVerification -
			blogPenalty,
	)
	return authorityProfile{
		SourceType:               sourceType,
		CredibilityScore:         roundJS(credibility, 10_000, 100),
		UniqueSourceCount:        unique,
		AuthoritativeSourceCount: authoritativeSources,
		BlogSourceCount:          blogSources,
		Corroborated:             authoritativeSources >= 2,
	}
}

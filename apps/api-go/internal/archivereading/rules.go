package archivereading

import (
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
)

// Region country sets, ported from ArchiveClassifier. They are deliberately not
// derived from the vertical taxonomy: the classifier resolves region from the
// country candidate order first and only then from region keywords.
var (
	regionAPACCountries = countrySet("AUS", "BRN", "CHN", "IDN", "IND", "JPN", "KHM", "KOR", "LAO", "MMR", "MNG", "MYS", "NZL", "PAK", "PHL", "PRK", "SGP", "THA", "TWN", "VNM")
	regionMECountries   = countrySet("ARE", "BHR", "EGY", "IRN", "IRQ", "ISR", "JOR", "KWT", "LBN", "OMN", "PSE", "QAT", "SAU", "SYR", "TUR", "YEM")
	regionAMCountries   = countrySet("ARG", "BOL", "BRA", "CAN", "CHL", "COL", "CUB", "ECU", "MEX", "PER", "USA", "VEN")
	regionEUCountries   = countrySet("AUT", "BEL", "CHE", "CZE", "DEU", "DNK", "ESP", "FIN", "FRA", "GBR", "GRC", "HUN", "IRL", "ITA", "NLD", "NOR", "POL", "PRT", "ROU", "RUS", "SWE", "UKR")
	regionAFCountries   = countrySet("AGO", "BWA", "CMR", "COD", "DZA", "ETH", "GHA", "KEN", "LBY", "MAR", "NGA", "SDN", "SEN", "SOM", "TUN", "UGA", "ZAF")
)

var (
	regionAPACKeywords = []string{"亚太", "asia pacific", "indo-pacific", "东亚", "东南亚", "南亚"}
	regionMEKeywords   = []string{"中东", "middle east", "gulf"}
	regionAMKeywords   = []string{"美洲", "americas", "latin america", "north america"}
	regionEUKeywords   = []string{"欧洲", "europe"}
	regionAFKeywords   = []string{"非洲", "africa", "sahel"}
)

func countrySet(codes ...string) map[string]struct{} {
	set := make(map[string]struct{}, len(codes))
	for _, code := range codes {
		set[code] = struct{}{}
	}
	return set
}

// RuleInput is the classifier input the digest search text needs.
type RuleInput struct {
	Title    string
	Summary  string
	Source   string
	Topics   []string
	Entities []Entity
	Location string
}

// Entity is one named entity.
type Entity struct {
	Name string
}

// VerticalSignal is the per-vertical rule signal map.
type VerticalSignal struct {
	CountryMatched        bool
	MatchedCountries      []string
	MatchedStrongKeywords []string
	MatchedWeakKeywords   []string
	ExcludedKeywords      []string
	ConflictKeywords      []string
}

// RuleSignals is the normalized rule context shared by cache freshness,
// classification text and the detail rule-signal projection.
type RuleSignals struct {
	Region                  Region
	RuleVertical            Vertical
	CountryCode             *string
	CountryLabel            string
	EntityTags              []string
	RuleScores              map[Vertical]float64
	VerticalSignals         map[Vertical]VerticalSignal
	CountryMatchedVerticals []Vertical
}

// ClassifyRuleSignals ports ArchiveClassifier.classifyRuleSignals on top of the
// shared taxonomy/country tables. The returned maps are keyed by the closed
// vertical enum, never by business-shaped untyped data.
func ClassifyRuleSignals(input RuleInput) RuleSignals {
	entities := make([]newsnowclusteringops.ArchiveRuleEntity, 0, len(input.Entities))
	for _, entity := range input.Entities {
		entities = append(entities, newsnowclusteringops.ArchiveRuleEntity{Name: entity.Name})
	}
	raw := newsnowclusteringops.ClassifyArchiveRuleSignals(newsnowclusteringops.ArchiveRuleInput{
		Title:    input.Title,
		Summary:  input.Summary,
		Location: input.Location,
		Source:   input.Source,
		Topics:   input.Topics,
		Entities: entities,
	})

	signals := RuleSignals{
		Region:                  resolveRegion(raw.CountryCodes, raw.SearchText),
		RuleVertical:            Vertical(raw.RuleVertical),
		CountryLabel:            raw.CountryLabel,
		EntityTags:              nonNilStrings(raw.EntityTags),
		RuleScores:              make(map[Vertical]float64, len(raw.Scores)),
		VerticalSignals:         make(map[Vertical]VerticalSignal, len(raw.Signals)),
		CountryMatchedVerticals: make([]Vertical, 0, len(raw.CountryMatchedVerticals)),
	}
	if raw.CountryCode != "" {
		code := raw.CountryCode
		signals.CountryCode = &code
	}
	for index, score := range raw.Scores {
		vertical := Vertical(score.Vertical)
		signals.RuleScores[vertical] = score.Score
		if index < len(raw.Signals) {
			signal := raw.Signals[index]
			signals.VerticalSignals[vertical] = VerticalSignal{
				CountryMatched:        signal.CountryMatched,
				MatchedCountries:      nonNilStrings(signal.MatchedCountries),
				MatchedStrongKeywords: nonNilStrings(signal.MatchedStrongKeywords),
				MatchedWeakKeywords:   nonNilStrings(signal.MatchedWeakKeywords),
				ExcludedKeywords:      nonNilStrings(signal.ExcludedKeywords),
				ConflictKeywords:      nonNilStrings(signal.ConflictKeywords),
			}
		}
	}
	for _, vertical := range raw.CountryMatchedVerticals {
		signals.CountryMatchedVerticals = append(signals.CountryMatchedVerticals, Vertical(vertical))
	}
	return signals
}

// resolveRegion mirrors ArchiveClassifier.resolveRegion: the first country code
// in candidate order wins, then the region keyword lists in Asia, Middle East,
// Americas, Europe, Africa order.
func resolveRegion(countryCodes []string, text string) Region {
	for _, code := range countryCodes {
		switch {
		case hasCountry(regionAPACCountries, code):
			return RegionAPAC
		case hasCountry(regionMECountries, code):
			return RegionMiddleEast
		case hasCountry(regionAMCountries, code):
			return RegionAmericas
		case hasCountry(regionEUCountries, code):
			return RegionEurope
		case hasCountry(regionAFCountries, code):
			return RegionAfrica
		}
	}
	for _, candidate := range []struct {
		region   Region
		keywords []string
	}{
		{RegionAPAC, regionAPACKeywords},
		{RegionMiddleEast, regionMEKeywords},
		{RegionAmericas, regionAMKeywords},
		{RegionEurope, regionEUKeywords},
		{RegionAfrica, regionAFKeywords},
	} {
		if matchesAny(text, candidate.keywords) {
			return candidate.region
		}
	}
	return RegionOther
}

func hasCountry(set map[string]struct{}, code string) bool {
	_, ok := set[code]
	return ok
}

func matchesAny(text string, keywords []string) bool {
	for _, keyword := range keywords {
		if keyword != "" && strings.Contains(text, strings.ToLower(keyword)) {
			return true
		}
	}
	return false
}

// ruleVerticalScore is the fixed-order rule score of one vertical.
func (r RuleSignals) ruleVerticalScore(vertical Vertical) float64 {
	return r.RuleScores[vertical]
}

func nonNilStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return values
}

// Archive reading port.
//
// The archive reading unit needs the full rule-signal output of
// apps/api/src/modules/archive/archive.classifier.ts, while this package only
// ported the winning vertical for the domestic opinion index. This file exposes
// the missing read-only surface without changing that pipeline, copying the
// taxonomy keyword tables or editing the generated data file.
package newsnowclusteringops

import "strings"

// ArchiveRuleEntity is one named entity of an article. Only the name feeds the
// archive classifier; the domestic opinion index keeps its richer entity type.
type ArchiveRuleEntity struct {
	Name string
}

// ArchiveRuleInput is the named read-only input of the archive rule classifier.
// Empty strings are the Go representation of a JS null/undefined.
type ArchiveRuleInput struct {
	Title    string
	Summary  string
	Location string
	Source   string
	Topics   []string
	Entities []ArchiveRuleEntity
}

// ArchiveVerticalSignal is the per-vertical rule signal map entry.
type ArchiveVerticalSignal struct {
	CountryMatched        bool
	MatchedCountries      []string
	MatchedStrongKeywords []string
	MatchedWeakKeywords   []string
	ExcludedKeywords      []string
	ConflictKeywords      []string
	Score                 float64
}

// ArchiveVerticalScore is one (vertical, score) pair in fixed vertical order.
type ArchiveVerticalScore struct {
	Vertical ArchiveVertical
	Score    float64
}

// ArchiveRuleResult is the full classifier output the archive read path needs.
// Signals and Scores are aligned with ArchiveVerticals.
type ArchiveRuleResult struct {
	SearchText              string
	EntityTags              []string
	CountryCodes            []string
	CountryCode             string
	CountryLabel            string
	RuleVertical            ArchiveVertical
	Scores                  []ArchiveVerticalScore
	Signals                 []ArchiveVerticalSignal
	CountryMatchedVerticals []ArchiveVertical
}

// ArchiveVerticals returns the fixed evaluation order.
func ArchiveVerticals() []ArchiveVertical {
	return []ArchiveVertical{
		ArchiveVerticalEastSea,
		ArchiveVerticalSouthSea,
		ArchiveVerticalWestFront,
		ArchiveVerticalForeignAffairs,
		ArchiveVerticalDomesticAffairs,
	}
}

// ArchiveCountryName resolves an alpha2/alpha3 country code to the English name
// used by the classifier's matched-country labels and Country hint.
func ArchiveCountryName(code string) string {
	return geoAlpha3ToName[normalizeCountryCode(code)]
}

// ClassifyArchiveRuleSignals reproduces ArchiveClassifier.classifyRuleSignals
// field by field: entity tags, country-code candidate order, country label,
// per-vertical score buckets and the rule winner.
func ClassifyArchiveRuleSignals(input ArchiveRuleInput) ArchiveRuleResult {
	entities := make([]newsSignalEntity, 0, len(input.Entities))
	for _, entity := range input.Entities {
		entities = append(entities, newsSignalEntity{Name: entity.Name})
	}
	article := ruleArticleInput{
		Title:    input.Title,
		Summary:  input.Summary,
		Location: input.Location,
		Source:   input.Source,
		Topics:   input.Topics,
		Entities: entities,
	}

	text := article.buildSearchText()
	entityTags := article.collectEntityTags()
	countryCodes := article.resolveCountryCodes(entityTags)
	primaryCountry := ""
	if len(countryCodes) > 0 {
		primaryCountry = countryCodes[0]
	}

	result := ArchiveRuleResult{
		SearchText:   text,
		EntityTags:   entityTags,
		CountryCodes: countryCodes,
		CountryCode:  primaryCountry,
		CountryLabel: article.resolveArchiveCountryLabel(primaryCountry, entityTags),
	}

	for _, vertical := range archiveVerticalKeys {
		score, countryMatched := article.verticalScore(text, archiveVerticalTaxonomy[vertical], countryCodes)
		definition := archiveVerticalTaxonomy[vertical]
		signal := ArchiveVerticalSignal{
			CountryMatched:        countryMatched,
			MatchedCountries:      nil,
			MatchedStrongKeywords: article.collectKeywordMatches(text, definition.StrongKeywords),
			MatchedWeakKeywords:   article.collectKeywordMatches(text, definition.WeakKeywords),
			ExcludedKeywords:      article.collectKeywordMatches(text, definition.ExcludedKeywords),
			ConflictKeywords:      article.collectKeywordMatches(text, definition.ConflictKeywords),
			Score:                 score,
		}
		countrySet := make(map[string]struct{}, len(definition.Countries))
		for _, code := range definition.Countries {
			countrySet[code] = struct{}{}
		}
		for _, code := range countryCodes {
			if _, ok := countrySet[code]; !ok {
				continue
			}
			name := ArchiveCountryName(code)
			if name == "" {
				name = code
			}
			signal.MatchedCountries = append(signal.MatchedCountries, name)
		}
		result.Scores = append(result.Scores, ArchiveVerticalScore{Vertical: vertical, Score: score})
		result.Signals = append(result.Signals, signal)
		if countryMatched {
			result.CountryMatchedVerticals = append(result.CountryMatchedVerticals, vertical)
		}
	}
	result.RuleVertical = article.resolveRuleVertical()

	return result
}

// resolveArchiveCountryLabel mirrors ArchiveClassifier.resolveCountryLabel: the
// country name when a code was extracted, otherwise the trimmed location, then
// the first entity tag.
func (in ruleArticleInput) resolveArchiveCountryLabel(countryCode string, entityTags []string) string {
	if countryCode != "" {
		if name := ArchiveCountryName(countryCode); name != "" {
			return name
		}
		return countryCode
	}
	if location := strings.TrimSpace(in.Location); location != "" {
		return location
	}
	if len(entityTags) > 0 {
		return entityTags[0]
	}
	return ""
}

package crawlstrategyruns

import (
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// This file ports the three crawl-frontier.utils.ts functions the workflow nodes
// call:
//
//   - inferFrontierPageType (page-type-classifier), :983-1052
//   - scoreFrontierCandidate (url-scorer), :1090-1191
//   - estimateFreshnessScore (freshness-scorer), :1253-1285
//
// plus the pattern/signal matchers they share (:780-897). The regular
// expressions, increments and thresholds are copied verbatim so a workflow run
// assigns the same page types, scores and freshness buckets as NestJS. The
// locale-aware branches of inferFrontierPageType are not reachable from these
// nodes (they need a parent URL/link text the runtime does not pass), so only the
// heuristics the runtime exercises are ported; the unused branch would require
// the locale alias table without changing a single node result.

var (
	frontierArticleSignal    = regexp.MustCompile(`(?i)/(20\d{2}/\d{1,2}/\d{1,2}/|article/|articles/|story/|stories/|content/)`)
	frontierDatedSlug        = regexp.MustCompile(`(?i)(?:^|/)[^/?#]+-\d{4}-\d{1,2}-\d{1,2}/?$`)
	frontierListSignal       = regexp.MustCompile(`(?i)(?:[?&](?:page|p)=\d+\b|/page/\d+(?:/|$)|/(?:latest|archive|archives|index)(?:/|$))`)
	frontierCategorySignal   = regexp.MustCompile(`(?i)/(?:section|sections|category|categories|channel|channels|desk|desks|vertical|verticals)(?:/|$)`)
	frontierNonArticleSignal = regexp.MustCompile(`(?i)/(?:section|sections|topic|topics|tag|tags|author|authors|profile|profiles|series|search|newsletter|newsletters|gallery|galleries|video|videos|podcast|podcasts)(?:/|$)`)
	freshnessURLDate         = regexp.MustCompile(`/(20\d{2})/(\d{1,2})/(\d{1,2})/`)
)

// Page type values (CrawlFrontierPageType).
const (
	PageTypeHome     = "home"
	PageTypeCategory = "category"
	PageTypeList     = "list"
	PageTypeArticle  = "article"
)

// FreshnessRules is CrawlFreshnessRules.
type FreshnessRules struct {
	RecentHours float64 `json:"recentHours"`
	WeekHours   float64 `json:"weekHours"`
	MonthHours  float64 `json:"monthHours"`
}

// PageTypeSignal is CrawlPageTypeSignalConfig.
type PageTypeSignal struct {
	Patterns []string `json:"patterns"`
	Keywords []string `json:"keywords"`
}

// EffectiveProfileConfig is the typed view of the normalized site-profile
// configuration (crawlprofile.NormalizeConfigJSON output) that the workflow nodes
// read. The JSON keys match the normalizer's output exactly.
type EffectiveProfileConfig struct {
	Keywords         []string                  `json:"keywords"`
	PriorityKeywords []string                  `json:"priorityKeywords"`
	DenyKeywords     []string                  `json:"denyKeywords"`
	BlockedDomains   []string                  `json:"blockedDomains"`
	AllowedHosts     []string                  `json:"allowedHosts"`
	HostScope        string                    `json:"hostScope"`
	URLPatterns      map[string][]string       `json:"urlPatterns"`
	PageTypeSignals  map[string]PageTypeSignal `json:"pageTypeSignals"`
	FreshnessRules   *FreshnessRules           `json:"freshnessRules"`
}

// parseEffectiveProfileConfig decodes the normalized config JSON into the typed
// view.
func parseEffectiveProfileConfig(normalized json.RawMessage) (EffectiveProfileConfig, error) {
	var config EffectiveProfileConfig
	if len(normalized) == 0 {
		return config, nil
	}
	if err := json.Unmarshal(normalized, &config); err != nil {
		return EffectiveProfileConfig{}, err
	}
	return config, nil
}

// patternList returns the named URL pattern list.
func (c EffectiveProfileConfig) patternList(key string) []string {
	if c.URLPatterns == nil {
		return nil
	}
	return c.URLPatterns[key]
}

// signal returns the named page type signal.
func (c EffectiveProfileConfig) signal(key string) *PageTypeSignal {
	if c.PageTypeSignals == nil {
		return nil
	}
	if value, ok := c.PageTypeSignals[key]; ok {
		return &value
	}
	return nil
}

// escapeRegex implements escapeRegex.
func escapeRegex(value string) string {
	var builder strings.Builder
	for _, char := range value {
		switch char {
		case '|', '\\', '{', '}', '(', ')', '[', ']', '^', '$', '+', '?', '.':
			builder.WriteRune('\\')
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// wildcardToRegex implements wildcardToRegex: `^body$` case-insensitive with `*`
// expanded to `.*`.
func wildcardToRegex(pattern string) (*regexp.Regexp, bool) {
	body := strings.ReplaceAll(escapeRegex(strings.TrimSpace(pattern)), "*", ".*")
	compiled, err := regexp.Compile("(?i)^" + body + "$")
	if err != nil {
		return nil, false
	}
	return compiled, true
}

// matchURLPattern implements matchURLPattern, including the bare-path substring
// rule.
func matchURLPattern(pattern, rawURL string) bool {
	normalized := strings.TrimSpace(pattern)
	if normalized == "" {
		return false
	}
	if strings.HasPrefix(normalized, "/") && !strings.Contains(normalized, "*") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			return false
		}
		return strings.Contains(parsed.Path, normalized)
	}
	compiled, ok := wildcardToRegex(normalized)
	if !ok {
		return false
	}
	return compiled.MatchString(rawURL)
}

// matchesAnyPattern implements matchesAnyPattern.
func matchesAnyPattern(patterns []string, rawURL string) bool {
	for _, pattern := range patterns {
		if matchURLPattern(pattern, rawURL) {
			return true
		}
	}
	return false
}

// matchesSignalPattern implements matchesSignalPattern.
func matchesSignalPattern(pattern, rawURL, linkText string) bool {
	normalizedPattern := strings.ToLower(strings.TrimSpace(pattern))
	if normalizedPattern == "" {
		return false
	}
	normalizedURL := strings.ToLower(rawURL)
	normalizedText := strings.ToLower(strings.TrimSpace(linkText))
	if strings.Contains(normalizedPattern, "*") ||
		strings.Contains(normalizedPattern, "://") ||
		strings.HasPrefix(normalizedPattern, "/") {
		return matchURLPattern(pattern, rawURL)
	}
	return strings.Contains(normalizedURL, normalizedPattern) ||
		strings.Contains(normalizedText, normalizedPattern)
}

// matchesSignalConfig implements matchesSignalConfig.
func matchesSignalConfig(signal *PageTypeSignal, rawURL, linkText string) bool {
	if signal == nil {
		return false
	}
	for _, pattern := range signal.Patterns {
		if matchesSignalPattern(pattern, rawURL, linkText) {
			return true
		}
	}
	for _, keyword := range signal.Keywords {
		if matchesSignalPattern(keyword, rawURL, linkText) {
			return true
		}
	}
	return false
}

// matchesConfiguredKeyword implements matchesConfiguredKeyword.
func matchesConfiguredKeyword(keywords []string, rawURL, linkText string) bool {
	normalizedURL := strings.ToLower(rawURL)
	normalizedText := strings.ToLower(strings.TrimSpace(linkText))
	for _, keyword := range keywords {
		normalizedKeyword := strings.ToLower(strings.TrimSpace(keyword))
		if normalizedKeyword == "" {
			continue
		}
		if strings.Contains(normalizedURL, normalizedKeyword) ||
			strings.Contains(normalizedText, normalizedKeyword) {
			return true
		}
	}
	return false
}

// inferNonArticleHubPageType implements inferNonArticleHubPageType.
func inferNonArticleHubPageType(parentPageType string) string {
	switch parentPageType {
	case PageTypeHome:
		return PageTypeCategory
	case PageTypeArticle:
		return PageTypeArticle
	default:
		return PageTypeList
	}
}

// inferPageType implements inferFrontierPageType for the runtime call shape
// (url, parentPageType "home", config, publishedAtTs; no link text).
func inferPageType(rawURL, parentPageType string, config EffectiveProfileConfig, publishedAtTs *int64) string {
	hasPublishedTimestamp := publishedAtTs != nil
	matchesNonArticleSignal := frontierNonArticleSignal.MatchString(rawURL)
	matchesArticleHeuristic := !matchesNonArticleSignal &&
		(frontierArticleSignal.MatchString(rawURL) || frontierDatedSlug.MatchString(rawURL))

	if matchesSignalConfig(config.signal(PageTypeArticle), rawURL, "") {
		return PageTypeArticle
	}
	if matchesSignalConfig(config.signal(PageTypeList), rawURL, "") {
		return PageTypeList
	}
	if matchesSignalConfig(config.signal(PageTypeHome), rawURL, "") {
		return PageTypeHome
	}
	if matchesAnyPattern(config.patternList(PageTypeArticle), rawURL) {
		return PageTypeArticle
	}
	if matchesAnyPattern(config.patternList(PageTypeList), rawURL) {
		return PageTypeList
	}
	if matchesAnyPattern(config.patternList(PageTypeHome), rawURL) {
		return PageTypeHome
	}
	if hasPublishedTimestamp &&
		!matchesNonArticleSignal &&
		!matchesAnyPattern(config.patternList("exclude"), rawURL) &&
		!matchesSignalConfig(config.signal("deny"), rawURL, "") {
		return PageTypeArticle
	}
	if matchesArticleHeuristic {
		return PageTypeArticle
	}
	if matchesSignalConfig(config.signal(PageTypeCategory), rawURL, "") {
		return PageTypeCategory
	}
	if matchesAnyPattern(config.patternList(PageTypeCategory), rawURL) {
		return PageTypeCategory
	}
	if frontierListSignal.MatchString(rawURL) {
		return inferNonArticleHubPageType(parentPageType)
	}
	if frontierCategorySignal.MatchString(rawURL) || matchesNonArticleSignal {
		return inferNonArticleHubPageType(parentPageType)
	}
	switch parentPageType {
	case PageTypeHome:
		return PageTypeCategory
	case PageTypeCategory:
		return PageTypeList
	case PageTypeList:
		return PageTypeList
	default:
		return PageTypeArticle
	}
}

// scoreCandidate implements scoreFrontierCandidate for the runtime call shape
// (url, pageType, config, rawScore, freshnessScore; no parent URL or link text).
func scoreCandidate(rawURL, pageType string, config EffectiveProfileConfig, rawScore *float64, freshnessScore *float64) float64 {
	score := 0.0
	if rawScore != nil {
		score = *rawScore
	}
	switch pageType {
	case PageTypeArticle:
		score += 0.35
	case PageTypeList:
		score += 0.2
	case PageTypeCategory:
		score += 0.1
	}
	if matchesAnyPattern(config.patternList("exclude"), rawURL) {
		score -= 1
	}
	matchesConfiguredScope := matchesSignalConfig(config.signal(pageType), rawURL, "") ||
		matchesAnyPattern(config.patternList(pageType), rawURL) ||
		matchesAnyPattern(config.patternList(PageTypeHome), rawURL) ||
		matchesAnyPattern(config.patternList(PageTypeCategory), rawURL) ||
		matchesAnyPattern(config.patternList(PageTypeList), rawURL) ||
		matchesAnyPattern(config.patternList(PageTypeArticle), rawURL)
	if matchesConfiguredScope {
		score += 0.8
	}
	// No parent URL is passed by the runtime node, so the parent scope anchor
	// branch contributes nothing (parentPathSegments is empty in the source too).
	lowerURL := strings.ToLower(rawURL)
	for _, keyword := range config.Keywords {
		normalizedKeyword := strings.ToLower(keyword)
		if strings.Contains(lowerURL, normalizedKeyword) {
			score += 0.05
		}
	}
	if matchesConfiguredKeyword(config.PriorityKeywords, rawURL, "") {
		score += 0.1
	}
	if matchesConfiguredKeyword(config.DenyKeywords, rawURL, "") {
		score -= 0.35
	}
	freshness := 0.0
	if freshnessScore != nil {
		freshness = *freshnessScore
	}
	switch {
	case freshness >= 0.99:
		score += 0.35
	case freshness >= 0.74:
		score += 0.2
	case freshness >= 0.39:
		score += 0.05
	}
	return roundToDigits(score, 4)
}

// estimateFreshness implements estimateFreshnessScore.
func estimateFreshness(rawURL string, rules *FreshnessRules) float64 {
	match := freshnessURLDate.FindStringSubmatch(rawURL)
	if match == nil {
		return 0
	}
	year, okYear := atoiSafe(match[1])
	month, okMonth := atoiSafe(match[2])
	day, okDay := atoiSafe(match[3])
	if !okYear || !okMonth || !okDay {
		return 0
	}
	parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	ageHours := time.Since(parsed).Hours()
	recentHours := 24.0
	weekHours := 24.0 * 7
	monthHours := 24.0 * 30
	if rules != nil {
		recentHours = rules.RecentHours
		weekHours = rules.WeekHours
		monthHours = rules.MonthHours
	}
	switch {
	case ageHours <= recentHours:
		return 1
	case ageHours <= weekHours:
		return 0.75
	case ageHours <= monthHours:
		return 0.4
	default:
		return 0.1
	}
}

func atoiSafe(value string) (int, bool) {
	number := 0
	if value == "" {
		return 0, false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, false
		}
		number = number*10 + int(char-'0')
	}
	return number, true
}

// roundToDigits implements Number(value.toFixed(digits)).
func roundToDigits(value float64, digits int) float64 {
	scale := math.Pow(10, float64(digits))
	return math.Round(value*scale) / scale
}

// sortedURLPatternKeys is used by tests to assert deterministic iteration.
func sortedURLPatternKeys(patterns map[string][]string) []string {
	keys := make([]string, 0, len(patterns))
	for key := range patterns {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

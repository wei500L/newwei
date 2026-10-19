package crawlstrategyruns

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// This file ports the crawl-frontier.utils.ts functions the workflow runtime
// nodes call: inferFrontierPageType (:983-1051), scoreFrontierCandidate
// (:1090-1190) and estimateFreshnessScore (:1253-1284), plus the shared
// pattern/keyword matchers they use (:799-885, :897-906). The profile config
// itself is the normalized JSON crawlprofile produces.

var (
	articleSignalPattern    = regexp.MustCompile(`(?i)/(20\d{2}/\d{1,2}/\d{1,2}/|article/|articles/|story/|stories/|content/)`)
	datedArticleSlugPattern = regexp.MustCompile(`(?i)(?:^|/)[^/?#]+-\d{4}-\d{1,2}-\d{1,2}/?$`)
	listSignalPattern       = regexp.MustCompile(`(?i)(?:[?&](?:page|p)=\d+\b|/page/\d+(?:/|$)|/(?:latest|archive|archives|index)(?:/|$))`)
	categorySignalPattern   = regexp.MustCompile(`(?i)/(?:section|sections|category|categories|channel|channels|desk|desks|vertical|verticals)(?:/|$)`)
	nonArticleSignalPattern = regexp.MustCompile(`(?i)/(?:section|sections|topic|topics|tag|tags|author|authors|profile|profiles|series|search|newsletter|newsletters|gallery|galleries|video|videos|podcast|podcasts)(?:/|$)`)
	freshnessDatePattern    = regexp.MustCompile(`/(20\d{2})/(\d{1,2})/(\d{1,2})/`)
	patternEscapeChars      = regexp.MustCompile(`[|\\{}()\[\]^$+?.]`)
)

// PageTypeSignal is CrawlPageTypeSignalConfig.
type PageTypeSignal struct {
	Patterns []string
	Keywords []string
}

// FreshnessRules is CrawlFreshnessRules.
type FreshnessRules struct {
	RecentHours float64
	WeekHours   float64
	MonthHours  float64
}

// ProfileConfig is the normalized crawl-site-profile subset the scoring
// helpers read.
type ProfileConfig struct {
	URLPatterns      map[string][]string
	PageTypeSignals  map[string]PageTypeSignal
	Keywords         []string
	PriorityKeywords []string
	DenyKeywords     []string
	FreshnessRules   FreshnessRules
}

// ParseProfileConfig reads the normalized config JSON. Missing freshness rules
// fall back to the source defaults.
func ParseProfileConfig(raw json.RawMessage) ProfileConfig {
	config := ProfileConfig{
		URLPatterns:     map[string][]string{},
		PageTypeSignals: map[string]PageTypeSignal{},
		FreshnessRules:  FreshnessRules{RecentHours: 24, WeekHours: 24 * 7, MonthHours: 24 * 30},
	}
	if len(raw) == 0 {
		return config
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return config
	}
	if patterns, ok := objectOf(document["urlPatterns"]); ok {
		for key, value := range patterns {
			config.URLPatterns[key] = stringList(value)
		}
	}
	if signals, ok := objectOf(document["pageTypeSignals"]); ok {
		for key, value := range signals {
			var record map[string]json.RawMessage
			if err := json.Unmarshal(value, &record); err != nil {
				continue
			}
			config.PageTypeSignals[key] = PageTypeSignal{
				Patterns: stringList(record["patterns"]),
				Keywords: stringList(record["keywords"]),
			}
		}
	}
	config.Keywords = stringList(document["keywords"])
	config.PriorityKeywords = stringList(document["priorityKeywords"])
	config.DenyKeywords = stringList(document["denyKeywords"])
	if rules, ok := objectOf(document["freshnessRules"]); ok {
		if value, ok := numberValue(rules["recentHours"]); ok {
			config.FreshnessRules.RecentHours = value
		}
		if value, ok := numberValue(rules["weekHours"]); ok {
			config.FreshnessRules.WeekHours = value
		}
		if value, ok := numberValue(rules["monthHours"]); ok {
			config.FreshnessRules.MonthHours = value
		}
	}
	return config
}

// WithURLPatterns returns a copy whose urlPatterns entry is replaced wholesale
// (the runtime's `{...config, urlPatterns: node.config.urlPatterns}` spread).
func (c ProfileConfig) WithURLPatterns(patterns map[string][]string) ProfileConfig {
	if patterns == nil {
		return c
	}
	out := c.clone()
	out.URLPatterns = patterns
	return out
}

// WithPageTypeSignals replaces pageTypeSignals wholesale.
func (c ProfileConfig) WithPageTypeSignals(signals map[string]PageTypeSignal) ProfileConfig {
	if signals == nil {
		return c
	}
	out := c.clone()
	out.PageTypeSignals = signals
	return out
}

// WithKeywords replaces keywords and priorityKeywords wholesale.
func (c ProfileConfig) WithKeywords(keywords []string) ProfileConfig {
	out := c.clone()
	out.Keywords = keywords
	out.PriorityKeywords = keywords
	return out
}

// WithFreshnessRules replaces freshnessRules wholesale.
func (c ProfileConfig) WithFreshnessRules(rules FreshnessRules) ProfileConfig {
	out := c.clone()
	out.FreshnessRules = rules
	return out
}

func (c ProfileConfig) clone() ProfileConfig {
	out := ProfileConfig{
		URLPatterns:      map[string][]string{},
		PageTypeSignals:  map[string]PageTypeSignal{},
		Keywords:         c.Keywords,
		PriorityKeywords: c.PriorityKeywords,
		DenyKeywords:     c.DenyKeywords,
		FreshnessRules:   c.FreshnessRules,
	}
	for key, value := range c.URLPatterns {
		out.URLPatterns[key] = value
	}
	for key, value := range c.PageTypeSignals {
		out.PageTypeSignals[key] = value
	}
	return out
}

// InferFrontierPageType ports inferFrontierPageType.
func InferFrontierPageType(rawURL, parentPageType string, config ProfileConfig, publishedAtTs *int64) string {
	hasPublishedTimestamp := publishedAtTs != nil
	matchesNonArticleSignal := nonArticleSignalPattern.MatchString(rawURL)
	matchesArticleHeuristic := !matchesNonArticleSignal &&
		(articleSignalPattern.MatchString(rawURL) || datedArticleSlugPattern.MatchString(rawURL))
	if matchesSignalConfig(signalOf(config, "article"), rawURL, "") {
		return "article"
	}
	if matchesSignalConfig(signalOf(config, "list"), rawURL, "") {
		return "list"
	}
	if matchesSignalConfig(signalOf(config, "home"), rawURL, "") {
		return "home"
	}
	if matchesAnyPattern(config.URLPatterns["article"], rawURL) {
		return "article"
	}
	if matchesAnyPattern(config.URLPatterns["list"], rawURL) {
		return "list"
	}
	if matchesAnyPattern(config.URLPatterns["home"], rawURL) {
		return "home"
	}
	if hasPublishedTimestamp && !matchesNonArticleSignal &&
		!matchesAnyPattern(config.URLPatterns["exclude"], rawURL) &&
		!matchesSignalConfig(signalOf(config, "deny"), rawURL, "") {
		return "article"
	}
	if matchesArticleHeuristic {
		return "article"
	}
	if matchesSignalConfig(signalOf(config, "category"), rawURL, "") {
		return "category"
	}
	if matchesAnyPattern(config.URLPatterns["category"], rawURL) {
		return "category"
	}
	if listSignalPattern.MatchString(rawURL) {
		return inferNonArticleHubPageType(parentPageType)
	}
	if categorySignalPattern.MatchString(rawURL) || matchesNonArticleSignal {
		return inferNonArticleHubPageType(parentPageType)
	}
	switch parentPageType {
	case "home":
		return "category"
	case "category", "list":
		return "list"
	}
	return "article"
}

func inferNonArticleHubPageType(parentPageType string) string {
	switch parentPageType {
	case "home":
		return "category"
	case "article":
		return "article"
	}
	return "list"
}

// ScoreFrontierCandidate ports scoreFrontierCandidate for the runtime's usage
// (no parent URL or link text).
func ScoreFrontierCandidate(rawURL, pageType string, config ProfileConfig, rawScore *float64, freshnessScore *float64) float64 {
	score := 0.0
	if rawScore != nil {
		score = *rawScore
	}
	switch pageType {
	case "article":
		score += 0.35
	case "list":
		score += 0.2
	case "category":
		score += 0.1
	}
	if matchesAnyPattern(config.URLPatterns["exclude"], rawURL) {
		score -= 1
	}
	matchesConfiguredScope := matchesSignalConfig(signalOf(config, pageType), rawURL, "") ||
		matchesAnyPattern(config.URLPatterns[pageType], rawURL) ||
		matchesAnyPattern(config.URLPatterns["home"], rawURL) ||
		matchesAnyPattern(config.URLPatterns["category"], rawURL) ||
		matchesAnyPattern(config.URLPatterns["list"], rawURL) ||
		matchesAnyPattern(config.URLPatterns["article"], rawURL)
	if matchesConfiguredScope {
		score += 0.8
	}
	lowerURL := strings.ToLower(rawURL)
	for _, keyword := range config.Keywords {
		normalized := strings.ToLower(keyword)
		if normalized == "" {
			continue
		}
		if strings.Contains(lowerURL, normalized) {
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
	return roundToFixed(score, 4)
}

// EstimateFreshnessScore ports estimateFreshnessScore.
func EstimateFreshnessScore(rawURL string, config ProfileConfig) float64 {
	match := freshnessDatePattern.FindStringSubmatch(rawURL)
	if match == nil {
		return 0
	}
	year := atoiDefault(match[1])
	month := atoiDefault(match[2]) - 1
	day := atoiDefault(match[3])
	parsed := time.Date(year, time.Month(month+1), day, 0, 0, 0, 0, time.UTC)
	ageHours := time.Since(parsed).Hours()
	rules := config.FreshnessRules
	switch {
	case ageHours <= rules.RecentHours:
		return 1
	case ageHours <= rules.WeekHours:
		return 0.75
	case ageHours <= rules.MonthHours:
		return 0.4
	}
	return 0.1
}

// ---------------------------------------------------------------------------
// pattern helpers

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
	compiled, err := wildcardToRegex(normalized)
	if err != nil {
		return false
	}
	return compiled.MatchString(rawURL)
}

func matchesAnyPattern(patterns []string, rawURL string) bool {
	for _, pattern := range patterns {
		if matchURLPattern(pattern, rawURL) {
			return true
		}
	}
	return false
}

func matchesSignalPattern(pattern, rawURL, linkText string) bool {
	normalizedPattern := strings.ToLower(strings.TrimSpace(pattern))
	if normalizedPattern == "" {
		return false
	}
	normalizedURL := strings.ToLower(rawURL)
	normalizedText := strings.ToLower(strings.TrimSpace(linkText))
	if strings.Contains(normalizedPattern, "*") || strings.Contains(normalizedPattern, "://") || strings.HasPrefix(normalizedPattern, "/") {
		return matchURLPattern(pattern, rawURL)
	}
	return strings.Contains(normalizedURL, normalizedPattern) || strings.Contains(normalizedText, normalizedPattern)
}

func matchesSignalConfig(signal PageTypeSignal, rawURL, linkText string) bool {
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

func signalOf(config ProfileConfig, key string) PageTypeSignal {
	return config.PageTypeSignals[key]
}

func matchesConfiguredKeyword(keywords []string, rawURL, linkText string) bool {
	normalizedURL := strings.ToLower(rawURL)
	normalizedText := strings.ToLower(strings.TrimSpace(linkText))
	for _, keyword := range keywords {
		normalized := strings.ToLower(strings.TrimSpace(keyword))
		if normalized == "" {
			continue
		}
		if strings.Contains(normalizedURL, normalized) || strings.Contains(normalizedText, normalized) {
			return true
		}
	}
	return false
}

func wildcardToRegex(pattern string) (*regexp.Regexp, error) {
	body := strings.ReplaceAll(escapePattern(pattern), "*", ".*")
	return regexp.Compile("(?i)^" + body + "$")
}

func escapePattern(value string) string {
	return patternEscapeChars.ReplaceAllStringFunc(value, func(match string) string {
		return "\\" + match
	})
}

// objectOf decodes an object leaf; a missing or non-object value is not ok.
func objectOf(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return nil, false
	}
	record := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return nil, false
	}
	return record, true
}

func stringList(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil
	}
	var values []string
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmedValue := strings.TrimSpace(value)
		if trimmedValue == "" {
			continue
		}
		out = append(out, trimmedValue)
	}
	return out
}

func numberValue(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch trimmed[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		return 0, false
	}
	var value float64
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return 0, false
	}
	return value, true
}

func roundToFixed(value float64, digits int) float64 {
	scale := 1.0
	for index := 0; index < digits; index++ {
		scale *= 10
	}
	scaled := value * scale
	if scaled < 0 {
		return -float64(int64(-scaled+0.5)) / scale
	}
	return float64(int64(scaled+0.5)) / scale
}

func atoiDefault(value string) int {
	result := 0
	for _, char := range value {
		if char < '0' || char > '9' {
			return result
		}
		result = result*10 + int(char-'0')
	}
	return result
}

// parseISOTime accepts the ISO-8601 spellings the runtime stores for candidate
// timestamps.
func parseISOTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

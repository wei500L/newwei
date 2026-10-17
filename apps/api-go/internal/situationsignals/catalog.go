package situationsignals

import (
	"strings"
)

// This file reproduces the static catalog served by GET /catalog. The two lists
// are copied entry by entry from
// apps/api/src/modules/situation-monitor/analysis/patterns.ts
// (CORRELATION_TOPICS then NARRATIVE_PATTERNS) and only `id`, `category` and,
// for narratives, `severity` are part of the response; the regex/keyword bodies
// stay on NestJS because nothing in this batch evaluates them.

// correlationTopic is one CORRELATION_TOPICS entry.
type correlationTopic struct {
	id       string
	category string
}

// narrativePattern is one NARRATIVE_PATTERNS entry.
type narrativePattern struct {
	id       string
	category string
	severity string
}

// correlationTopics mirrors CORRELATION_TOPICS in declaration order.
var correlationTopics = []correlationTopic{
	{"tariffs", "Economy"},
	{"fed-rates", "Economy"},
	{"inflation", "Economy"},
	{"ai-regulation", "Tech"},
	{"china-tensions", "Geopolitics"},
	{"russia-ukraine", "Conflict"},
	{"israel-gaza", "Conflict"},
	{"iran", "Geopolitics"},
	{"crypto", "Finance"},
	{"housing", "Economy"},
	{"layoffs", "Business"},
	{"bank-crisis", "Finance"},
	{"election", "Politics"},
	{"immigration", "Politics"},
	{"climate", "Environment"},
	{"pandemic", "Health"},
	{"nuclear", "Security"},
	{"supply-chain", "Economy"},
	{"big-tech", "Tech"},
	{"deepfake", "Tech"},
}

// narrativePatterns mirrors NARRATIVE_PATTERNS in declaration order.
var narrativePatterns = []narrativePattern{
	{"deep-state", "Political", "watch"},
	{"cbdc-control", "Finance", "watch"},
	{"wef-agenda", "Political", "watch"},
	{"bio-weapon", "Health", "emerging"},
	{"election-fraud", "Political", "watch"},
	{"ai-doom", "Tech", "emerging"},
	{"ai-consciousness", "Tech", "emerging"},
	{"robot-replacement", "Economy", "spreading"},
	{"china-invasion", "Geopolitical", "watch"},
	{"nato-expansion", "Geopolitical", "watch"},
	{"dollar-collapse", "Finance", "spreading"},
	{"vaccine-injury", "Health", "watch"},
	{"next-pandemic", "Health", "emerging"},
	{"depopulation", "Society", "disinfo"},
	{"food-crisis", "Economy", "emerging"},
	{"energy-war", "Economy", "spreading"},
}

// catalogNarrative is one response narrative.
type catalogNarrative struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Severity string `json:"severity"`
}

// catalogCorrelation is one response correlation topic.
type catalogCorrelation struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
}

// catalogBackendRefreshTargets is the refreshReadiness.backendRefreshTargets
// block.
type catalogBackendRefreshTargets struct {
	Crawl    bool `json:"crawl"`
	Telegram bool `json:"telegram"`
	Oref     bool `json:"oref"`
	Any      bool `json:"any"`
}

// catalogRefreshReadiness is the refreshReadiness block.
type catalogRefreshReadiness struct {
	ActiveSourceCount     int                          `json:"activeSourceCount"`
	BackendRefreshTargets catalogBackendRefreshTargets `json:"backendRefreshTargets"`
}

// catalogResponse is the GET /catalog body. Key order follows the NestJS
// controller literal.
type catalogResponse struct {
	Narratives       []catalogNarrative      `json:"narratives"`
	Correlations     []catalogCorrelation    `json:"correlations"`
	RefreshReadiness catalogRefreshReadiness `json:"refreshReadiness"`
}

// formatIDTitle mirrors controller.formatIdTitle:
//
//	id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
//
// The replacement is ASCII-only because the JavaScript regex has no `u` flag, so
// only [A-Za-z0-9_] characters can start a word and only ASCII letters can
// change.
func formatIDTitle(id string) string {
	spaced := strings.ReplaceAll(id, "-", " ")
	out := []rune(spaced)
	previousIsWord := false
	for index, r := range out {
		isWord := isASCIIWordRune(r)
		if isWord && !previousIsWord {
			out[index] = asciiUpper(r)
		}
		previousIsWord = isWord
	}
	return string(out)
}

// isASCIIWordRune mirrors JavaScript's \w.
func isASCIIWordRune(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z':
		return true
	case r >= 'A' && r <= 'Z':
		return true
	case r >= '0' && r <= '9':
		return true
	case r == '_':
		return true
	}
	return false
}

// asciiUpper mirrors String.prototype.toUpperCase for the ASCII range.
func asciiUpper(r rune) rune {
	if r >= 'a' && r <= 'z' {
		return r - ('a' - 'A')
	}
	return r
}

package knowledgegraph

import (
	"regexp"
	"strings"
)

// The Nest service narrows names with JavaScript string methods. This file
// mirrors those steps exactly: whitespace collapse, company-suffix stripping,
// and A-share ticker expansion.

var (
	bracketSuffix = regexp.MustCompile(`[\t\n\v\f\r \x{00A0}\x{FEFF}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]*[(\x{FF08}][^)\x{FF09}]+[)\x{FF09}][\t\n\v\f\r \x{00A0}\x{FEFF}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]*`)
	tickerDot     = regexp.MustCompile(`^(\d{6})\.(SH|SZ|BJ)$`)
	tickerPrefix  = regexp.MustCompile(`^(SH|SZ|BJ)(\d{6})$`)
	tickerBare    = regexp.MustCompile(`^(\d{6})$`)
)

var companySuffixes = []string{
	"股份有限公司",
	"有限责任公司",
	"有限公司",
	"集团股份有限公司",
	"集团有限公司",
	"集团",
	"CO., LTD",
	"CO.,LTD",
	"CO. LTD",
	"CO LTD",
	"COMPANY LIMITED",
	"LIMITED",
	"LTD",
	"INC",
	"CORPORATION",
	"CORP",
}

var entityTypePreference = []string{
	"company",
	"commodity",
	"policy",
	"industry",
	"person",
	"instrument",
	"organization",
}

var sourcePreference = []string{"user", "seed", "derived", "llm"}

// validEntityType reports whether value is one of the Prisma KnowledgeEntityType
// values. Invalid strings are ignored, not rejected.
func validEntityType(value string) (string, bool) {
	normalized := strings.ToLower(trimSpace(value))
	for _, allowed := range entityTypePreference {
		if normalized == allowed {
			return allowed, true
		}
	}
	return "", false
}

func looksLikeTicker(value string) bool {
	return parseTicker(value) != nil
}

// parseTicker accepts 600519.SH, SH600519, or bare 600519.
func parseTicker(value string) *ticker {
	normalized := strings.ToUpper(trimSpace(value))
	if match := tickerDot.FindStringSubmatch(normalized); match != nil {
		return &ticker{code: match[1], exchange: match[2]}
	}
	if match := tickerPrefix.FindStringSubmatch(normalized); match != nil {
		return &ticker{code: match[2], exchange: match[1]}
	}
	if match := tickerBare.FindStringSubmatch(normalized); match != nil {
		return &ticker{code: match[1]}
	}
	return nil
}

type ticker struct {
	code     string
	exchange string
}

// buildTickerAliases expands a ticker into every stored alias shape. The order
// matches the Nest Set: code, then code.EX/EXcode per exchange.
func buildTickerAliases(value string) []string {
	parsed := parseTicker(value)
	if parsed == nil {
		return nil
	}
	seen := map[string]bool{}
	aliases := make([]string, 0, 7)
	add := func(alias string) {
		if seen[alias] {
			return
		}
		seen[alias] = true
		aliases = append(aliases, alias)
	}
	add(parsed.code)
	exchanges := []string{"SH", "SZ", "BJ"}
	if parsed.exchange != "" {
		exchanges = []string{parsed.exchange}
	}
	for _, exchange := range exchanges {
		add(parsed.code + "." + exchange)
		add(exchange + parsed.code)
	}
	return aliases
}

// buildCompanyAliasCandidates adds the bracket-stripped name and every
// company suffix variant. Suffixes are checked against the uppercased name and
// applied to the original casing, as the Nest service does.
func buildCompanyAliasCandidates(value string) []string {
	trimmed := collapseSpaces(trimSpace(value))
	if trimmed == "" {
		return nil
	}
	seen := map[string]bool{}
	aliases := make([]string, 0, len(companySuffixes)+2)
	add := func(alias string) {
		if alias == "" || seen[alias] {
			return
		}
		seen[alias] = true
		aliases = append(aliases, alias)
	}
	add(trimmed)

	withoutBrackets := collapseSpaces(trimSpace(bracketSuffix.ReplaceAllString(trimmed, " ")))
	if withoutBrackets != "" && withoutBrackets != trimmed {
		add(withoutBrackets)
	}

	upper := strings.ToUpper(withoutBrackets)
	for _, suffix := range companySuffixes {
		if !strings.HasSuffix(upper, suffix) {
			continue
		}
		// upper is byte-for-byte as long as withoutBrackets for the suffix
		// match, so slicing the original by the same byte count is safe.
		candidate := trimSpace(withoutBrackets[:len(withoutBrackets)-len(suffix)])
		if candidate != "" {
			add(candidate)
		}
	}
	return aliases
}

// normalizeSearchKeys returns at most 20 distinct lookup keys.
func normalizeSearchKeys(value string) []string {
	trimmed := trimSpace(value)
	if trimmed == "" {
		return nil
	}
	seen := map[string]bool{}
	keys := make([]string, 0, 20)
	add := func(raw string) {
		key := normalizeEntityKey(raw)
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		keys = append(keys, key)
	}
	add(trimmed)
	for _, alias := range buildCompanyAliasCandidates(trimmed) {
		add(alias)
	}
	for _, alias := range buildTickerAliases(trimmed) {
		add(alias)
	}
	if len(keys) > 20 {
		keys = keys[:20]
	}
	return keys
}

func normalizeEntityKey(value string) string {
	return strings.ToLower(collapseSpaces(trimSpace(value)))
}

// trimSpace matches JavaScript String.prototype.trim: the same whitespace set
// the collapse helper understands, including the BOM.
func trimSpace(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

func collapseSpaces(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	pendingSpace := false
	for _, r := range value {
		if isJSSpace(r) {
			pendingSpace = true
			continue
		}
		if pendingSpace && builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		pendingSpace = false
		builder.WriteRune(r)
	}
	return builder.String()
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

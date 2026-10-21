package crawlworker

// Text helpers that reproduce the JavaScript string semantics of
// crawl.processor.ts. The crawl failure message is stored in a MySQL
// VARCHAR(191)/VARCHAR(4000) column and compared against values NestJS wrote,
// so the length unit matters: JavaScript measures String.prototype.length,
// trimEnd and slice in UTF-16 code units, not in Unicode code points.

import (
	"strings"
	"unicode/utf16"
)

// isJSSpace reports whether the rune belongs to ECMAScript's WhiteSpace or
// LineTerminator set, which is what String.prototype.trim/trimEnd remove.
//
// It is deliberately not unicode.IsSpace: JavaScript trims U+FEFF (ZERO WIDTH
// NO-BREAK SPACE) and keeps U+0085 (NEXT LINE), while Go does the opposite.
func isJSSpace(value rune) bool {
	switch value {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', // NO-BREAK SPACE
		'\u1680', // OGHAM SPACE MARK
		'\u2028', // LINE SEPARATOR
		'\u2029', // PARAGRAPH SEPARATOR
		'\u202f', // NARROW NO-BREAK SPACE
		'\u205f', // MEDIUM MATHEMATICAL SPACE
		'\u3000', // IDEOGRAPHIC SPACE
		'\ufeff': // ZERO WIDTH NO-BREAK SPACE
		return true
	}
	return value >= '\u2000' && value <= '\u200a'
}

// trimText is String.prototype.trim.
func trimText(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

// trimEndText is String.prototype.trimEnd.
func trimEndText(value string) string {
	return strings.TrimRightFunc(value, isJSSpace)
}

// utf16Length is String.prototype.length.
func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// truncateText is truncateText in crawl.processor.ts: trim, keep a value within
// maxLength UTF-16 code units unchanged, otherwise cut to maxLength-1 code
// units, trim the trailing whitespace of that prefix and append an ellipsis.
//
// A cut that lands inside a surrogate pair leaves JavaScript with an unpaired
// high surrogate. Go strings cannot carry one (utf16.Decode would emit U+FFFD),
// so the dangling unit is dropped and the text is re-trimmed: truncating
// "a😀bc" to 3 units therefore yields "a…" instead of "a\uD83D…". This only
// affects text that ends inside a non-BMP character, which MySQL's utf8mb4
// would reject anyway.
func truncateText(value string, maxLength int) string {
	if maxLength <= 0 {
		return ""
	}
	trimmed := trimText(value)
	if utf16Length(trimmed) <= maxLength {
		return trimmed
	}
	units := utf16.Encode([]rune(trimmed))[:maxLength-1]
	// trimEnd on the sliced value: drop trailing whitespace code units. Surrogate
	// code units are never whitespace, so a dangling high surrogate survives the
	// loop and is removed below.
	for len(units) > 0 && !isSurrogateUnit(units[len(units)-1]) && isJSSpace(rune(units[len(units)-1])) {
		units = units[:len(units)-1]
	}
	if len(units) > 0 && units[len(units)-1] >= 0xd800 && units[len(units)-1] <= 0xdbff {
		units = units[:len(units)-1]
	}
	return trimEndText(string(utf16.Decode(units))) + "…"
}

// isSurrogateUnit reports whether the UTF-16 code unit is a surrogate (either
// half). Go's rune type cannot represent them, which is why the trimming loop
// checks the raw unit first.
func isSurrogateUnit(unit uint16) bool {
	return unit >= 0xd800 && unit <= 0xdfff
}

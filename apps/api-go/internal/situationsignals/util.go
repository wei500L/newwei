package situationsignals

import (
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// This file holds the shared normalization and numeric helpers. They mirror the
// module-level helpers of
// apps/api/src/modules/situation-monitor/situation-monitor-monitors.service.ts.

const (
	maxDisplayValueLen = 128
	maxNameLen         = 64
)

var (
	whitespaceRunPattern = regexp.MustCompile(`\s+`)
	shortAsciiPattern    = regexp.MustCompile(`^[a-z0-9]+$`)
)

// normalizeDisplayValue mirrors normalizeDisplayValue: trim, collapse runs of
// whitespace and clip to 128 UTF-16 code units.
func normalizeDisplayValue(value string) string {
	collapsed := whitespaceRunPattern.ReplaceAllString(strings.TrimSpace(value), " ")
	return clipUTF16(collapsed, maxDisplayValueLen)
}

// normalizeTerm mirrors normalizeTerm.
func normalizeTerm(value string) string {
	return strings.ToLower(normalizeDisplayValue(value))
}

// normalizeName mirrors normalizeName.
func normalizeName(value string) string {
	return clipUTF16(strings.TrimSpace(value), maxNameLen)
}

// normalizeStringList mirrors normalizeStringList: display-value normalization,
// case-insensitive de-duplication in first-seen order and a hard limit.
func normalizeStringList(values []string, limit int) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, entry := range values {
		displayValue := normalizeDisplayValue(entry)
		if displayValue == "" {
			continue
		}
		normalized := strings.ToLower(displayValue)
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		out = append(out, displayValue)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// clipUTF16 trims a string to at most limit UTF-16 code units, which is what
// JavaScript's slice does. Slicing inside a surrogate pair produces U+FFFD.
func clipUTF16(value string, limit int) string {
	encoded := utf16.Encode([]rune(value))
	if len(encoded) <= limit {
		return value
	}
	return string(utf16.Decode(encoded[:limit]))
}

// utf16Len mirrors String.prototype.length.
func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// isShortAscii mirrors `normalized.length <= 3 && /^[a-z0-9]+$/.test(normalized)`.
func isShortAscii(normalized string) bool {
	return utf16Len(normalized) <= 3 && shortAsciiPattern.MatchString(normalized)
}

// hasWordBoundaryMatch reports whether haystack contains `\<word>\b`, which for
// the ASCII words this matcher sees is the same as an exact token match.
func hasWordBoundaryMatch(haystack, word string) bool {
	index := 0
	for {
		found := strings.Index(haystack[index:], word)
		if found < 0 {
			return false
		}
		start := index + found
		end := start + len(word)
		startOK := start == 0 || !isASCIIWordByte(haystack[start-1])
		endOK := end >= len(haystack) || !isASCIIWordByte(haystack[end])
		if startOK && endOK {
			return true
		}
		index = start + 1
		if index >= len(haystack) {
			return false
		}
	}
}

// isASCIIWordByte reports whether the byte can continue a JavaScript \w run.
func isASCIIWordByte(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z':
		return true
	case b >= 'A' && b <= 'Z':
		return true
	case b >= '0' && b <= '9':
		return true
	case b == '_':
		return true
	}
	return false
}

// normalizeVector mirrors normalizeVector: unit length unless the magnitude is
// zero or not finite, in which case the input is returned unchanged.
func normalizeVector(vector []float64) []float64 {
	var magnitude float64
	for _, value := range vector {
		magnitude += value * value
	}
	magnitude = math.Sqrt(magnitude)
	if math.IsNaN(magnitude) || math.IsInf(magnitude, 0) || magnitude == 0 {
		return vector
	}
	out := make([]float64, len(vector))
	for index, value := range vector {
		out[index] = value / magnitude
	}
	return out
}

// dot mirrors the truncated dot product: it walks the shorter vector.
func dot(left, right []float64) float64 {
	limit := len(left)
	if len(right) < limit {
		limit = len(right)
	}
	var total float64
	for index := 0; index < limit; index++ {
		total += left[index] * right[index]
	}
	return total
}

// clamp01 mirrors clamp01.
func clamp01(value float64) float64 {
	return math.Max(0, math.Min(1, value))
}

// roundScore mirrors roundScore: three decimals, JavaScript Math.round
// semantics (half away from zero for positive values).
func roundScore(value float64) float64 {
	return math.Round(value*1000) / 1000
}

// chunkCandidates splits candidates into chunks of at most size elements.
func chunkCandidates(candidates []monitorCandidate, size int) [][]monitorCandidate {
	if size <= 0 {
		return [][]monitorCandidate{candidates}
	}
	chunks := make([][]monitorCandidate, 0, (len(candidates)+size-1)/size)
	for index := 0; index < len(candidates); index += size {
		end := index + size
		if end > len(candidates) {
			end = len(candidates)
		}
		chunks = append(chunks, candidates[index:end])
	}
	return chunks
}

// dedupeStrings mirrors Array.from(new Set(values)).
func dedupeStrings(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// nestISOTime renders a JavaScript Date.toISOString() equivalent: UTC, always
// three fractional digits and a trailing Z.
func nestISOTime(milliseconds float64) string {
	return nestISOTimeFromMillis(int64(math.Trunc(milliseconds)))
}

// nestISOTimeFromMillis renders a millisecond epoch as Date.toISOString().
func nestISOTimeFromMillis(milliseconds int64) string {
	return time.UnixMilli(milliseconds).UTC().Format("2006-01-02T15:04:05.000Z")
}

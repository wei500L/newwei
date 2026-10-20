package crawlmaintenance

import (
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"
)

// jsISOFormat is Date.prototype.toISOString(): UTC, three millisecond digits
// and a trailing Z. Every maintenance write that stores a timestamp string
// (activity hash, adaptive state, tick gate, TaskLog data) uses it.
const jsISOFormat = "2006-01-02T15:04:05.000Z"

// formatISO renders a time the way toISOString does.
func formatISO(value time.Time) string {
	return value.UTC().Format(jsISOFormat)
}

// parseISO parses the ISO strings NestJS writes. Date.parse accepts more than
// RFC3339, but every value this package reads was produced by toISOString.
func parseISO(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// jsRound is Math.round for the non-negative values used by the schedule and
// backoff math: floor(x + 0.5). It deliberately avoids math.Round so the tie
// behaviour matches JavaScript instead of Go's half-away-from-zero wording.
func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	return math.Floor(value + 0.5)
}

// jsToFixed is Number.prototype.toFixed for the non-negative ratios this batch
// formats. ECMAScript picks the integer n for which n/10^digits - x is closest
// to zero and, on an exact tie, picks the LARGER n; the computation runs on the
// exact binary value with big.Rat so a genuine tie such as 12.25 becomes "12.3"
// (strconv.FormatFloat would round half to even and produce "12.2"). Negative
// inputs never reach this helper (error rate and memory headroom are in
// [0, 100]), so the V8-versus-spec divergence for negative ties does not apply.
func jsToFixed(value float64, digits int) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 0) {
		if value < 0 {
			return "-Infinity"
		}
		return "Infinity"
	}
	if digits < 0 {
		digits = 0
	}
	if digits > 100 {
		digits = 100
	}
	exact := new(big.Rat).SetFloat64(value)
	if exact == nil {
		return "0"
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	exact.Mul(exact, new(big.Rat).SetInt(scale))
	exact.Add(exact, big.NewRat(1, 2))
	// big.Int.Div is Euclidean division; with a positive denominator it floors,
	// which is the "pick the larger n" rule for both signs.
	rounded := new(big.Int).Div(exact.Num(), exact.Denom())

	negative := rounded.Sign() < 0 || (rounded.Sign() == 0 && value < 0)
	digitsText := new(big.Int).Abs(rounded).String()
	if digits == 0 {
		if negative {
			return "-" + digitsText
		}
		return digitsText
	}
	for len(digitsText) <= digits {
		digitsText = "0" + digitsText
	}
	cut := len(digitsText) - digits
	out := digitsText[:cut] + "." + digitsText[cut:]
	if negative {
		out = "-" + out
	}
	return out
}

// jsNumberString is String(number) for the finite values interpolated into the
// adaptive reason text.
func jsNumberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 0) {
		if value < 0 {
			return "-Infinity"
		}
		return "Infinity"
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// localeCompare orders ids the way String.prototype.localeCompare does for
// crawl ids. Go mints "c" + lowercase hex and NestJS mints cuid v1, so every id
// is restricted to [0-9a-z]. For that alphabet the ICU default collation (no
// numeric option, no punctuation) orders digits before letters and both groups
// ascending, which is exactly byte order; strings.Compare therefore matches
// localeCompare for these ids without a collator.
func localeCompare(left, right string) int {
	return strings.Compare(left, right)
}

// sortByTimeThenID is the shared "ascending timestamp, then localeCompare(id)"
// ordering used by the janitor merge and the cleanup outbox merge. It is stable
// and keeps first-seen order for equal keys.
func sortByTimeThenID[T any](items []T, timeOf func(T) time.Time, idOf func(T) string) {
	sort.SliceStable(items, func(i, j int) bool {
		left, right := timeOf(items[i]), timeOf(items[j])
		if !left.Equal(right) {
			return left.Before(right)
		}
		return localeCompare(idOf(items[i]), idOf(items[j])) < 0
	})
}

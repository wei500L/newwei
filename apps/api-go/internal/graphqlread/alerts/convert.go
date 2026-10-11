package alerts

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	opGT             = "gt"
	opGTE            = "gte"
	opLT             = "lt"
	opLTE            = "lte"
	opOutsideRange   = "outside_range"
	opChangeUpPct    = "change_up_pct"
	opChangeDownPct  = "change_down_pct"
	actionNone       = "none"
	actionIncrease   = "increase_threshold"
	actionDecrease   = "decrease_threshold"
	actionAdjust     = "adjust_range"
	providerEconomic = "economic_data"
	providerAnomaly  = "economic_anomaly"
	channelInApp     = "in_app"
	statusConfirmed  = "confirmed"
	statusIgnored    = "ignored"

	notEnoughReviewedMessage = "Not enough reviewed alerts yet. Confirm/Ignore a few events to generate tuning suggestions."
	dayMillis                = int64(24 * 60 * 60 * 1000)
)

// metricSlugAliases matches normalizeRealtimeSignalMetricSlug. Identity keys
// are kept so a stored alias and its canonical slug normalize the same way.
var metricSlugAliases = map[string]string{
	"realtime.opensky.military_flights": "realtime.opensky.military_flights",
	"realtime.adsb.military_flights":    "realtime.opensky.military_flights",
	"realtime.opensky.snapshot_health":  "realtime.opensky.snapshot_health",
	"realtime.adsb.snapshot_health":     "realtime.opensky.snapshot_health",
}

func normalizeMetricSlug(value string) string {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return ""
	}
	if canonical, ok := metricSlugAliases[trimmed]; ok {
		return canonical
	}
	return trimmed
}

func optionalMetricSlug(value string) *string {
	normalized := normalizeMetricSlug(value)
	if normalized == "" {
		return nil
	}
	return stringPtr(normalized)
}

func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

// isJSSpace matches String.prototype.trim: ASCII whitespace, U+FEFF, and Zs.
// It does not treat U+0085 as space.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

func stringPtr(value string) *string {
	return &value
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return stringPtr(value.String)
}

func utcTime(value time.Time) time.Time {
	return value.UTC()
}

func nullTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	stamp := value.Time.UTC()
	return &stamp
}

func truncateMillis(value time.Time) time.Time {
	return time.UnixMilli(value.UTC().UnixMilli()).UTC()
}

func nullWindow(value sql.NullInt64) *float64 {
	if !value.Valid {
		return nil
	}
	number := float64(value.Int64)
	return &number
}

func nullFloatPtr(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return contract.OptFloat(value.Float64)
}

func optDecimal(value sql.NullString) *float64 {
	if !value.Valid {
		return nil
	}
	return contract.OptFloat(value.String)
}

func reqDecimal(value sql.NullString) float64 {
	parsed, ok := finiteDecimal(value)
	if !ok {
		return 0
	}
	return parsed
}

func finiteDecimal(value sql.NullString) (float64, bool) {
	if !value.Valid {
		return 0, false
	}
	return contract.FiniteFloat(value.String)
}

func decodeJSON(raw []byte) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, errors.New("alerts: invalid json column")
	}
	return value, nil
}

func asObject(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

func clamp(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func boundedIntArg(args map[string]any, name string, fallback, low, high int) int {
	number := fallback
	value, state := contract.Lookup(args, name)
	if state == contract.ArgValue {
		parsed, ok := contract.AsInt(value)
		if ok {
			number = parsed
		}
	}
	return clamp(number, low, high)
}

func requiredStringArg(args map[string]any, name string) (string, error) {
	value, state := contract.Lookup(args, name)
	if state != contract.ArgValue {
		return "", fmt.Errorf("alerts: %s is required", name)
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("alerts: %s is required", name)
	}
	return text, nil
}

func metricSlugArg(args map[string]any) string {
	value, ok := contract.StringArg(args, "metricSlug")
	if !ok {
		return ""
	}
	return normalizeMetricSlug(value)
}

func requireDB(db *sql.DB) error {
	if db == nil {
		return errors.New("alerts: database is not configured")
	}
	return nil
}

func queryErr(op string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("alerts: %s: %w", op, err)
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	var builder strings.Builder
	builder.Grow(count * 2)
	for i := 0; i < count; i++ {
		if i > 0 {
			builder.WriteByte(',')
		}
		builder.WriteByte('?')
	}
	return builder.String()
}

// quantile is the linear interpolation from alerts-tuning.ts.
func quantile(values []float64, q float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	if q < 0 {
		q = 0
	} else if q > 1 {
		q = 1
	}
	sorted := append([]float64(nil), values...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})
	position := float64(len(sorted)-1) * q
	base := int(math.Floor(position))
	rest := position - float64(base)
	if base < 0 || base >= len(sorted) {
		return nil
	}
	current := sorted[base]
	if base+1 >= len(sorted) {
		return &current
	}
	next := sorted[base+1]
	result := current + rest*(next-current)
	return &result
}

func safeMean(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sum := 0.0
	for _, value := range values {
		sum += value
	}
	mean := sum / float64(len(values))
	return &mean
}

func meanText(values []float64) string {
	mean := safeMean(values)
	if mean == nil {
		return "n/a"
	}
	return formatFixed(*mean, 4)
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func minFloat(values []float64) float64 {
	min := values[0]
	for _, value := range values[1:] {
		if value < min {
			min = value
		}
	}
	return min
}

func maxFloat(values []float64) float64 {
	max := values[0]
	for _, value := range values[1:] {
		if value > max {
			max = value
		}
	}
	return max
}

// formatJSNumber matches Number's default stringification for message text.
func formatJSNumber(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == 0:
		return "0"
	}
	negative := value < 0
	abs := math.Abs(value)
	raw := strconv.FormatFloat(abs, 'e', -1, 64)
	mant, expStr, ok := strings.Cut(raw, "e")
	if !ok {
		return signed(negative, raw)
	}
	exp, err := strconv.Atoi(expStr)
	if err != nil {
		return signed(negative, strconv.FormatFloat(abs, 'f', -1, 64))
	}
	digits := strings.ReplaceAll(mant, ".", "")
	if digits == "" {
		return signed(negative, raw)
	}
	k := len(digits)
	n := exp + 1
	var body string
	switch {
	case k <= n && n <= 21:
		body = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		body = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		body = "0." + strings.Repeat("0", -n) + digits
	default:
		expSign := "+"
		absExp := exp
		if exp < 0 {
			expSign = "-"
			absExp = -exp
		}
		frac := ""
		if len(digits) > 1 {
			frac = "." + digits[1:]
		}
		body = digits[:1] + frac + "e" + expSign + strconv.Itoa(absExp)
	}
	return signed(negative, body)
}

func signed(negative bool, body string) string {
	if negative {
		return "-" + body
	}
	return body
}

// formatFixed matches Number.prototype.toFixed for finite values: half away
// from zero on the exact float64, and the original sign is kept when the
// rounded magnitude is zero.
func formatFixed(value float64, digits int) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	}
	if digits < 0 {
		digits = 0
	}
	negative := value < 0
	abs := value
	if negative {
		abs = -value
	}
	if abs >= 1e21 {
		return formatJSNumber(value)
	}
	rat := new(big.Rat).SetFloat64(abs)
	if rat == nil {
		return "NaN"
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	num := new(big.Int).Mul(new(big.Int).Set(rat.Num()), scale)
	quo := new(big.Int)
	rem := new(big.Int)
	quo.QuoRem(num, rat.Denom(), rem)
	twice := new(big.Int).Lsh(rem, 1)
	if twice.Cmp(rat.Denom()) >= 0 {
		quo.Add(quo, big.NewInt(1))
	}
	text := quo.String()
	if digits == 0 {
		return signed(negative, text)
	}
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	point := len(text) - digits
	return signed(negative, text[:point]+"."+text[point:])
}

func thresholdText(suggested *float64, current float64) string {
	if suggested == nil {
		return formatJSNumber(current)
	}
	return formatFixed(*suggested, 4)
}

func windowStart(days int) time.Time {
	now := time.Now().UTC()
	return time.UnixMilli(now.UnixMilli() - int64(days)*dayMillis).UTC()
}

func windowBounds(center time.Time, days int) (time.Time, time.Time) {
	center = truncateMillis(center)
	delta := int64(days) * dayMillis
	start := time.UnixMilli(center.UnixMilli() - delta).UTC()
	end := time.UnixMilli(center.UnixMilli() + delta).UTC()
	return start, end
}

func parseJSDate(value string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return truncateMillis(parsed), true
		}
	}
	return time.Time{}, false
}

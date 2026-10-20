package alertworker

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/jsnum"
)

// normalizeMetricSlug mirrors AlertsService's
// `normalizeRealtimeSignalMetricSlug`: trim, then map the four alias slugs. The
// identity entries are kept so an already canonical slug normalises to itself,
// exactly like REALTIME_SIGNAL_METRIC_SLUG_ALIASES.
var metricSlugAliases = map[string]string{
	"realtime.opensky.military_flights": "realtime.opensky.military_flights",
	"realtime.adsb.military_flights":    "realtime.opensky.military_flights",
	"realtime.opensky.snapshot_health":  "realtime.opensky.snapshot_health",
	"realtime.adsb.snapshot_health":     "realtime.opensky.snapshot_health",
}

func normalizeMetricSlug(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if canonical, ok := metricSlugAliases[trimmed]; ok {
		return canonical
	}
	return trimmed
}

// formatDecimal renders a number the way Prisma.Decimal(number) renders it: the
// JavaScript Number.toString of the value, which is the same string
// jsnum.Format produces.
func formatDecimal(value float64) string {
	return jsnum.Format(value)
}

// parseDecimalString reads a DECIMAL(38,12) column into the same double
// `Number(decimal)` produces. The MySQL driver hands DECIMAL back as text.
func parseDecimalString(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// randomRowID generates a Prisma-cuid-shaped identifier: a leading "c" followed
// by 24 hex characters. Prisma ids are opaque strings, so only uniqueness and
// the column width matter.
func randomRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// ensureTraceID mirrors @modular/utils ensureTraceId: keep the hexadecimal part
// of the incoming id when it is at least 16 characters long (truncated to 32),
// otherwise generate 16 random bytes.
func ensureTraceID(incoming string) string {
	var builder strings.Builder
	for _, r := range incoming {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F':
			builder.WriteRune(r)
		}
	}
	normalized := builder.String()
	if len(normalized) >= 16 {
		if len(normalized) > 32 {
			return normalized[:32]
		}
		return normalized
	}
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(buffer[:])
}

// clampSeconds mirrors the clampSeconds helper: Math.trunc, at least 1 and at
// most 365 days.
func clampSeconds(value float64) int64 {
	const maxSeconds = 365 * 24 * 3600
	if !isFinite(value) {
		return 1
	}
	// Math.trunc for values inside the int64 range; the bounds are applied
	// before the conversion so a huge double cannot overflow it.
	if value >= maxSeconds {
		return maxSeconds
	}
	if value <= 1 {
		return 1
	}
	normalized := int64(value)
	if normalized < 1 {
		return 1
	}
	if normalized > maxSeconds {
		return maxSeconds
	}
	return normalized
}

// maxInt returns the larger value.
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

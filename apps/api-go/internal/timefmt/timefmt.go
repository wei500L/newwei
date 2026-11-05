// Package timefmt holds the single implementation of the timestamp formats the
// REST and GraphQL surfaces expose.
package timefmt

import "time"

// jsISOLayout is JavaScript Date.prototype.toISOString: UTC, exactly three
// millisecond digits, ending in "Z".
const jsISOLayout = "2006-01-02T15:04:05.000Z"

// FormatDateTime renders value like JavaScript Date.prototype.toISOString:
// UTC with exactly three fractional (millisecond) digits. It is the single
// implementation behind graphqlread/contract.FormatDateTime and the per-package
// isoTime/formatISO helpers that used the identical layout.
func FormatDateTime(value time.Time) string {
	return value.UTC().Format(jsISOLayout)
}

// NowMillis returns the current time in UTC truncated to milliseconds. It is
// the value written to MySQL DATETIME(3) columns, so the truncation matches the
// stored precision and keeps Go and NestJS writes byte-identical.
func NowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// NowUnixMilli returns Unix milliseconds for the current instant. It is the
// int64 variant used by callers that pass millisecond integers around (job
// payloads, queue semantics) rather than time.Time values.
func NowUnixMilli() int64 {
	return time.Now().UnixMilli()
}

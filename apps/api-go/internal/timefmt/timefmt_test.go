package timefmt

import (
	"testing"
	"time"
)

// TestFormatDateTime pins JavaScript Date.prototype.toISOString semantics: UTC,
// exactly three millisecond digits, trailing Z. The second case proves
// sub-millisecond precision is truncated, not rounded.
func TestFormatDateTime(t *testing.T) {
	cases := []struct {
		in   time.Time
		want string
	}{
		{time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC), "2026-01-02T03:04:05.006Z"},
		{time.Date(2026, 1, 2, 3, 4, 5, 123_999_999, time.UTC), "2026-01-02T03:04:05.123Z"},
		{time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("x", 3*3600)), "2026-01-02T00:04:05.000Z"},
	}
	for _, tc := range cases {
		if got := FormatDateTime(tc.in); got != tc.want {
			t.Errorf("FormatDateTime(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestNowMillis proves the truncation to millisecond precision and the UTC
// location that DATETIME(3) writes rely on.
func TestNowMillis(t *testing.T) {
	got := NowMillis()
	if got.Location() != time.UTC {
		t.Fatalf("location = %v, want UTC", got.Location())
	}
	if got.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("nanos = %d, want millisecond precision", got.Nanosecond())
	}
}

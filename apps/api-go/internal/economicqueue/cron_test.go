package economicqueue

import (
	"testing"
	"time"
)

func TestNextEveryAlignsToEpoch(t *testing.T) {
	now := time.UnixMilli(30_000)
	next, ok := NextEveryMillis(30_000, now)
	if !ok || next != 60_000 {
		t.Fatalf("next = %d ok=%t", next, ok)
	}
}

func TestNextPatternSecondResolution(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.Local)
	next, ok := NextPatternMillis("29,59 * * * * *", now, nil)
	if !ok {
		t.Fatal("realtime pattern did not parse")
	}
	if got := time.UnixMilli(next); got.Second() != 29 {
		t.Fatalf("next = %s", got)
	}
}

func TestNextPatternMonthly(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.Local)
	next, ok := NextPatternMillis("0 0 1 * *", now, nil)
	if !ok {
		t.Fatal("monthly pattern did not parse")
	}
	got := time.UnixMilli(next)
	if got.Month() != time.November || got.Day() != 1 || got.Hour() != 0 {
		t.Fatalf("next = %s", got)
	}
}

func TestInvalidCronRejected(t *testing.T) {
	if _, ok := NextPatternMillis("not a cron", time.Now(), nil); ok {
		t.Fatal("invalid cron parsed")
	}
}

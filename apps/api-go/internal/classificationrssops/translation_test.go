package classificationrssops

import (
	"testing"
	"time"
)

// TestResolveTranslationWindowDefaults pins the 14-day default window.
func TestResolveTranslationWindowDefaults(t *testing.T) {
	now := time.Date(2026, 10, 17, 9, 30, 0, 0, time.UTC)
	from, to, err := resolveTranslationWindow(nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC); !from.Equal(want) {
		t.Fatalf("from = %s, want %s", from, want)
	}
	if want := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC); !to.Equal(want) {
		t.Fatalf("to = %s, want %s", to, want)
	}
	if formatUTCDate(from) != "2026-10-04" || formatUTCDate(to) != "2026-10-17" {
		t.Fatalf("formatted window = %s..%s", formatUTCDate(from), formatUTCDate(to))
	}
}

// TestResolveTranslationWindowInvalidDate pins the exact 400 message.
func TestResolveTranslationWindowInvalidDate(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	for _, raw := range []string{"2026-13-01", "17/10/2026", "2026-10-32", "yesterday"} {
		_, _, err := resolveTranslationWindow(strPtr(raw), nil, now)
		status, message, ok := statusOf(err)
		if !ok || status != 400 {
			t.Fatalf("date %q error = %v", raw, err)
		}
		if message != "Invalid date '"+raw+"', expected YYYY-MM-DD" {
			t.Fatalf("date %q message = %q", raw, message)
		}
	}
}

// TestResolveTranslationWindowOrdering pins the from > to rejection.
func TestResolveTranslationWindowOrdering(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	_, _, err := resolveTranslationWindow(strPtr("2026-10-10"), strPtr("2026-10-01"), now)
	status, message, ok := statusOf(err)
	if !ok || status != 400 || message != "'from' must be earlier than or equal to 'to'" {
		t.Fatalf("ordering error = %v", err)
	}
	// The same day is a valid one-day window.
	from, to, err := resolveTranslationWindow(strPtr("2026-10-17"), strPtr("2026-10-17"), now)
	if err != nil || !from.Equal(to) {
		t.Fatalf("same-day window = %s..%s (%v)", from, to, err)
	}
}

// TestResolveTranslationWindowSpan pins the 180-day cap boundary.
func TestResolveTranslationWindowSpan(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	// 180 days inclusive: 2026-04-21 .. 2026-10-17.
	if _, _, err := resolveTranslationWindow(strPtr("2026-04-21"), strPtr("2026-10-17"), now); err != nil {
		t.Fatalf("180-day window must be accepted: %v", err)
	}
	// 181 days: one day earlier.
	_, _, err := resolveTranslationWindow(strPtr("2026-04-20"), strPtr("2026-10-17"), now)
	status, message, ok := statusOf(err)
	if !ok || status != 400 || message != "Date range exceeds 180 days" {
		t.Fatalf("181-day window error = %v", err)
	}
}

// TestIsMissingTableError pins the migration-not-run fallback classification.
func TestIsMissingTableError(t *testing.T) {
	if isMissingTableError(nil) {
		t.Fatalf("nil error must not be a missing table")
	}
	if isMissingTableError(newStatus(400, "bad request")) {
		t.Fatalf("status errors must not be classified as a missing table")
	}
}

package newssourcescheduler

import (
	"testing"
	"time"
)

func cronTestLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("time.LoadLocation(%q): %v", name, err)
	}
	return loc
}

func cronTestExpression(t *testing.T, expr string, loc *time.Location) *cronExpression {
	t.Helper()
	parsed, err := parseCronExpression(expr, loc)
	if err != nil {
		t.Fatalf("parseCronExpression(%q): %v", expr, err)
	}
	return parsed
}

func TestCronExpressionNext(t *testing.T) {
	utc := time.UTC
	newYork := cronTestLocation(t, "America/New_York")
	moscow := cronTestLocation(t, "Europe/Moscow")

	tests := []struct {
		name  string
		expr  string
		loc   *time.Location
		after time.Time
		want  time.Time
	}{
		{
			name:  "every minute uses zero seconds",
			expr:  "* * * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 13, 30, 12, 0, utc),
			want:  time.Date(2026, 10, 20, 13, 31, 0, 0, utc),
		},
		{
			name:  "step minutes skip to the next slot",
			expr:  "*/15 * * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 13, 31, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 13, 45, 0, 0, utc),
		},
		{
			name:  "weekday names restrict to the range",
			expr:  "0 9 * * MON-FRI",
			loc:   utc,
			after: time.Date(2026, 10, 23, 9, 30, 0, 0, utc), // Friday
			want:  time.Date(2026, 10, 26, 9, 0, 0, 0, utc),  // Monday
		},
		{
			name:  "six fields add seconds",
			expr:  "*/10 * * * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 13, 30, 5, 0, utc),
			want:  time.Date(2026, 10, 20, 13, 30, 10, 0, utc),
		},
		{
			name:  "six fields with fixed time",
			expr:  "0 30 2 * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 2, 30, 0, 0, utc),
		},
		{
			name:  "month name",
			expr:  "0 0 1 JAN *",
			loc:   utc,
			after: time.Date(2026, 6, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2027, 1, 1, 0, 0, 0, 0, utc),
		},
		{
			name:  "lowercase day name",
			expr:  "30 6 * * sun",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc), // Tuesday
			want:  time.Date(2026, 10, 25, 6, 30, 0, 0, utc),
		},
		{
			name:  "day-of-month or day-of-week",
			expr:  "0 0 13 * 5",
			loc:   utc,
			after: time.Date(2026, 10, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 2, 0, 0, 0, 0, utc), // Friday before the 13th
		},
		{
			name:  "step-of-one day-of-month is a wildcard",
			expr:  "0 0 */1 * 1",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc), // Tuesday
			want:  time.Date(2026, 10, 26, 0, 0, 0, 0, utc), // Monday only
		},
		{
			name:  "question mark in day-of-month",
			expr:  "0 0 ? * 1",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 26, 0, 0, 0, 0, utc),
		},
		{
			name:  "dow zero is Sunday",
			expr:  "0 0 * * 0",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 25, 0, 0, 0, 0, utc),
		},
		{
			name:  "dow seven is Sunday",
			expr:  "0 0 * * 7",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 25, 0, 0, 0, 0, utc),
		},
		{
			name:  "dow range ending at seven includes Sunday",
			expr:  "0 0 * * 5-7",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc), // Tuesday
			want:  time.Date(2026, 10, 23, 0, 0, 0, 0, utc), // Friday
		},
		{
			name:  "last day of a non leap February",
			expr:  "0 0 L * *",
			loc:   utc,
			after: time.Date(2026, 2, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 2, 28, 0, 0, 0, 0, utc),
		},
		{
			name:  "last day of a leap February",
			expr:  "0 0 L * *",
			loc:   utc,
			after: time.Date(2028, 2, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2028, 2, 29, 0, 0, 0, 0, utc),
		},
		{
			name:  "last Friday of October",
			expr:  "0 0 * * 5L",
			loc:   utc,
			after: time.Date(2026, 10, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 30, 0, 0, 0, 0, utc),
		},
		{
			name:  "last Friday of November",
			expr:  "0 0 * * 5L",
			loc:   utc,
			after: time.Date(2026, 11, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 11, 27, 0, 0, 0, 0, utc),
		},
		{
			name:  "third Friday of October",
			expr:  "0 0 * * 5#3",
			loc:   utc,
			after: time.Date(2026, 10, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 16, 0, 0, 0, 0, utc),
		},
		{
			name:  "range with step",
			expr:  "10-20/5 * * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 13, 9, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 13, 10, 0, 0, utc),
		},
		{
			name:  "range with step second slot",
			expr:  "10-20/5 * * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 13, 10, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 13, 15, 0, 0, utc),
		},
		{
			name:  "value with step runs to the field maximum",
			expr:  "50/10 * * * *",
			loc:   utc,
			after: time.Date(2026, 10, 20, 13, 51, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 14, 50, 0, 0, utc),
		},
		{
			name:  "moscow local time",
			expr:  "0 9 * * *",
			loc:   moscow,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 6, 0, 0, 0, utc),
		},
		{
			name:  "new york local time",
			expr:  "0 9 * * *",
			loc:   newYork,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 10, 20, 13, 0, 0, 0, utc),
		},
		{
			// 2026-03-08 02:30 does not exist in New York. Luxon, which
			// cron-parser uses, shifts the wall time forward by the gap, so the
			// occurrence is 03:30 EDT.
			name:  "spring forward shifts by the gap",
			expr:  "30 2 * * *",
			loc:   newYork,
			after: time.Date(2026, 3, 7, 12, 0, 0, 0, utc),
			want:  time.Date(2026, 3, 8, 7, 30, 0, 0, utc),
		},
		{
			// 2026-11-01 01:30 happens twice; the pre-transition (EDT) instant
			// wins, like Luxon's ambiguity resolution.
			name:  "fall back keeps the earlier offset",
			expr:  "30 1 * * *",
			loc:   newYork,
			after: time.Date(2026, 11, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2026, 11, 1, 5, 30, 0, 0, utc),
		},
		{
			name:  "single field maps to day-of-week",
			expr:  "5",
			loc:   utc,
			after: time.Date(2026, 10, 20, 0, 0, 0, 0, utc), // Tuesday
			want:  time.Date(2026, 10, 23, 0, 0, 0, 0, utc), // Friday
		},
		{
			name:  "wide leap day gap stays resolvable",
			expr:  "0 0 29 2 *",
			loc:   utc,
			after: time.Date(2097, 1, 1, 0, 0, 0, 0, utc),
			want:  time.Date(2104, 2, 29, 0, 0, 0, 0, utc),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			expression := cronTestExpression(t, test.expr, test.loc)
			got, err := expression.Next(test.after)
			if err != nil {
				t.Fatalf("Next(%s): %v", test.after.Format(time.RFC3339), err)
			}
			if !got.Equal(test.want) {
				t.Fatalf("Next(%s) = %s, want %s", test.after.Format(time.RFC3339),
					got.UTC().Format(time.RFC3339), test.want.UTC().Format(time.RFC3339))
			}
		})
	}
}

func TestCronExpressionRejectsUnsupportedSyntax(t *testing.T) {
	expressions := []string{
		"* * * * * * *",   // seven fields
		"0 0 * * 8",       // day-of-week out of range
		"0 0 * * 5W",      // Quartz nearest-weekday
		"0 0 L-3 * *",     // Quartz last-day offset
		"0 0 LW * *",      // Quartz last weekday
		"*/0 * * * *",     // zero step
		"@annually",       // not a cron-parser 4.9.0 alias
		"@midnight",       // not a cron-parser 4.9.0 alias
		"0 0 * * L",       // bare L in day-of-week throws when evaluated
		"0 0 * * 5#6",     // occurrence number out of range
		"0 0 * * 5#3,1",   // '#' cannot combine with ','
		"0 0 * * 5#3/2",   // '#' cannot combine with '/'
		"0 0 * * 5#3-1",   // '#' cannot combine with '-'
		"abc * * * *",     // not a resolvable value
		"-5 * * * *",      // invalid range start
		"0 0 32 * *",      // day-of-month out of range
		"0 0 * 13 *",      // month out of range
		"0 0 * FOO *",     // unknown month alias
		"0 0 ? * * extra", // '?' is fine but the field count is not
		"0 0 1,,2 * *",    // empty list item
	}

	for _, expression := range expressions {
		t.Run(expression, func(t *testing.T) {
			if _, err := parseCronExpression(expression, time.UTC); err == nil {
				t.Fatalf("parseCronExpression(%q) succeeded, want an error", expression)
			}
		})
	}
}

func TestCronExpressionAcceptsAliases(t *testing.T) {
	aliases := []string{"@yearly", "@monthly", "@weekly", "@daily", "@hourly"}
	for _, alias := range aliases {
		t.Run(alias, func(t *testing.T) {
			if _, err := parseCronExpression(alias, time.UTC); err != nil {
				t.Fatalf("parseCronExpression(%q): %v", alias, err)
			}
		})
	}
}

func TestCronExpressionNextErrorsForImpossibleExpression(t *testing.T) {
	expression := cronTestExpression(t, "0 0 30 2 *", time.UTC)
	if _, err := expression.Next(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("Next(impossible) succeeded, want an error")
	}
}

func TestCronExpressionNextIsRepeatable(t *testing.T) {
	expression := cronTestExpression(t, "0 0 * * *", time.UTC)
	first, err := expression.Next(time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}
	second, err := expression.Next(first)
	if err != nil {
		t.Fatalf("second Next: %v", err)
	}
	if !second.Equal(first.AddDate(0, 0, 1)) {
		t.Fatalf("second Next = %s, want %s", second, first.AddDate(0, 0, 1))
	}
}

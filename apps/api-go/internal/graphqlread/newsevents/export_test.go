package newsevents

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestDedupeExportEventsMatchesReference verifies the token-index dedupe against
// the source greedy loop (dedupeEvents) on fixed data. Both functions must keep
// exactly the same id sequence, so each case asserts the equivalence directly
// instead of hard-coding an expected list.
func TestDedupeExportEventsMatchesReference(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(offset time.Duration) time.Time { return base.Add(offset) }
	day := 24 * time.Hour

	cases := []struct {
		name     string
		rows     []scoredEvent
		wantKept []string
	}{
		{
			// The time condition is an OR of startAt and lastAt with a
			// <= 5-day boundary: exactly 5 days is close, one millisecond more
			// is not.
			name: "five day boundary",
			rows: []scoredEvent{
				testEvent("a", at(0), at(0), "", "", "tariff ruling trade"),
				testEvent("b", at(5*day), at(5*day), "", "", "tariff ruling trade"),
				testEvent("c", at(5*day+time.Millisecond), at(5*day+time.Millisecond), "", "", "tariff ruling trade"),
			},
			wantKept: []string{"a", "c"},
		},
		{
			// A discarded event must not join the index: b is a duplicate of a
			// (0.75) and c would be a duplicate of b (0.75) but is only 0.5
			// similar to a, so c has to stay.
			name: "discarded event never joins the index",
			rows: []scoredEvent{
				testEvent("a", at(0), at(0), "", "", "alpha beta gamma"),
				testEvent("b", at(0), at(0), "", "", "alpha beta gamma delta"),
				testEvent("c", at(0), at(0), "", "", "beta gamma delta"),
			},
			wantKept: []string{"a", "c"},
		},
		{
			// An empty token set never reaches the Jaccard floor, so events
			// without a usable entity/topic/title are all kept.
			name: "empty token sets",
			rows: []scoredEvent{
				testEvent("a", at(0), at(0), "", "", ""),
				testEvent("b", at(0), at(0), "", "", "   "),
				testEvent("c", at(0), at(0), "", "ab", "  "),
			},
			wantKept: []string{"a", "b", "c"},
		},
		{
			// Repeated tokens collapse into one set entry.
			name: "repeated tokens",
			rows: []scoredEvent{
				testEvent("a", at(0), at(0), "", "", "tariff tariff tariff"),
				testEvent("b", at(0), at(0), "", "", "tariff"),
			},
			wantKept: []string{"a"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := keptIDs(dedupeExportEvents(testCase.rows)); !equalKeptIDs(got, testCase.wantKept) {
				t.Fatalf("kept ids = %v, want %v", got, testCase.wantKept)
			}
			assertSameKeptIDs(t, testCase.rows)
		})
	}
}

// TestDedupeExportEventsMatchesReferenceOnGeneratedData runs the equivalence
// check over a systematic set of token/time combinations so shared and
// non-shared token pairs, repeated tokens and mixed time distances are all
// exercised together. The data is index-derived, so it needs no random source.
func TestDedupeExportEventsMatchesReferenceOnGeneratedData(t *testing.T) {
	alphabet := []string{"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]scoredEvent, 0, 400)
	for index := 0; index < 400; index++ {
		words := []string{
			alphabet[index%len(alphabet)],
			alphabet[(index*3)%len(alphabet)],
			alphabet[(index*7+1)%len(alphabet)],
		}
		if index%4 == 0 {
			words = words[:2]
		}
		start := base.Add(time.Duration(index%10) * 24 * time.Hour)
		last := start.Add(time.Duration(index%3) * time.Hour)
		rows = append(rows, testEvent(strconv.Itoa(index), start, last, "", "", strings.Join(words, " ")))
	}
	assertSameKeptIDs(t, rows)
}

// assertSameKeptIDs compares the kept id sequence of the indexed dedupe with
// the source greedy loop.
func assertSameKeptIDs(t *testing.T, rows []scoredEvent) {
	t.Helper()
	want := keptIDs(dedupeEvents(rows))
	got := keptIDs(dedupeExportEvents(rows))
	if !equalKeptIDs(got, want) {
		t.Fatalf("kept id sequence differs: got %v want %v", got, want)
	}
}

// equalKeptIDs reports whether two id sequences are identical.
func equalKeptIDs(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// keptIDs renders the kept event ids in order.
func keptIDs(rows []scoredEvent) []string {
	out := make([]string, len(rows))
	for index, row := range rows {
		out[index] = row.row.ID
	}
	return out
}

// testEvent builds one scored event with the fields the dedupe reads.
func testEvent(id string, start, last time.Time, entity, topic, title string) scoredEvent {
	row := eventRow{ID: id, StartAt: start, LastAt: last}
	if entity != "" {
		row.PrimaryEntity = exportTestStringPointer(entity)
	}
	if topic != "" {
		row.PrimaryTopic = exportTestStringPointer(topic)
	}
	if title != "" {
		row.Title = exportTestStringPointer(title)
	}
	return scoredEvent{row: row}
}

func exportTestStringPointer(value string) *string {
	return &value
}

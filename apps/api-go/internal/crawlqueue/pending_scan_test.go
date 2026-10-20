package crawlqueue

import "testing"

// TestTaskIDSet covers the set helper used by the pending scan.
func TestTaskIDSet(t *testing.T) {
	set := make(TaskIDSet)
	set.Add("task-1")
	set.Add("task-1")
	set.Add("task-2")
	if set.Len() != 2 {
		t.Fatalf("Len = %d, want 2", set.Len())
	}
	if !set.Has("task-1") || !set.Has("task-2") {
		t.Fatal("Has missed a recorded id")
	}
	if set.Has("task-3") {
		t.Fatal("Has reported an unknown id")
	}
	var nilSet TaskIDSet
	nilSet.Add("ignored")
	if nilSet.Has("ignored") || nilSet.Len() != 0 {
		t.Fatal("a nil set must stay empty")
	}
}

// TestPendingCountsTotal pins the B1 backlog formula.
func TestPendingCountsTotal(t *testing.T) {
	counts := pendingCounts{Wait: 1, Paused: 2, Delayed: 3, Prioritized: 4, Active: 5}
	if got := counts.Total(); got != 15 {
		t.Fatalf("Total = %d, want 15", got)
	}
}

// TestOptionalActivityInt covers toOptionalInt.
func TestOptionalActivityInt(t *testing.T) {
	cases := map[string]int{
		"3":   3,
		" 3 ": 3,
		"0":   0,
		"-4":  0,
		"2.6": 3,
		"2.4": 2,
	}
	for value, want := range cases {
		parsed := optionalActivityInt(value)
		if parsed == nil || *parsed != want {
			t.Errorf("optionalActivityInt(%q) = %v, want %d", value, parsed, want)
		}
	}
	for _, value := range []string{"", "   ", "abc", "NaN", "Inf"} {
		if parsed := optionalActivityInt(value); parsed != nil {
			t.Errorf("optionalActivityInt(%q) = %v, want nil", value, parsed)
		}
	}
}

// TestOptionalActivityString covers toOptionalString.
func TestOptionalActivityString(t *testing.T) {
	parsed := optionalActivityString(" 2026-10-20T15:00:00.000Z ")
	if parsed == nil || *parsed != " 2026-10-20T15:00:00.000Z " {
		t.Fatalf("optionalActivityString kept %v", parsed)
	}
	if parsed := optionalActivityString("  "); parsed != nil {
		t.Fatalf("blank value = %v, want nil", parsed)
	}
}

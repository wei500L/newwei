package crawlfrontierruns

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestNormalizeCancelIDs(t *testing.T) {
	got := normalizeCancelIDs([]string{" running2 ", "running2", "", "failed", " running2 "})
	want := []string{"running2", "failed"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeCancelIDs = %v, want %v", got, want)
	}
	if len(normalizeCancelIDs([]string{"", "   "})) != 0 {
		t.Fatal("blank ids must normalize to an empty list")
	}
}

func TestRunStatusIsCancelable(t *testing.T) {
	cancelable := []RunStatus{RunStatusPending, RunStatusQueued, RunStatusRunning, RunStatusFailed}
	for _, status := range cancelable {
		if !runStatusIsCancelable(status) {
			t.Fatalf("%s must be cancelable", status)
		}
	}
	terminal := []RunStatus{RunStatusCompleted, RunStatusCanceled}
	for _, status := range terminal {
		if runStatusIsCancelable(status) {
			t.Fatalf("%s must be terminal", status)
		}
	}
}

func TestCancelRunsRejectsEmptyIDList(t *testing.T) {
	service := NewService(nil)
	_, err := service.CancelRuns(context.Background(), "org", []string{" ", ""})
	if err == nil || err.Error() != "ids must contain at least one run id" {
		t.Fatalf("error = %v", err)
	}
}

func TestBulkCancelResultMarshalsEmptyArray(t *testing.T) {
	encoded, err := json.Marshal(bulkCancelResult{CanceledIDs: []string{}, CanceledCount: 0})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != `{"canceledIds":[],"canceledCount":0}` {
		t.Fatalf("encoded = %s", encoded)
	}
}

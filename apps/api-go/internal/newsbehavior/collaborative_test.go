package newsbehavior

import (
	"database/sql"
	"testing"
	"time"
)

func TestParseSimilarityNeighbors(t *testing.T) {
	raw := []byte(`[
		{"userId":"u1","similarity":0.8,"sharedSignals":4},
		{"userId":"u2","similarity":0.8,"sharedSignals":2},
		{"userId":"","similarity":0.9,"sharedSignals":4},
		{"userId":"u3","similarity":0,"sharedSignals":4},
		{"userId":"u4","similarity":0.5,"sharedSignals":3}
	]`)
	neighbors := parseSimilarityNeighbors(raw)
	if len(neighbors) != 2 {
		t.Fatalf("neighbors = %+v", neighbors)
	}
	if neighbors[0].UserID != "u4" && neighbors[1].UserID != "u4" {
		t.Fatalf("u4 missing: %+v", neighbors)
	}
	if neighbors[0].Similarity < neighbors[1].Similarity {
		t.Fatalf("order = %+v", neighbors)
	}
	if len(parseSimilarityNeighbors(nil)) != 0 || len(parseSimilarityNeighbors([]byte("not json"))) != 0 {
		t.Fatal("invalid neighbors must be empty")
	}
}

func TestToDecayedScore(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if got := toDecayedScore(0.00005, sql.NullTime{}, now); got != 0 {
		t.Fatalf("epsilon score = %v", got)
	}
	if got := toDecayedScore(2, sql.NullTime{}, now); got != 2 {
		t.Fatalf("missing timestamp = %v", got)
	}
	halfLife := sql.NullTime{Time: now.Add(-90 * 24 * time.Hour), Valid: true}
	if got := toDecayedScore(1, halfLife, now); got != 0.5 {
		t.Fatalf("decayed score = %v", got)
	}
	future := sql.NullTime{Time: now.Add(24 * time.Hour), Valid: true}
	if got := toDecayedScore(1, future, now); got != 1 {
		t.Fatalf("future timestamp must clamp age to zero: %v", got)
	}
}

func TestLimitScoreRecordSortsAndCaps(t *testing.T) {
	values := newTally()
	values.add("a", 1)
	values.add("b", 3)
	values.add("c", 2)
	out := limitScoreRecord(values)
	if len(out) != 3 || out["b"] != 3 || out["a"] != 1 {
		t.Fatalf("record = %+v", out)
	}
}

func TestSignalTypeDimension(t *testing.T) {
	cases := map[string]string{
		signalSource: "sources",
		signalTopic:  "topics",
		signalEntity: "entities",
		signalItem:   "items",
		signalEvent:  "events",
		signalDomain: "domains",
	}
	for signalType, dimension := range cases {
		got, ok := signalTypeDimension(signalType)
		if !ok || got != dimension {
			t.Fatalf("%s = %q %v", signalType, got, ok)
		}
	}
	if _, ok := signalTypeDimension("action"); ok {
		t.Fatal("actions are not a persisted dimension")
	}
}

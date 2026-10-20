package telegramsched

import (
	"context"
	"testing"
)

// TestScriptDigestsPinned fails if a vendored Lua file is edited or partially
// copied, which would silently change the shared BullMQ state machine.
func TestScriptDigestsPinned(t *testing.T) {
	for name, want := range scriptDigests {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if got := scriptSHA256(content); got != want {
			t.Fatalf("%s sha256 = %s, want %s", name, got, want)
		}
	}
	if len(scriptDigests) != 5 {
		t.Fatalf("vendored script count = %d", len(scriptDigests))
	}
}

// TestLegacyRepeatJobIDMatchesBullMQ5632 pins removeRepeatableByKey's legacy
// id: repeat:<md5(name + id + md5(key))>:, with name/id from keyToData(key).
func TestLegacyRepeatJobIDMatchesBullMQ5632(t *testing.T) {
	const hashed = "3c31905331005e8224a380a6428a2d9d"
	if got, want := legacyRepeatJobID(hashed), "repeat:158122096b557dfa1976ea5f657ce7b4:"; got != want {
		t.Fatalf("legacyRepeatJobID(%q) = %q, want %q", hashed, got, want)
	}
	const schedulerKey = "telegram-poll:scheduler"
	if got, want := legacyRepeatJobID(schedulerKey), "repeat:8f57dff24d71d121b1228e7ac65dbf04:"; got != want {
		t.Fatalf("legacyRepeatJobID(%q) = %q, want %q", schedulerKey, got, want)
	}
}

func TestSplitAndRemovalConcatOptions(t *testing.T) {
	name, id := splitRepeatKey("telegram-poll:scheduler")
	if name != "telegram-poll" || id != "scheduler" {
		t.Fatalf("split = %q/%q", name, id)
	}
	if got := removalConcatOptions("telegram-poll:scheduler"); got != "" {
		t.Fatalf("a two-segment key must pass an empty concat form, got %q", got)
	}
	const legacyKey = "telegram-poll:job1:::60000"
	if got := removalConcatOptions(legacyKey); got != legacyKey {
		t.Fatalf("legacy concat = %q", got)
	}
}

func TestQueueKeysMatchBullMQDefaults(t *testing.T) {
	scheduler := New(nil)
	if scheduler.keys.prefix != "bull:situationMonitorSignals:" {
		t.Fatalf("prefix = %q", scheduler.keys.prefix)
	}
	want := map[string]string{
		"repeat":      "bull:situationMonitorSignals:repeat",
		"delayed":     "bull:situationMonitorSignals:delayed",
		"wait":        "bull:situationMonitorSignals:wait",
		"paused":      "bull:situationMonitorSignals:paused",
		"meta":        "bull:situationMonitorSignals:meta",
		"prioritized": "bull:situationMonitorSignals:prioritized",
		"marker":      "bull:situationMonitorSignals:marker",
		"id":          "bull:situationMonitorSignals:id",
		"events":      "bull:situationMonitorSignals:events",
		"pc":          "bull:situationMonitorSignals:pc",
		"active":      "bull:situationMonitorSignals:active",
	}
	got := map[string]string{
		"repeat": scheduler.keys.repeat, "delayed": scheduler.keys.delayed,
		"wait": scheduler.keys.wait, "paused": scheduler.keys.paused,
		"meta": scheduler.keys.meta, "prioritized": scheduler.keys.prioritized,
		"marker": scheduler.keys.marker, "id": scheduler.keys.id,
		"events": scheduler.keys.events, "pc": scheduler.keys.pc,
		"active": scheduler.keys.active,
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %q, want %q", key, got[key], value)
		}
	}
}

func TestSchedulerIdentifiersMatchNestConstants(t *testing.T) {
	if QueueName != "situationMonitorSignals" || PollJobName != "telegram-poll" ||
		PollSchedulerID != "telegram-poll:scheduler" || MinIntervalMillis != 15_000 {
		t.Fatalf("constants = %s %s %s %d", QueueName, PollJobName, PollSchedulerID, MinIntervalMillis)
	}
}

func TestSyncWithoutRedisFails(t *testing.T) {
	scheduler := New(nil)
	if err := scheduler.Sync(context.Background(), true, 60_000); err == nil {
		t.Fatal("expected an error without a Redis client")
	}
}

func TestNegativeCode(t *testing.T) {
	if negativeCode(int64(-11)) != -11 || negativeCode(int(-10)) != -10 || negativeCode("x") != 0 {
		t.Fatal("negativeCode mismatch")
	}
}

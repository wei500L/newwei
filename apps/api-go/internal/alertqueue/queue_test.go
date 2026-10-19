package alertqueue

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"
)

// TestRepeatKeyMatchesBullMQ5632 pins the repeat key, job ids and delay the
// locked BullMQ 5.63.2 implementation derives for an every-based schedule. The
// expected values were computed from
// node_modules/.pnpm/bullmq@5.63.2/.../dist/cjs/classes/repeat.js:
// getRepeatConcatOptions -> name:jobId:endDate:tz:every, md5 hashed; nextMillis
// is the next interval boundary; the first iteration id is
// repeat:<key>:<nextMillis>.
func TestRepeatKeyMatchesBullMQ5632(t *testing.T) {
	const (
		name       = "evaluate-rule:rule1"
		repeatID   = "evaluate-rule1"
		every      = int64(300000)
		fixedNow   = int64(1700000000123)
		wantConcat = "evaluate-rule:rule1:evaluate-rule1:::300000"
		wantKey    = "3c31905331005e8224a380a6428a2d9d"
		wantNext   = int64(1700000100000)
	)
	if got := repeatConcatOptions(name, repeatID, every); got != wantConcat {
		t.Fatalf("repeatConcatOptions = %q, want %q", got, wantConcat)
	}
	if got := hashRepeatKey(wantConcat); got != wantKey {
		t.Fatalf("hashRepeatKey = %q, want %q", got, wantKey)
	}
	if got := nextRepeatMillis(fixedNow, every); got != wantNext {
		t.Fatalf("nextRepeatMillis = %d, want %d", got, wantNext)
	}
	if got := repeatDelayedJobID(wantKey, wantNext); got != "repeat:"+wantKey+":1700000100000" {
		t.Fatalf("repeatDelayedJobID = %q", got)
	}
	if got := wantNext - fixedNow; got != 99877 {
		t.Fatalf("delay = %d, want 99877", got)
	}
}

// TestLegacyRepeatJobIDMatchesBullMQ5632 pins removeRepeatableByKey's legacy
// id: repeat:<md5(name + id + md5(key))>:, with name/id from keyToData(key).
func TestLegacyRepeatJobIDMatchesBullMQ5632(t *testing.T) {
	const repeatKey = "3c31905331005e8224a380a6428a2d9d"
	const want = "repeat:158122096b557dfa1976ea5f657ce7b4:"
	if got := legacyRepeatJobID(repeatKey); got != want {
		t.Fatalf("legacyRepeatJobID = %q, want %q", got, want)
	}
	// A key that still contains the legacy concat form must use its own first
	// two segments for the name/id pair, exactly like keyToData.
	const legacyKey = "evaluate-rule:rule1:::300000"
	name, id := splitRepeatKey(legacyKey)
	if name != "evaluate-rule" || id != "rule1" {
		t.Fatalf("splitRepeatKey = %q/%q", name, id)
	}
	if got := removalConcatOptions(legacyKey); got != legacyKey {
		t.Fatalf("removalConcatOptions(legacy) = %q", got)
	}
	if got := removalConcatOptions(repeatKey); got != "" {
		t.Fatalf("removalConcatOptions(hash) = %q, want empty", got)
	}
}

func TestNextRepeatMillisAlignsToInterval(t *testing.T) {
	cases := []struct{ now, every, want int64 }{
		{0, 60000, 60000},
		{1, 60000, 60000},
		{59999, 60000, 60000},
		{60000, 60000, 120000},
		{1700000000123, 300000, 1700000100000},
	}
	for _, tc := range cases {
		if got := nextRepeatMillis(tc.now, tc.every); got != tc.want {
			t.Errorf("nextRepeatMillis(%d, %d) = %d, want %d", tc.now, tc.every, got, tc.want)
		}
	}
}

func TestEvaluateJobDataJSONKeyOrder(t *testing.T) {
	data, err := json.Marshal(evaluateJobData{Type: "evaluate", RuleID: "rule1", OrgID: "org1", TraceID: "abc123"})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"type":"evaluate","ruleId":"rule1","orgId":"org1","traceId":"abc123"}`
	if string(data) != want {
		t.Fatalf("evaluate data = %s, want %s", data, want)
	}
	schedule, err := json.Marshal(scheduleJobData{Type: "evaluate", RuleID: "rule1", OrgID: "org1"})
	if err != nil {
		t.Fatal(err)
	}
	const wantSchedule = `{"type":"evaluate","ruleId":"rule1","orgId":"org1"}`
	if string(schedule) != wantSchedule {
		t.Fatalf("schedule data = %s, want %s", schedule, wantSchedule)
	}
}

// TestJobArgumentsMsgpackShape verifies the packed argument array Redis
// cmsgpack sees: prefix, id, name, timestamp, then the nil parent slots and the
// repeat job key.
func TestJobArgumentsMsgpackShape(t *testing.T) {
	args := buildJobArguments("bull:alerts:", "evaluate:rule1:1700000000123", "evaluate-rule:rule1", 1700000000123, "")
	encoded, err := marshalMsgpack(args)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []any
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 9 {
		t.Fatalf("decoded args length = %d, want 9", len(decoded))
	}
	if decoded[0] != "bull:alerts:" || decoded[1] != "evaluate:rule1:1700000000123" || decoded[2] != "evaluate-rule:rule1" {
		t.Fatalf("decoded head = %v", decoded[:3])
	}
	if got, ok := toInt64(decoded[3]); !ok || got != 1700000000123 {
		t.Fatalf("decoded timestamp = %v", decoded[3])
	}
	for _, index := range []int{4, 5, 6, 7, 8} {
		if decoded[index] != nil {
			t.Errorf("decoded[%d] = %v, want nil", index, decoded[index])
		}
	}

	args = buildJobArguments("bull:alerts:", "repeat:3c31905331005e8224a380a6428a2d9d:1700000100000",
		"evaluate-rule:rule1", 1700000000123, "3c31905331005e8224a380a6428a2d9d")
	encoded, err = marshalMsgpack(args)
	if err != nil {
		t.Fatal(err)
	}
	decoded = nil
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded[7] != "3c31905331005e8224a380a6428a2d9d" {
		t.Fatalf("decoded repeat job key = %v", decoded[7])
	}
}

// TestJobOptionsMsgpackShape verifies the packed options object, which the Lua
// script decodes with cmsgpack and re-encodes with cjson into the job hash.
func TestJobOptionsMsgpackShape(t *testing.T) {
	opts := map[string]any{
		"attempts":         0,
		"removeOnFail":     failedRetention(),
		"jobId":            "evaluate:rule1:1700000000123",
		"removeOnComplete": true,
	}
	encoded, err := marshalMsgpack(opts)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Attempts         int    `msgpack:"attempts"`
		RemoveOnComplete bool   `msgpack:"removeOnComplete"`
		JobID            string `msgpack:"jobId"`
		RemoveOnFail     struct {
			Age   int64 `msgpack:"age"`
			Count int64 `msgpack:"count"`
		} `msgpack:"removeOnFail"`
	}
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.RemoveOnComplete {
		t.Fatal("removeOnComplete is not true")
	}
	if decoded.JobID != "evaluate:rule1:1700000000123" {
		t.Fatalf("jobId = %q", decoded.JobID)
	}
	if decoded.RemoveOnFail.Age != 604800 {
		t.Fatalf("removeOnFail.age = %d", decoded.RemoveOnFail.Age)
	}
	if decoded.RemoveOnFail.Count != 10000 {
		t.Fatalf("removeOnFail.count = %d", decoded.RemoveOnFail.Count)
	}
	if decoded.Attempts != 0 {
		t.Fatalf("attempts = %d", decoded.Attempts)
	}
}

// TestProducerClockInjection documents the injected clock used by the tests.
func TestProducerClockInjection(t *testing.T) {
	fixed := time.UnixMilli(1700000000123).UTC()
	p := &Producer{now: func() time.Time { return fixed }}
	if got := p.now().UnixMilli(); got != 1700000000123 {
		t.Fatalf("now = %d", got)
	}
}

func toInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int16:
		return int64(typed), true
	case int8:
		return int64(typed), true
	case uint64:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint16:
		return int64(typed), true
	case uint8:
		return int64(typed), true
	default:
		return 0, false
	}
}

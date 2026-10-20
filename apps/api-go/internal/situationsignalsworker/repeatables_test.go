package situationsignalsworker

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestRepeatConcatOptionsMatchesBullMQ(t *testing.T) {
	cases := []struct {
		every      int64
		wantConcat string
		wantRepeat string
	}{
		{
			every:      300_000,
			wantConcat: "oref-poll:oref-poll:repeat:::300000",
			wantRepeat: "6b648cafe515bda8b978dcbd05bdb090",
		},
		{
			every:      60_000,
			wantConcat: "oref-poll:oref-poll:repeat:::60000",
			wantRepeat: "109e85d1f731c8561a4c481b8b51cb66",
		},
	}
	for _, testCase := range cases {
		concat := repeatConcatOptions(OrefPollJobName, orefRepeatJobID, testCase.every)
		if concat != testCase.wantConcat {
			t.Fatalf("concat(%d) = %q, want %q", testCase.every, concat, testCase.wantConcat)
		}
		if got := hashRepeatKey(concat); got != testCase.wantRepeat {
			t.Fatalf("md5(%q) = %q, want %q", concat, got, testCase.wantRepeat)
		}
	}
	if orefRepeatJobID != "oref-poll:repeat" {
		t.Fatalf("orefRepeatJobID = %q", orefRepeatJobID)
	}
	const repeatKey = "6b648cafe515bda8b978dcbd05bdb090"
	const nextMillis = int64(1_700_000_120_000)
	if got, want := repeatDelayedJobID(repeatKey, nextMillis), "repeat:6b648cafe515bda8b978dcbd05bdb090:1700000120000"; got != want {
		t.Fatalf("repeatDelayedJobID = %q, want %q", got, want)
	}
}

func TestNextEveryMillis(t *testing.T) {
	cases := []struct {
		millis int64
		every  int64
		want   int64
	}{
		{1_700_000_000_000, 300_000, 1_700_000_100_000},
		{1_700_000_100_000, 300_000, 1_700_000_400_000},
		{1_700_000_000_001, 60_000, 1_700_000_040_000},
		{1_700_000_000_000, 0, 1_700_000_000_000},
		{1_700_000_000_000, -1, 1_700_000_000_000},
	}
	for _, testCase := range cases {
		if got := nextEveryMillis(testCase.millis, testCase.every); got != testCase.want {
			t.Fatalf("nextEveryMillis(%d, %d) = %d, want %d", testCase.millis, testCase.every, got, testCase.want)
		}
	}
}

func TestNormalizeOrefInterval(t *testing.T) {
	cases := map[int]int{
		-1:        30_000,
		0:         30_000,
		29_999:    30_000,
		30_000:    30_000,
		300_000:   300_000,
		3_600_000: 3_600_000,
	}
	for input, want := range cases {
		if got := normalizeOrefInterval(input); got != want {
			t.Fatalf("normalizeOrefInterval(%d) = %d, want %d", input, got, want)
		}
	}
}

func TestOrefRepeatIterationOptions(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	every := int64(300_000)
	nextMillis := nextEveryMillis(now.UnixMilli(), every)
	repeatKey := hashRepeatKey(repeatConcatOptions(OrefPollJobName, orefRepeatJobID, every))
	jobID := repeatDelayedJobID(repeatKey, nextMillis)

	packed, err := queuePack(orefRepeatIterationOptions(jobID, repeatKey, every, now, nextMillis))
	if err != nil {
		t.Fatalf("pack oref iteration options: %v", err)
	}
	decoded := decodePackedMap(t, packed)

	if decoded["jobId"] != jobID {
		t.Fatalf("jobId = %v, want %q", decoded["jobId"], jobID)
	}
	if decoded["repeatJobKey"] != repeatKey {
		t.Fatalf("repeatJobKey = %v, want %q", decoded["repeatJobKey"], repeatKey)
	}
	if got := packedInt(t, decoded["timestamp"]); got != now.UnixMilli() {
		t.Fatalf("timestamp = %d", got)
	}
	if got := packedInt(t, decoded["prevMillis"]); got != nextMillis {
		t.Fatalf("prevMillis = %d, want %d", got, nextMillis)
	}
	if got := packedInt(t, decoded["delay"]); got != nextMillis-now.UnixMilli() {
		t.Fatalf("delay = %d, want %d", got, nextMillis-now.UnixMilli())
	}
	if got := packedInt(t, decoded["attempts"]); got != defaultJobAttempts {
		t.Fatalf("attempts = %d, want %d (queue defaultJobOptions)", got, defaultJobAttempts)
	}
	backoff, ok := decoded["backoff"].(map[string]any)
	if !ok {
		t.Fatalf("backoff = %T", decoded["backoff"])
	}
	if backoff["type"] != "exponential" || packedInt(t, backoff["delay"]) != defaultBackoffDelayMs {
		t.Fatalf("backoff = %v", backoff)
	}
	if decoded["removeOnComplete"] != true {
		t.Fatalf("removeOnComplete = %v", decoded["removeOnComplete"])
	}
	retention, ok := decoded["removeOnFail"].(map[string]any)
	if !ok {
		t.Fatalf("removeOnFail = %T", decoded["removeOnFail"])
	}
	if packedInt(t, retention["age"]) != failedRetentionAgeSeconds ||
		packedInt(t, retention["count"]) != failedRetentionCount {
		t.Fatalf("removeOnFail = %v", retention)
	}
	repeat, ok := decoded["repeat"].(map[string]any)
	if !ok {
		t.Fatalf("repeat = %T", decoded["repeat"])
	}
	if packedInt(t, repeat["every"]) != every {
		t.Fatalf("repeat.every = %v", repeat["every"])
	}
	if repeat["jobId"] != orefRepeatJobID {
		t.Fatalf("repeat.jobId = %v", repeat["jobId"])
	}
	if got := packedInt(t, repeat["count"]); got != 1 {
		t.Fatalf("repeat.count = %d, want 1", got)
	}
}

func TestBootstrapJobOptions(t *testing.T) {
	decoded := decodePackedMap(t, mustPack(t, bootstrapJobOptions()))
	if got := packedInt(t, decoded["attempts"]); got != defaultJobAttempts {
		t.Fatalf("attempts = %d, want %d", got, defaultJobAttempts)
	}
	backoff, ok := decoded["backoff"].(map[string]any)
	if !ok {
		t.Fatalf("backoff = %T", decoded["backoff"])
	}
	if backoff["type"] != "exponential" || packedInt(t, backoff["delay"]) != defaultBackoffDelayMs {
		t.Fatalf("backoff = %v", backoff)
	}
	if decoded["removeOnComplete"] != true {
		t.Fatalf("removeOnComplete = %v", decoded["removeOnComplete"])
	}
	retention, ok := decoded["removeOnFail"].(map[string]any)
	if !ok {
		t.Fatalf("removeOnFail = %T", decoded["removeOnFail"])
	}
	if packedInt(t, retention["age"]) != failedRetentionAgeSeconds ||
		packedInt(t, retention["count"]) != failedRetentionCount {
		t.Fatalf("removeOnFail = %v", retention)
	}
}

func mustPack(t *testing.T, value any) []byte {
	t.Helper()
	packed, err := queuePack(value)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	return packed
}

func TestQueueJobArguments(t *testing.T) {
	const repeatKey = "6b648cafe515bda8b978dcbd05bdb090"
	packed, err := queueJobArguments("bull:situationMonitorSignals:", "repeat:abc:123", OrefPollJobName, 1_700_000_000_000, repeatKey)
	if err != nil {
		t.Fatalf("pack arguments: %v", err)
	}
	args := decodePackedArray(t, packed)
	if len(args) != 9 {
		t.Fatalf("argument count = %d, want 9", len(args))
	}
	if args[0] != "bull:situationMonitorSignals:" || args[1] != "repeat:abc:123" || args[2] != OrefPollJobName {
		t.Fatalf("arguments = %v", args[:3])
	}
	if got := packedInt(t, args[3]); got != 1_700_000_000_000 {
		t.Fatalf("timestamp = %d", got)
	}
	for index := 4; index <= 6; index++ {
		if args[index] != nil {
			t.Fatalf("argument %d = %v, want nil (no parent jobs)", index, args[index])
		}
	}
	if args[7] != repeatKey {
		t.Fatalf("repeat job key = %v", args[7])
	}
	if args[8] != nil {
		t.Fatalf("deduplication key = %v, want nil", args[8])
	}

	bootstrapArgs, err := queueJobArguments("bull:situationMonitorSignals:", "", OrefPollJobName+":bootstrap", 1, "")
	if err != nil {
		t.Fatalf("pack bootstrap arguments: %v", err)
	}
	bootstrap := decodePackedArray(t, bootstrapArgs)
	if bootstrap[1] != "" || bootstrap[7] != nil {
		t.Fatalf("bootstrap arguments = %v", bootstrap)
	}
}

func TestPollJobDataJSONEncoding(t *testing.T) {
	// NestJS writes JSON.stringify({type:'poll', source}), so the byte order is
	// type then source in every job hash this queue creates.
	cases := map[PollSource]string{
		SourceOref:     `{"type":"poll","source":"oref"}`,
		SourceTelegram: `{"type":"poll","source":"telegram"}`,
	}
	for source, want := range cases {
		encoded, err := json.Marshal(pollJobData{Type: jobTypePoll, Source: source})
		if err != nil {
			t.Fatalf("marshal data: %v", err)
		}
		if string(encoded) != want {
			t.Fatalf("data(%s) = %s, want %s", source, encoded, want)
		}
	}
}

func TestBootstrapJobName(t *testing.T) {
	if got := bootstrapJobName(SourceOref); got != "oref-poll:bootstrap" {
		t.Fatalf("oref bootstrap name = %q", got)
	}
	if got := bootstrapJobName(SourceTelegram); got != "telegram-poll:bootstrap" {
		t.Fatalf("telegram bootstrap name = %q", got)
	}
}

func TestEnsureRepeatablesRequiresRedis(t *testing.T) {
	if err := EnsureRepeatables(context.Background(), nil, RepeatablesConfig{}); err == nil {
		t.Fatal("EnsureRepeatables(nil) must fail")
	}
}

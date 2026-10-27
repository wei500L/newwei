package aisrelay

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// Backpressure tests: the bounded upstream queue, the silent queue reset and the parse
// error accounting of the drain path.
//
// The queue is the boundary between the websocket reader and the aggregation: the
// reader must never block, so an overflow is counted and discarded instead of applying
// backpressure to AISStream.

// backpressureTestConfig builds a configuration for the queue tests. The small hard cap
// keeps the overflow arithmetic obvious, and the batch/budget keep one drain pass cheap.
func backpressureTestConfig(hardCap int) Config {
	return Config{
		UpstreamQueueHardCap: hardCap,
		UpstreamDrainBatch:   hardCap,
		UpstreamDrainBudget:  20 * time.Millisecond,
	}
}

// backpressureTestCounters reads the counters that both the submit path and the drain
// loop write, under the engine mutex so the assertions stay race free while the drain
// goroutine runs.
func backpressureTestCounters(e *engine) (messages, dropped, parseErrors, seen, processed int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.messageCount, e.droppedMessages, e.parseErrors, e.positionReportsSeen, e.positionReportsProcessed
}

// backpressureTestParseErrorState reads the last parse error bookkeeping under the
// engine mutex.
func backpressureTestParseErrorState(e *engine) (int64, *string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastParseErrorAt, e.lastParseErrorMessage
}

// backpressureTestPositionReport renders one payload the aggregation accepts. Every
// caller passes a distinct MMSI so the processed count can be checked against the number
// of submissions.
func backpressureTestPositionReport(mmsi int) []byte {
	return []byte(fmt.Sprintf(
		`{"MessageType":"PositionReport","MetaData":{"MMSI":%d,"ShipName":"SHIP %d","latitude":35.5,"longitude":139.5},"Message":{"PositionReport":{"Latitude":35.5,"Longitude":139.5,"Sog":12.5,"Cog":90,"TrueHeading":90}}}`,
		mmsi, mmsi,
	))
}

// backpressureTestWaitFor polls cond until it holds or the deadline expires. The drain
// loop is asynchronous and exposes no completion signal, so the tests observe the
// counters instead of sleeping for a fixed period.
func backpressureTestWaitFor(t *testing.T, timeout time.Duration, description string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !cond() {
		t.Fatalf("timed out after %v waiting for %s", timeout, description)
	}
}

// TestBackpressureQueueOverflowCounting asserts that a full queue drops exactly the
// overflow instead of blocking the reader.
func TestBackpressureQueueOverflowCounting(t *testing.T) {
	const hardCap = 4
	const submitted = 10

	e := newEngine(backpressureTestConfig(hardCap), nil)

	// No drain loop runs here, so the queue fills up and stays full.
	for i := 0; i < submitted; i++ {
		e.submitUpstreamMessage([]byte(`{"MessageType":"PositionReport"}`))
	}

	messages, dropped, parseErrors, seen, processed := backpressureTestCounters(e)

	// The channel accepts hardCap payloads; the remaining submitted-hardCap are counted
	// as dropped because submitUpstreamMessage uses a non-blocking send.
	if want := submitted - hardCap; dropped != want {
		t.Fatalf("droppedMessages = %d, want %d (10 submissions into a cap of 4)", dropped, want)
	}
	if got := len(e.queue); got != hardCap {
		t.Fatalf("buffered payloads = %d, want %d", got, hardCap)
	}
	if got := cap(e.queue); got != hardCap {
		t.Fatalf("queue capacity = %d, want %d", got, hardCap)
	}
	// Nothing was consumed, so no payload reached the aggregation path at all.
	if messages != 0 || parseErrors != 0 || seen != 0 || processed != 0 {
		t.Fatalf("counters without a drain loop = (messages %d, parseErrors %d, seen %d, processed %d), want all zero",
			messages, parseErrors, seen, processed)
	}
}

// TestBackpressureClearQueueDoesNotCountDrops documents that clearQueue discards
// buffered payloads silently.
//
// The Node relay calls clearUpstreamQueue whenever a connection is replaced or closed;
// those payloads are not counted anywhere, so droppedMessages only ever measures
// hard-cap overflow.
func TestBackpressureClearQueueDoesNotCountDrops(t *testing.T) {
	const hardCap = 4

	e := newEngine(backpressureTestConfig(hardCap), nil)
	for i := 0; i < hardCap; i++ {
		e.submitUpstreamMessage(backpressureTestPositionReport(100000001 + i))
	}
	if _, dropped, _, _, _ := backpressureTestCounters(e); dropped != 0 {
		t.Fatalf("droppedMessages after filling the queue = %d, want 0", dropped)
	}

	e.clearQueue()
	if got := len(e.queue); got != 0 {
		t.Fatalf("buffered payloads after clearQueue = %d, want 0", got)
	}
	if messages, dropped, _, _, _ := backpressureTestCounters(e); dropped != 0 || messages != 0 {
		t.Fatalf("counters after clearQueue = (messages %d, dropped %d), want both zero", messages, dropped)
	}

	// Refilling proves the capacity was reclaimed and that the discarded payloads were
	// not counted as drops: a fresh batch of hardCap submissions still fits.
	for i := 0; i < hardCap; i++ {
		e.submitUpstreamMessage(backpressureTestPositionReport(200000001 + i))
	}
	if got := len(e.queue); got != hardCap {
		t.Fatalf("buffered payloads after refill = %d, want %d", got, hardCap)
	}
	if _, dropped, _, _, _ := backpressureTestCounters(e); dropped != 0 {
		t.Fatalf("droppedMessages after clearQueue and refill = %d, want 0", dropped)
	}

	// One more submission overflows the refilled queue, so the counter still tracks
	// overflow after a clear.
	e.submitUpstreamMessage(backpressureTestPositionReport(300000001))
	if _, dropped, _, _, _ := backpressureTestCounters(e); dropped != 1 {
		t.Fatalf("droppedMessages after the first overflow = %d, want 1", dropped)
	}
}

// TestBackpressureDrainLoopCountsMessages asserts that everything submitted below the
// cap is processed exactly once.
func TestBackpressureDrainLoopCountsMessages(t *testing.T) {
	const hardCap = 64
	const submitted = 32

	cfg := backpressureTestConfig(hardCap)
	cfg.UpstreamDrainBatch = 8
	e := newEngine(cfg, nil)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		e.runDrainLoop(ctx)
	}()

	for i := 0; i < submitted; i++ {
		e.submitUpstreamMessage(backpressureTestPositionReport(100000000 + i))
	}

	backpressureTestWaitFor(t, 2*time.Second, "the drain loop to consume every payload", func() bool {
		messages, _, _, _, _ := backpressureTestCounters(e)
		return messages == submitted
	})

	messages, dropped, parseErrors, seen, processed := backpressureTestCounters(e)
	if messages != submitted {
		t.Fatalf("messageCount = %d, want %d", messages, submitted)
	}
	if dropped != 0 {
		t.Fatalf("droppedMessages = %d, want 0: the queue never exceeded its %d slots", dropped, hardCap)
	}
	if parseErrors != 0 {
		t.Fatalf("parseErrors = %d, want 0: every payload is valid JSON", parseErrors)
	}
	if seen != submitted {
		t.Fatalf("positionReportsSeen = %d, want %d", seen, submitted)
	}
	if processed != submitted {
		t.Fatalf("positionReportsProcessed = %d, want %d", processed, submitted)
	}

	// Cancelling must stop the goroutine; a leaked drain loop would keep consuming the
	// queue of a relay that has already shut down.
	cancel()
	select {
	case <-drained:
	case <-time.After(time.Second):
		t.Fatal("runDrainLoop did not return after the context was cancelled")
	}
}

// TestBackpressureParseErrorClassification pins which payloads count as parse errors.
//
// processRawMessageLocked counts a parse error only when the payload is not valid JSON.
// JSON.parse throws for exactly those inputs; valid JSON that is not an object (a bare
// string, number, boolean, null or an array) parses fine in JavaScript, simply has no
// MessageType, and therefore must not be counted.
func TestBackpressureParseErrorClassification(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		raw             string
		wantParseErrors int
		wantSeen        int
		wantProcessed   int
	}{
		{
			name:            "malformed object",
			raw:             `{"MessageType":`,
			wantParseErrors: 1,
		},
		{
			name:            "malformed value",
			raw:             `{"latitude":}`,
			wantParseErrors: 1,
		},
		{
			// json.Valid is false for trailing data, exactly like JSON.parse.
			name:            "trailing characters",
			raw:             `{"MessageType":"PositionReport"} []`,
			wantParseErrors: 1,
		},
		{
			// JSON.parse("") throws a SyntaxError, so an empty frame is a parse error.
			name:            "empty payload",
			raw:             ``,
			wantParseErrors: 1,
		},
		{
			name: "bare string is valid json",
			raw:  `"PositionReport"`,
		},
		{
			name: "array is valid json",
			raw:  `[{"MessageType":"PositionReport"}]`,
		},
		{
			name: "number is valid json",
			raw:  `42`,
		},
		{
			name: "boolean is valid json",
			raw:  `true`,
		},
		{
			// json.Unmarshal accepts the null literal and leaves the member map nil, which
			// then simply carries no MessageType.
			name: "null is valid json",
			raw:  `null`,
		},
		{
			name: "object without message type",
			raw:  `{"foo":"bar"}`,
		},
		{
			name: "non-string message type",
			raw:  `{"MessageType":42}`,
		},
		{
			name: "other message type",
			raw:  `{"MessageType":"ShipStaticData","MetaData":{"MMSI":123456789}}`,
		},
		{
			// A PositionReport without MetaData/Message is counted as seen and then
			// ignored during normalisation, which is not a parse error.
			name:     "position report without meta data",
			raw:      `{"MessageType":"PositionReport"}`,
			wantSeen: 1,
		},
		{
			name:          "aggregated position report",
			raw:           `{"MessageType":"PositionReport","MetaData":{"MMSI":123456789,"ShipName":"TEST SHIP","latitude":35.5,"longitude":139.5},"Message":{"PositionReport":{"Latitude":35.5,"Longitude":139.5,"Sog":12.5,"Cog":90,"TrueHeading":90}}}`,
			wantSeen:      1,
			wantProcessed: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			e := newEngine(backpressureTestConfig(8), nil)

			// Hand the payload to the drain path exactly as runDrainLoop does: it receives
			// the first payload from the queue and passes it to processBatch.
			e.submitUpstreamMessage([]byte(tt.raw))
			e.processBatch(<-e.queue)

			messages, dropped, parseErrors, seen, processed := backpressureTestCounters(e)
			// Every payload counts as a message before it is parsed.
			if messages != 1 {
				t.Fatalf("messageCount = %d, want 1", messages)
			}
			if dropped != 0 {
				t.Fatalf("droppedMessages = %d, want 0", dropped)
			}
			if parseErrors != tt.wantParseErrors {
				t.Fatalf("parseErrors for %q = %d, want %d", tt.raw, parseErrors, tt.wantParseErrors)
			}
			if seen != tt.wantSeen {
				t.Fatalf("positionReportsSeen for %q = %d, want %d", tt.raw, seen, tt.wantSeen)
			}
			if processed != tt.wantProcessed {
				t.Fatalf("positionReportsProcessed for %q = %d, want %d", tt.raw, processed, tt.wantProcessed)
			}

			lastParseErrorAt, lastParseErrorMessage := backpressureTestParseErrorState(e)
			if tt.wantParseErrors > 0 {
				if lastParseErrorMessage == nil {
					t.Fatalf("lastParseErrorMessage is nil after the parse error in %q", tt.raw)
				}
				if lastParseErrorAt <= 0 {
					t.Fatalf("lastParseErrorAt = %d, want a positive epoch millisecond value", lastParseErrorAt)
				}
				return
			}
			if lastParseErrorMessage != nil {
				t.Fatalf("payload %q recorded parse error %q, want none", tt.raw, *lastParseErrorMessage)
			}
			if lastParseErrorAt != 0 {
				t.Fatalf("lastParseErrorAt = %d for a payload without a parse error, want 0", lastParseErrorAt)
			}
		})
	}
}

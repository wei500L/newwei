package situationsignalsworker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// fakePollHandover is the in-memory handover transport. It records every request
// so a test can assert what the non-owner published and what it waited for.
type fakePollHandover struct {
	subscribers int64

	published  []string
	waits      []time.Duration
	completed  map[string]telegramPollDone
	waitResult telegramPollDone
	waitOK     bool
	waitErr    error
	publishErr error
}

func newFakePollHandover(subscribers int64) *fakePollHandover {
	return &fakePollHandover{subscribers: subscribers, completed: map[string]telegramPollDone{}}
}

func (h *fakePollHandover) Publish(_ context.Context, requestID string) (int64, error) {
	if h.publishErr != nil {
		return 0, h.publishErr
	}
	h.published = append(h.published, requestID)
	return h.subscribers, nil
}

func (h *fakePollHandover) Wait(_ context.Context, requestID string, timeout time.Duration) (telegramPollDone, bool, error) {
	h.waits = append(h.waits, timeout)
	if h.waitErr != nil {
		return telegramPollDone{}, false, h.waitErr
	}
	if !h.waitOK {
		return telegramPollDone{}, false, nil
	}
	done := h.waitResult
	if done.Version == 0 {
		done.Version = telegramPollVersion
	}
	h.completed[requestID] = done
	return done, true, nil
}

func (h *fakePollHandover) Complete(_ context.Context, requestID string, done telegramPollDone) error {
	h.completed[requestID] = done
	return nil
}

// TestQueueTelegramJobHandsOverWhenLeaseIsHeld covers the B2 queue path: a job
// that lands on a process without the lease publishes a poll request and returns
// instead of silently skipping the cycle.
func TestQueueTelegramJobHandsOverWhenLeaseIsHeld(t *testing.T) {
	bus := newFakePollHandover(1)
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	worker.owner.lease.held = true

	worker.handleJob(t, SourceTelegram)

	if len(bus.published) != 1 || bus.published[0] == "" {
		t.Fatalf("published = %v, want one request id", bus.published)
	}
	if len(bus.waits) != 0 {
		t.Fatalf("queue path waited for the handover: %v", bus.waits)
	}
	if len(bus.completed) != 0 {
		t.Fatalf("queue path completed requests: %v", bus.completed)
	}
	if withLease, connects, _, _ := worker.owner.counts(); withLease != 1 || connects != 0 {
		t.Fatalf("owner calls = %d/%d, want one lease attempt and no connection", withLease, connects)
	}
	if resolve, fetch, _, _ := worker.client.stats(); resolve != 0 || fetch != 0 {
		t.Fatalf("client calls = %d/%d, want none", resolve, fetch)
	}
	if raw, ok := worker.store.raw(telegramStateCacheKey); ok {
		t.Fatalf("state document written by a non-owner: %s", raw)
	}
}

// TestRefreshTelegramPollWaitsForOwnerCompletion covers the B2 refresh path from
// the non-owner side: the request is published and the call blocks on the
// completion key long enough for a full poll cycle plus the margin.
func TestRefreshTelegramPollWaitsForOwnerCompletion(t *testing.T) {
	bus := newFakePollHandover(1)
	bus.waitOK = true
	bus.waitResult = telegramPollDone{Version: telegramPollVersion, OK: true}
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	worker.owner.lease.held = true

	if err := worker.service.PollTelegramWait(context.Background()); err != nil {
		t.Fatalf("PollTelegramWait() error = %v", err)
	}

	if len(bus.published) != 1 {
		t.Fatalf("published = %v", bus.published)
	}
	if len(bus.waits) != 1 {
		t.Fatalf("waits = %v", bus.waits)
	}
	wantTimeout := time.Duration(defaultEffectiveSettings(t).TelegramPollCycleTimeoutMS+telegramPollWaitMarginMS) * time.Millisecond
	if bus.waits[0] != wantTimeout {
		t.Fatalf("wait timeout = %s, want %s", bus.waits[0], wantTimeout)
	}
	if withLease, connects, _, _ := worker.owner.counts(); withLease != 1 || connects != 0 {
		t.Fatalf("owner calls = %d/%d, want one lease attempt and no connection", withLease, connects)
	}
}

// TestRefreshTelegramPollReportsHandoverTimeout covers the failure branch: a
// request the owner never completes becomes an error so the refresh reports it.
func TestRefreshTelegramPollReportsHandoverTimeout(t *testing.T) {
	bus := newFakePollHandover(1)
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	worker.owner.lease.held = true

	err := worker.service.PollTelegramWait(context.Background())
	if !errors.Is(err, errTelegramPollHandoverTimeout) {
		t.Fatalf("error = %v, want the handover timeout", err)
	}
}

// TestTelegramPollWithoutSubscriberTakesTheLeaseOver covers the single-instance
// case: PUBLISH reports zero subscribers, so the cycle retries the lease and polls
// locally instead of dropping the refresh.
func TestTelegramPollWithoutSubscriberTakesTheLeaseOver(t *testing.T) {
	bus := newFakePollHandover(0)
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	// The lease is held for the first attempt only, so the request finds no
	// subscriber and the take-over retry wins it.
	worker.owner.denyLease = 1
	worker.client.setMessages("VahidOnline", telegramclient.Message{ID: 7, DateUnix: 1_700_000_007, Text: "hello"})

	if err := worker.service.PollTelegramWait(context.Background()); err != nil {
		t.Fatalf("PollTelegramWait() error = %v", err)
	}

	if len(bus.published) != 1 {
		t.Fatalf("published = %v", bus.published)
	}
	if resolve, fetch, _, _ := worker.client.stats(); resolve == 0 || fetch == 0 {
		t.Fatalf("client calls = %d/%d, want a local cycle", resolve, fetch)
	}
	if withLease, connects, _, _ := worker.owner.counts(); withLease != 2 || connects != 1 {
		t.Fatalf("owner calls = %d/%d, want one failed attempt and one owned cycle", withLease, connects)
	}
	raw, ok := worker.store.raw(telegramStateCacheKey)
	if !ok {
		t.Fatal("state document was not written")
	}
	var document telegramStateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("state document = %s", raw)
	}
	if document.LastPollAt == 0 || len(document.Items) != 1 {
		t.Fatalf("state document = %s", raw)
	}
}

// TestTelegramPollWithoutSubscriberAndForeignLeaseFails covers the opposite case:
// no subscriber accepted the request and the lease is still held by a process that
// is not listening, so the cycle cannot run anywhere.
func TestTelegramPollWithoutSubscriberAndForeignLeaseFails(t *testing.T) {
	bus := newFakePollHandover(0)
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	worker.owner.lease.held = true

	err := worker.service.PollTelegramWait(context.Background())
	if !errors.Is(err, errTelegramPollNoOwner) {
		t.Fatalf("error = %v, want the missing-owner error", err)
	}
}

// TestHandoverRequestIsNeverForwarded covers the fan-out guard: the request path
// must not publish again, because every instance subscribes to the channel and a
// forwarded request would loop between instances. A process that receives the
// broadcast without the lease leaves the request to the owner and records no
// completion.
func TestHandoverRequestIsNeverForwarded(t *testing.T) {
	bus := newFakePollHandover(1)
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	worker.owner.lease.held = true

	worker.service.handleTelegramPollRequest(context.Background(), `{"version":1,"requestId":"req-x"}`)

	if len(bus.published) != 0 {
		t.Fatalf("a received request was forwarded again: %v", bus.published)
	}
	if len(bus.completed) != 0 {
		t.Fatalf("a process without the lease recorded a completion: %v", bus.completed)
	}
	if resolve, fetch, _, _ := worker.client.stats(); resolve != 0 || fetch != 0 {
		t.Fatalf("client calls = %d/%d, want none", resolve, fetch)
	}
	if withLease, connects, _, _ := worker.owner.counts(); withLease != 1 || connects != 0 {
		t.Fatalf("owner calls = %d/%d, want one lease attempt and no connection", withLease, connects)
	}
}

// TestOwnerCompletesPollRequest covers the lease-owner side: the request is served
// by one poll cycle and the completion record is written even when the cycle
// recorded an error.
func TestOwnerCompletesPollRequest(t *testing.T) {
	bus := newFakePollHandover(1)
	worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
	worker.client.setMessages("VahidOnline", telegramclient.Message{ID: 9, DateUnix: 1_700_000_009, Text: "owner"})

	worker.service.handleTelegramPollRequest(context.Background(), `{"version":1,"requestId":"req-1"}`)

	done, ok := bus.completed["req-1"]
	if !ok {
		t.Fatalf("completion = %v, want an entry for req-1", bus.completed)
	}
	if !done.OK || done.Version != telegramPollVersion {
		t.Fatalf("completion = %+v", done)
	}
	if resolve, fetch, _, _ := worker.client.stats(); resolve == 0 || fetch == 0 {
		t.Fatalf("client calls = %d/%d, want one poll cycle", resolve, fetch)
	}
	if raw, ok := worker.store.raw(telegramStateCacheKey); !ok || raw == "" {
		t.Fatal("the owned cycle did not persist the state document")
	}
}

// TestOwnerIgnoresMalformedPollRequests covers the version and request-id guards.
func TestOwnerIgnoresMalformedPollRequests(t *testing.T) {
	for _, payload := range []string{
		`not json`,
		`{"version":2,"requestId":"req-2"}`,
		`{"version":1,"requestId":""}`,
		`{"version":1}`,
	} {
		bus := newFakePollHandover(1)
		worker := newTestWorker(t, testWorkerOptions{env: testEnv(), handover: bus})
		worker.service.handleTelegramPollRequest(context.Background(), payload)
		if len(bus.completed) != 0 {
			t.Fatalf("payload %q completed %v", payload, bus.completed)
		}
		if resolve, fetch, _, _ := worker.client.stats(); resolve != 0 || fetch != 0 {
			t.Fatalf("payload %q polled", payload)
		}
	}
}

// TestPollHandoverWireFormat pins the two documents of the handover protocol.
func TestPollHandoverWireFormat(t *testing.T) {
	request, err := json.Marshal(telegramPollRequest{Version: telegramPollVersion, RequestID: "req-1"})
	if err != nil {
		t.Fatal(err)
	}
	if string(request) != `{"version":1,"requestId":"req-1"}` {
		t.Fatalf("request = %s", request)
	}

	done, err := json.Marshal(telegramPollDone{Version: telegramPollVersion, OK: false, Error: "boom"})
	if err != nil {
		t.Fatal(err)
	}
	if string(done) != `{"version":1,"ok":false,"error":"boom"}` {
		t.Fatalf("done = %s", done)
	}

	okDone, err := json.Marshal(telegramPollDone{Version: telegramPollVersion, OK: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(okDone) != `{"version":1,"ok":true}` {
		t.Fatalf("ok done = %s", okDone)
	}

	if key := telegramPollDoneKey("req-1"); key != "situation-monitor:signals:telegram-poll-done:req-1" {
		t.Fatalf("done key = %q", key)
	}
	if telegramPollChannel != "situation-monitor:signals:telegram-poll:v1" {
		t.Fatalf("channel = %q", telegramPollChannel)
	}
}

// TestPollOrefEntryPointRunsTheCycle covers the refresh entry point for OREF: it
// takes the per-cycle lease and runs one poll.
func TestPollOrefEntryPointRunsTheCycle(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	if err := worker.service.PollOref(context.Background()); err != nil {
		t.Fatalf("PollOref() error = %v", err)
	}
	if worker.locker.acquired != 1 {
		t.Fatalf("OREF lease acquisitions = %d, want 1", worker.locker.acquired)
	}
}

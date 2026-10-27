package situationsignalsworker

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// TestPollTelegramEarlyReturns covers the disabled and missing-credentials
// branches: they must not touch the Telegram owner at all.
func TestPollTelegramEarlyReturns(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		effective := defaultEffectiveSettings(t)
		effective.TelegramEnabled = false
		worker.settings.set(effective)

		worker.handleJob(t, SourceTelegram)
		if withLease, connects, _, _ := worker.owner.counts(); withLease != 0 || connects != 0 {
			t.Fatalf("owner calls = %d/%d, want none", withLease, connects)
		}
		if worker.service.telegramState.LastError != telegramDisabledMessage {
			t.Fatalf("lastError = %q, want %q", worker.service.telegramState.LastError, telegramDisabledMessage)
		}
	})

	t.Run("missing credentials", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		effective := defaultEffectiveSettings(t)
		effective.TelegramSession = ""
		worker.settings.set(effective)

		worker.handleJob(t, SourceTelegram)
		if withLease, connects, _, _ := worker.owner.counts(); withLease != 0 || connects != 0 {
			t.Fatalf("owner calls = %d/%d, want none", withLease, connects)
		}
		if worker.service.telegramState.LastError != telegramNotConfiguredMessage {
			t.Fatalf("lastError = %q, want %q", worker.service.telegramState.LastError, telegramNotConfiguredMessage)
		}
	})

	t.Run("permanently disabled", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		worker.service.telegramPermanentlyDisabled = true

		worker.handleJob(t, SourceTelegram)
		if withLease, connects, _, _ := worker.owner.counts(); withLease != 0 || connects != 0 {
			t.Fatalf("owner calls = %d/%d, want none", withLease, connects)
		}
	})

	t.Run("startup delay", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		effective := defaultEffectiveSettings(t)
		effective.TelegramStartupDelayMS = 60_000
		worker.settings.set(effective)

		worker.handleJob(t, SourceTelegram)
		if withLease, _, _, _ := worker.owner.counts(); withLease != 0 {
			t.Fatalf("WithLease calls = %d, want 0 during startup delay", withLease)
		}
	})
}

// TestPollTelegramGuardErrorsAreCached pins the guard errors behind the
// GET /telegram-feed `error` field. internal/situationsignals rebuilds that
// response from the cached state document only (NestJS rendered it from process
// memory), so a message kept in memory alone would never reach the client.
func TestPollTelegramGuardErrorsAreCached(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		effective := defaultEffectiveSettings(t)
		effective.TelegramEnabled = false
		worker.settings.set(effective)

		worker.handleJob(t, SourceTelegram)
		if document := cachedTelegramStateDocument(t, worker); document.LastError == nil ||
			*document.LastError != telegramDisabledMessage {
			t.Fatalf("cached error = %v, want %q", document.LastError, telegramDisabledMessage)
		}
	})

	t.Run("missing credentials", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		effective := defaultEffectiveSettings(t)
		effective.TelegramSession = ""
		worker.settings.set(effective)

		worker.handleJob(t, SourceTelegram)
		if document := cachedTelegramStateDocument(t, worker); document.LastError == nil ||
			*document.LastError != telegramNotConfiguredMessage {
			t.Fatalf("cached error = %v, want %q", document.LastError, telegramNotConfiguredMessage)
		}
	})

	t.Run("incomplete credentials", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		effective := defaultEffectiveSettings(t)
		effective.TelegramAPIID = "not-a-number"
		worker.settings.set(effective)

		worker.handleJob(t, SourceTelegram)
		if document := cachedTelegramStateDocument(t, worker); document.LastError == nil ||
			*document.LastError != telegramIncompleteMessage {
			t.Fatalf("cached error = %v, want %q", document.LastError, telegramIncompleteMessage)
		}
	})
}

// cachedTelegramStateDocument decodes the cached Telegram state document.
func cachedTelegramStateDocument(t *testing.T, worker *testWorker) telegramStateDocument {
	t.Helper()
	raw, ok := worker.store.raw(telegramStateCacheKey)
	if !ok {
		t.Fatal("telegram state document was not written")
	}
	var document telegramStateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode telegram state document: %v", err)
	}
	return document
}

// TestPollTelegramHappyPath pins the poll cycle: message filtering, cursor,
// state persistence and the realtime event payload.
func TestPollTelegramHappyPath(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	worker.client.setMessages("VahidOnline",
		telegramclient.Message{ID: 10, DateUnix: 1_700_000_010, Text: " hello "},
		telegramclient.Message{ID: 9, DateUnix: 1_700_000_009, Text: "   "},
		telegramclient.Message{ID: 8, DateUnix: 1_700_000_008},
	)

	worker.handleJob(t, SourceTelegram)
	nowMillis := worker.clock.now().UnixMilli()

	state, err := worker.service.loadTelegramState(context.Background())
	if err != nil {
		t.Fatalf("loadTelegramState() error = %v", err)
	}
	if len(state.Items) != 1 {
		t.Fatalf("items = %d, want 1 (media and empty messages are skipped)", len(state.Items))
	}
	item := state.Items[0]
	if item.ID != "VahidOnline:10" || item.Text != " hello " {
		t.Fatalf("item = %#v", item)
	}
	if state.CursorByHandle["VahidOnline"] != 10 {
		t.Fatalf("cursor = %d, want 10", state.CursorByHandle["VahidOnline"])
	}
	if state.LastPollAt != nowMillis || state.LastError != "" {
		t.Fatalf("lastPollAt/lastError = %d/%q", state.LastPollAt, state.LastError)
	}
	if state.ChannelSet == nil || *state.ChannelSet != "full" {
		t.Fatalf("channelSet = %v", state.ChannelSet)
	}

	events := worker.publisher.snapshot()
	if len(events) != 1 || events[0].Type != RealtimeEventTelegramUpdate {
		t.Fatalf("events = %#v", events)
	}
	var payload telegramUpdatePayload
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.Count != 1 || payload.UpdatedAt != nestISOTimeMillis(nowMillis) || len(payload.Items) != 1 {
		t.Fatalf("payload = %#v", payload)
	}
	if _, fetchCalls, _, minIDs := worker.client.stats(); fetchCalls == 0 || minIDs[0] != 0 {
		t.Fatalf("FetchHistory calls/minIDs = %d/%v", fetchCalls, minIDs)
	}
}

// TestPollTelegramB4KeepsChannelError verifies the B4 fix: a failed channel
// keeps lastError, a fully successful cycle clears it.
func TestPollTelegramB4KeepsChannelError(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	worker.client.setMessages("VahidOnline", telegramclient.Message{ID: 10, DateUnix: 1_700_000_010, Text: "hello"})
	worker.client.setFetchErr("ClashReport", errors.New("boom"))

	worker.handleJob(t, SourceTelegram)
	if worker.service.telegramState.LastError == "" {
		t.Fatal("lastError was cleared despite a failed channel")
	}
	if !strings.Contains(worker.service.telegramState.LastError, "poll ClashReport failed:") {
		t.Fatalf("lastError = %q", worker.service.telegramState.LastError)
	}
	raw, _ := worker.store.raw(telegramStateCacheKey)
	var document telegramStateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode persisted state: %v", err)
	}
	if document.LastError == nil || !strings.Contains(*document.LastError, "ClashReport") {
		t.Fatalf("persisted lastError = %v", document.LastError)
	}

	// Next cycle: every channel succeeds, so the error is cleared.
	worker.client.setFetchErr("ClashReport", nil)
	worker.clock.advance(time.Minute)
	worker.handleJob(t, SourceTelegram)
	if worker.service.telegramState.LastError != "" {
		t.Fatalf("lastError = %q, want cleared", worker.service.telegramState.LastError)
	}
}

// TestPollTelegramChannelSetChangeClearsCache covers
// syncTelegramStateWithRuntime.
func TestPollTelegramChannelSetChangeClearsCache(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	worker.store.put(telegramStateCacheKey, `{"channelSet":"tech","cursorByHandle":{"old":7},"items":[{"id":"old:7","source":"telegram","channel":"old","channelTitle":"old","url":"https://t.me/old/7","ts":"2026-01-02T03:04:05.000Z","text":"old","topic":"other","tags":[],"earlySignal":true}],"lastPollAt":123,"lastError":"stale"}`)
	worker.client.setMessages("VahidOnline", telegramclient.Message{ID: 10, DateUnix: 1_700_000_010, Text: "new"})

	worker.handleJob(t, SourceTelegram)

	state, err := worker.service.loadTelegramState(context.Background())
	if err != nil {
		t.Fatalf("loadTelegramState() error = %v", err)
	}
	if state.ChannelSet == nil || *state.ChannelSet != "full" {
		t.Fatalf("channelSet = %v", state.ChannelSet)
	}
	if len(state.Items) != 1 || state.Items[0].ID != "VahidOnline:10" {
		t.Fatalf("items = %#v, want the old channel-set feed discarded", state.Items)
	}
	if state.CursorByHandle["old"] != 0 {
		t.Fatalf("old cursor was not cleared: %#v", state.CursorByHandle)
	}
}

// TestPollTelegramInvalidSession covers the StringSession decode failure.
func TestPollTelegramInvalidSession(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	effective := defaultEffectiveSettings(t)
	effective.TelegramSession = "not-a-session"
	worker.settings.set(effective)

	worker.handleJob(t, SourceTelegram)
	if withLease, _, _, _ := worker.owner.counts(); withLease != 0 {
		t.Fatalf("WithLease calls = %d, want 0", withLease)
	}
	if !strings.HasPrefix(worker.service.telegramState.LastError, "telegram init failed:") {
		t.Fatalf("lastError = %q", worker.service.telegramState.LastError)
	}
}

// TestPollTelegramPerChannelTimeout covers the withTimeout label.
func TestPollTelegramPerChannelTimeout(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	effective := defaultEffectiveSettings(t)
	effective.TelegramChannelTimeoutMS = 5
	worker.settings.set(effective)
	slow := &blockingPollClient{}
	worker.owner.client = slow

	worker.handleJob(t, SourceTelegram)
	if !strings.Contains(worker.service.telegramState.LastError, "TIMEOUT 5ms: getEntity(") {
		t.Fatalf("lastError = %q", worker.service.telegramState.LastError)
	}
}

// blockingPollClient blocks every resolution until its context expires.
type blockingPollClient struct{}

func (blockingPollClient) ResolveChannel(ctx context.Context, _ string) (telegramclient.Peer, error) {
	<-ctx.Done()
	return telegramclient.Peer{}, ctx.Err()
}

func (blockingPollClient) FetchHistory(context.Context, telegramclient.Peer, int, int) ([]telegramclient.Message, error) {
	return nil, errors.New("unexpected FetchHistory call")
}

// TestTwoInstancesAlternating covers B1: two worker processes (each with its
// own in-memory scratch state) alternate jobs and the Redis document keeps the
// feed continuous; a process without the lease does not build a connection.
func TestTwoInstancesAlternating(t *testing.T) {
	first := newTestWorker(t, testWorkerOptions{env: testEnv()})
	first.client.setMessages("VahidOnline", telegramclient.Message{ID: 10, DateUnix: 1_700_000_010, Text: "first"})

	// Second process: same Redis documents, its own manager/connection.
	secondClient := newFakePollClient()
	secondClient.setMessages("VahidOnline", telegramclient.Message{ID: 11, DateUnix: 1_700_000_011, Text: "second"})
	secondOwner := newFakeTelegramOwner(secondClient)
	secondOwner.lease = first.owner.lease
	secondSettings := &fakeSettings{effective: defaultEffectiveSettings(t)}
	secondPublisher := &fakePublisher{}
	second := &testWorker{
		service: newService(serviceDeps{
			store:      first.store,
			locker:     &fakeLocker{},
			settings:   secondSettings,
			telegram:   secondOwner,
			dispatcher: secondPublisher,
			env:        testEnv(),
			logger:     func(string, ...any) {},
			clock:      first.clock.now,
		}),
		store:     first.store,
		settings:  secondSettings,
		owner:     secondOwner,
		publisher: secondPublisher,
		clock:     first.clock,
		client:    secondClient,
	}

	first.handleJob(t, SourceTelegram)
	first.clock.advance(time.Minute)
	second.handleJob(t, SourceTelegram)

	state, err := first.service.loadTelegramState(context.Background())
	if err != nil {
		t.Fatalf("loadTelegramState() error = %v", err)
	}
	if len(state.Items) != 2 {
		t.Fatalf("items = %d, want 2 across two processes", len(state.Items))
	}
	if state.Items[0].ID != "VahidOnline:11" || state.Items[1].ID != "VahidOnline:10" {
		t.Fatalf("item order = %v", []string{state.Items[0].ID, state.Items[1].ID})
	}
	if state.CursorByHandle["VahidOnline"] != 11 {
		t.Fatalf("cursor = %d, want 11", state.CursorByHandle["VahidOnline"])
	}
	_, _, _, minIDs := secondClient.stats()
	if len(minIDs) == 0 || minIDs[0] != 10 {
		t.Fatalf("second process minID = %v, want the cursor stored by the first process", minIDs)
	}

	// Lease contention: while the first process holds the lease the second must
	// not dial and must not change the state.
	first.owner.lease.held = true
	before, _ := first.store.raw(telegramStateCacheKey)
	second.handleJob(t, SourceTelegram)
	after, _ := first.store.raw(telegramStateCacheKey)
	if before != after {
		t.Fatalf("state changed while the other instance held the lease")
	}
	_, connects, _, _ := secondOwner.counts()
	if connects != 1 {
		t.Fatalf("second process connections = %d, want 1 (only the cycle that owned the lease)", connects)
	}
	first.owner.lease.held = false
}

// TestClearBroadcast covers the A2 clear broadcast handling.
func TestClearBroadcast(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	channelSet := "full"
	worker.service.telegramState = telegramState{
		ChannelSet:     &channelSet,
		CursorByHandle: map[string]int64{"a": 1},
		Items:          []TelegramItem{{ID: "a:1"}},
		LastPollAt:     123,
		LastError:      "err",
	}
	worker.store.put(telegramStateCacheKey, `{"channelSet":"full"}`)

	worker.service.handleClearBroadcast(context.Background(), `{"version":1,"clearItems":true}`)

	if _, ok := worker.store.raw(telegramStateCacheKey); ok {
		t.Fatal("telegram state key was not deleted")
	}
	if _, _, disconnects, _ := worker.owner.counts(); disconnects != 1 {
		t.Fatalf("disconnects = %d, want 1", disconnects)
	}
	if worker.service.telegramState.ChannelSet != nil || len(worker.service.telegramState.Items) != 0 || worker.service.telegramState.LastPollAt != 0 {
		t.Fatalf("state was not cleared: %#v", worker.service.telegramState)
	}

	// clearItems=false keeps the feed, and a malformed message is ignored.
	worker.service.telegramState.Items = []TelegramItem{{ID: "a:1"}}
	worker.service.telegramState.LastPollAt = 123
	worker.service.handleClearBroadcast(context.Background(), `{"version":1,"clearItems":false}`)
	if len(worker.service.telegramState.Items) != 1 || worker.service.telegramState.LastPollAt != 123 {
		t.Fatalf("clearItems=false dropped the feed: %#v", worker.service.telegramState)
	}
	worker.service.handleClearBroadcast(context.Background(), `{"version":2,"clearItems":true}`)
	worker.service.handleClearBroadcast(context.Background(), `not json`)
	if len(worker.service.telegramState.Items) != 1 {
		t.Fatalf("malformed broadcast cleared the feed")
	}
}

// TestClearBroadcastMessageParsing pins the subscriber's payload validation.
func TestClearBroadcastMessageParsing(t *testing.T) {
	tests := []struct {
		payload string
		accept  bool
		items   bool
	}{
		{`{"version":1,"clearItems":true}`, true, true},
		{`{"version":1,"clearItems":false}`, true, false},
		{`{"version":2,"clearItems":true}`, false, false},
		{`{"version":1}`, false, false},
		{`{"version":1,"clearItems":"yes"}`, false, false},
		{`[]`, false, false},
	}
	for _, tt := range tests {
		var message clearBroadcastMessage
		err := json.Unmarshal([]byte(tt.payload), &message)
		accepted := err == nil && message.Version == 1 && message.ClearItems != nil
		if accepted != tt.accept {
			t.Fatalf("%s accepted = %t, want %t", tt.payload, accepted, tt.accept)
		}
		if accepted && *message.ClearItems != tt.items {
			t.Fatalf("%s clearItems = %t, want %t", tt.payload, *message.ClearItems, tt.items)
		}
	}
}

// TestBuildTelegramClientOptions pins the credentials validation and the
// deterministic fingerprint.
func TestBuildTelegramClientOptions(t *testing.T) {
	runtime := TelegramRuntimeConfig{APIID: "123", APIHash: "hash", Session: testSessionString(t)}
	options, fingerprint, err := buildTelegramClientOptions(runtime)
	if err != nil {
		t.Fatalf("buildTelegramClientOptions() error = %v", err)
	}
	if options.APIID != 123 || options.APIHash != "hash" || options.Session.DC != 2 {
		t.Fatalf("options = %#v", options)
	}
	if len(fingerprint) != 64 {
		t.Fatalf("fingerprint = %q, want sha256 hex", fingerprint)
	}

	_, _, err = buildTelegramClientOptions(TelegramRuntimeConfig{APIID: "abc", APIHash: "hash", Session: "x"})
	if err == nil || err.Error() != telegramIncompleteMessage {
		t.Fatalf("incomplete credentials error = %v", err)
	}
}

// TestTelegramRuntimeConfigEnvFallback covers the settings failure fallback.
func TestTelegramRuntimeConfigEnvFallback(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: Env{
		TelegramEnabled:    true,
		TelegramAPIID:      "9",
		TelegramAPIHash:    "hash",
		TelegramChannelSet: "tech",
	}})
	worker.settings.err = errors.New("mysql down")
	worker.settings.effective = defaultEffectiveSettings(t)
	runtime := worker.service.telegramRuntimeConfig(context.Background())
	if !runtime.Enabled || runtime.APIID != "9" || runtime.Session != "" || runtime.ChannelSet != "tech" {
		t.Fatalf("runtime = %#v", runtime)
	}
	if !reflect.DeepEqual(runtime, telegramRuntimeConfigFromEnv(worker.service.env)) {
		t.Fatalf("runtime does not match the env fallback")
	}
}

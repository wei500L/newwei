package situationsignalsworker

import (
	"context"
	"database/sql"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings"
	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// ---- in-memory state store ----

type fakeStore struct {
	mu     sync.Mutex
	values map[string]string
}

func newFakeStore() *fakeStore {
	return &fakeStore{values: map[string]string{}}
}

func (s *fakeStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok, nil
}

func (s *fakeStore) Set(_ context.Context, key string, value []byte, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = string(value)
	return nil
}

func (s *fakeStore) Del(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.values, key)
	return nil
}

func (s *fakeStore) raw(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok
}

func (s *fakeStore) put(key, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
}

// ---- cycle locker ----

type fakeLocker struct {
	mu       sync.Mutex
	busy     bool
	acquired int
	skipped  int
}

func (l *fakeLocker) WithLock(ctx context.Context, _ string, _ time.Duration, runner func(context.Context) error) (bool, error) {
	l.mu.Lock()
	if l.busy {
		l.skipped++
		l.mu.Unlock()
		return false, nil
	}
	l.busy = true
	l.acquired++
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		l.busy = false
		l.mu.Unlock()
	}()
	return true, runner(ctx)
}

// ---- settings provider ----

type fakeSettings struct {
	mu        sync.Mutex
	effective situationsettings.EffectiveSettings
	err       error
	calls     int
}

func (f *fakeSettings) EffectiveSettings(context.Context) (situationsettings.EffectiveSettings, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.effective, f.err
}

func (f *fakeSettings) set(effective situationsettings.EffectiveSettings) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.effective = effective
}

// ---- event publisher ----

type fakePublisher struct {
	mu     sync.Mutex
	events []RealtimeEvent
	err    error
}

func (p *fakePublisher) Publish(_ context.Context, event RealtimeEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return p.err
	}
	p.events = append(p.events, event)
	return nil
}

func (p *fakePublisher) snapshot() []RealtimeEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]RealtimeEvent, len(p.events))
	copy(out, p.events)
	return out
}

// ---- alert enqueuer ----

type alertCall struct {
	RuleID  string
	OrgID   string
	TraceID string
}

type fakeAlertEnqueuer struct {
	mu    sync.Mutex
	calls []alertCall
	err   error
}

func (f *fakeAlertEnqueuer) EnqueueRuleCheck(_ context.Context, ruleID, orgID, traceID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, alertCall{RuleID: ruleID, OrgID: orgID, TraceID: traceID})
	return f.err
}

func (f *fakeAlertEnqueuer) snapshot() []alertCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]alertCall, len(f.calls))
	copy(out, f.calls)
	return out
}

// ---- Telegram lease + owner ----

type fakeLease struct {
	mu   sync.Mutex
	held bool
}

func (l *fakeLease) acquire() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.held {
		return false
	}
	l.held = true
	return true
}

func (l *fakeLease) release() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.held = false
}

type fakeTelegramOwner struct {
	mu              sync.Mutex
	lease           *fakeLease
	client          telegramclient.PollClient
	withLeaseCalls  int
	connectCalls    int
	disconnectCalls int
	closeCalls      int
}

func newFakeTelegramOwner(client telegramclient.PollClient) *fakeTelegramOwner {
	return &fakeTelegramOwner{lease: &fakeLease{}, client: client}
}

func (o *fakeTelegramOwner) WithLease(ctx context.Context, _ telegramclient.Options, _ string, fn func(context.Context, telegramclient.PollClient) error) (bool, error) {
	o.mu.Lock()
	o.withLeaseCalls++
	lease := o.lease
	o.mu.Unlock()
	if lease != nil && !lease.acquire() {
		return false, nil
	}
	if lease != nil {
		defer lease.release()
	}
	o.mu.Lock()
	o.connectCalls++
	client := o.client
	o.mu.Unlock()
	if err := fn(ctx, client); err != nil {
		return true, err
	}
	return true, nil
}

func (o *fakeTelegramOwner) Disconnect(context.Context) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.disconnectCalls++
	return nil
}

func (o *fakeTelegramOwner) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.closeCalls++
}

func (o *fakeTelegramOwner) counts() (withLease, connects, disconnects, closes int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.withLeaseCalls, o.connectCalls, o.disconnectCalls, o.closeCalls
}

// ---- poll client ----

type fakePollClient struct {
	mu           sync.Mutex
	peers        map[int64]string
	nextPeerID   int64
	messages     map[string][]telegramclient.Message
	resolveErr   map[string]error
	fetchErr     map[string]error
	resolveCalls int
	fetchCalls   int
	limits       []int
	minIDs       []int
}

func newFakePollClient() *fakePollClient {
	return &fakePollClient{
		peers:      map[int64]string{},
		messages:   map[string][]telegramclient.Message{},
		resolveErr: map[string]error{},
		fetchErr:   map[string]error{},
	}
}

func (c *fakePollClient) ResolveChannel(_ context.Context, handle string) (telegramclient.Peer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.resolveCalls++
	if err, ok := c.resolveErr[handle]; ok {
		return telegramclient.Peer{}, err
	}
	for id, existing := range c.peers {
		if existing == handle {
			return telegramclient.Peer{ChannelID: id, AccessHash: id * 2}, nil
		}
	}
	c.nextPeerID++
	c.peers[c.nextPeerID] = handle
	return telegramclient.Peer{ChannelID: c.nextPeerID, AccessHash: c.nextPeerID * 2}, nil
}

func (c *fakePollClient) FetchHistory(_ context.Context, peer telegramclient.Peer, limit, minID int) ([]telegramclient.Message, error) {
	c.mu.Lock()
	c.fetchCalls++
	c.limits = append(c.limits, limit)
	c.minIDs = append(c.minIDs, minID)
	handle := c.peers[peer.ChannelID]
	err := c.fetchErr[handle]
	messages := append([]telegramclient.Message(nil), c.messages[handle]...)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	out := make([]telegramclient.Message, 0, len(messages))
	for _, message := range messages {
		if message.ID <= minID {
			continue
		}
		out = append(out, message)
	}
	return out, nil
}

func (c *fakePollClient) setMessages(handle string, messages ...telegramclient.Message) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messages[handle] = messages
}

func (c *fakePollClient) setFetchErr(handle string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil {
		delete(c.fetchErr, handle)
		return
	}
	c.fetchErr[handle] = err
}

func (c *fakePollClient) stats() (resolveCalls, fetchCalls int, limits, minIDs []int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.resolveCalls, c.fetchCalls, append([]int(nil), c.limits...), append([]int(nil), c.minIDs...)
}

// ---- clock ----

type fakeClock struct {
	mu      sync.Mutex
	current time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{current: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current
}

func (c *fakeClock) advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.current = c.current.Add(duration)
}

// ---- worker fixture ----

type testWorkerOptions struct {
	env        Env
	db         *sql.DB
	httpClient *http.Client
	clock      *fakeClock
}

type testWorker struct {
	service   *Service
	store     *fakeStore
	locker    *fakeLocker
	settings  *fakeSettings
	owner     *fakeTelegramOwner
	publisher *fakePublisher
	alerts    *fakeAlertEnqueuer
	clock     *fakeClock
	client    *fakePollClient
}

// newTestWorker builds a Service with in-memory dependencies. The Telegram
// client is a fake and no Redis/MySQL connection is opened.
func newTestWorker(t *testing.T, opts testWorkerOptions) *testWorker {
	t.Helper()
	store := newFakeStore()
	locker := &fakeLocker{}
	settings := &fakeSettings{effective: defaultEffectiveSettings(t)}
	publisher := &fakePublisher{}
	alerts := &fakeAlertEnqueuer{}
	client := newFakePollClient()
	owner := newFakeTelegramOwner(client)
	clock := opts.clock
	if clock == nil {
		clock = newFakeClock()
	}
	service := newService(serviceDeps{
		db:         opts.db,
		store:      store,
		locker:     locker,
		settings:   settings,
		telegram:   owner,
		alerts:     alerts,
		dispatcher: publisher,
		httpClient: opts.httpClient,
		env:        opts.env,
		logger:     func(string, ...any) {},
		clock:      clock.now,
	})
	return &testWorker{
		service:   service,
		store:     store,
		locker:    locker,
		settings:  settings,
		owner:     owner,
		publisher: publisher,
		alerts:    alerts,
		clock:     clock,
		client:    client,
	}
}

// defaultEffectiveSettings returns the Telegram runtime configuration the fake
// settings provider serves. The session string is a valid GramJS string so the
// poller reaches the Telegram owner.
func defaultEffectiveSettings(t *testing.T) situationsettings.EffectiveSettings {
	t.Helper()
	return situationsettings.EffectiveSettings{
		TelegramEnabled:            true,
		TelegramAPIID:              "123456",
		TelegramAPIHash:            "0123456789abcdef0123456789abcdef",
		TelegramSession:            testSessionString(t),
		TelegramChannelSet:         "full",
		TelegramMaxFeedItems:       200,
		TelegramMaxTextChars:       20,
		TelegramChannelTimeoutMS:   200,
		TelegramPollCycleTimeoutMS: 2_000,
		TelegramStartupDelayMS:     0,
		TelegramRateLimitMS:        1,
		TelegramPollIntervalMS:     60_000,
	}
}

// testSessionString builds a valid GramJS StringSession value.
func testSessionString(t *testing.T) string {
	t.Helper()
	key := make([]byte, telegramclient.AuthKeySize)
	for index := range key {
		key[index] = byte(index)
	}
	encoded, err := telegramclient.EncodeStringSession(telegramclient.Session{
		DC:      2,
		Address: "149.154.167.51",
		Port:    443,
		AuthKey: key,
	})
	if err != nil {
		t.Fatalf("encode test session: %v", err)
	}
	return encoded
}

// testEnv returns the default environment configuration (no variables set).
func testEnv() Env {
	return NewEnvFromLookup(func(string) (string, bool) { return "", false })
}

// handleJob runs one queued job against the fixture.
func (w *testWorker) handleJob(t *testing.T, source PollSource) {
	t.Helper()
	if err := w.service.HandleJob(context.Background(), source); err != nil {
		t.Fatalf("HandleJob(%s) error = %v", source, err)
	}
}

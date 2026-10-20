package telegramclient

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- fakes -----------------------------------------------------------------

// fakeLeaseStore is an in-memory leaseStore. It records calls and can simulate
// a lease moving to another owner or Redis being briefly unavailable.
type fakeLeaseStore struct {
	mu      sync.Mutex
	values  map[string]string
	setNX   int
	renew   int
	release int

	renewErr     error
	stealOnRenew bool
}

func newFakeLeaseStore() *fakeLeaseStore {
	return &fakeLeaseStore{values: make(map[string]string)}
}

func (s *fakeLeaseStore) SetNX(_ context.Context, key, value string, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setNX++
	if _, exists := s.values[key]; exists {
		return false, nil
	}
	s.values[key] = value
	return true, nil
}

func (s *fakeLeaseStore) Renew(_ context.Context, key, token string, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.renew++
	if s.renewErr != nil {
		return false, s.renewErr
	}
	if s.stealOnRenew {
		// The lease expired and another process took it over.
		s.values[key] = "another-owner"
		return false, nil
	}
	return s.values[key] == token, nil
}

func (s *fakeLeaseStore) Release(_ context.Context, key, token string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.release++
	if s.values[key] != token {
		return false, nil
	}
	delete(s.values, key)
	return true, nil
}

func (s *fakeLeaseStore) counts() (setNX, renew, release int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.setNX, s.renew, s.release
}

func (s *fakeLeaseStore) owner(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.values[key]
}

func (s *fakeLeaseStore) set(key, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
}

func (s *fakeLeaseStore) delete(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.values, key)
}

// fakeManagedClient is a managedClient that never touches the network.
type fakeManagedClient struct {
	startCalls int32
	closed     int32
	startErr   error
}

func (c *fakeManagedClient) Start(context.Context) error {
	atomic.AddInt32(&c.startCalls, 1)
	return c.startErr
}

func (c *fakeManagedClient) Close() {
	atomic.StoreInt32(&c.closed, 1)
}

func (c *fakeManagedClient) ResolveChannel(context.Context, string) (Peer, error) {
	return Peer{}, nil
}

func (c *fakeManagedClient) FetchHistory(context.Context, Peer, int, int) ([]Message, error) {
	return nil, nil
}

func (c *fakeManagedClient) isClosed() bool {
	return atomic.LoadInt32(&c.closed) == 1
}

// fakeClientFactory records every client the Manager constructs.
type fakeClientFactory struct {
	mu        sync.Mutex
	clients   []*fakeManagedClient
	createErr error
	startErr  error
}

func (f *fakeClientFactory) new(Options) (managedClient, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return nil, f.createErr
	}
	client := &fakeManagedClient{startErr: f.startErr}
	f.clients = append(f.clients, client)
	return client, nil
}

func (f *fakeClientFactory) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.clients)
}

func (f *fakeClientFactory) at(index int) *fakeManagedClient {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clients[index]
}

func (f *fakeClientFactory) setStartErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startErr = err
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout after %s waiting for %s", timeout, description)
}

const testLeaseKey = "test:lease"

// --- lease tests -----------------------------------------------------------

func TestLeaseRenewsAndReleases(t *testing.T) {
	store := newFakeLeaseStore()
	l := newLease(store, testLeaseKey, 150*time.Millisecond, 20*time.Millisecond, nil)

	acquired, err := l.tryAcquire(context.Background())
	if err != nil {
		t.Fatalf("tryAcquire() error = %v", err)
	}
	if !acquired {
		t.Fatal("tryAcquire() acquired = false, want true")
	}
	if owner := store.owner(testLeaseKey); owner == "" || owner != l.token {
		t.Errorf("stored owner = %q, want lease token %q", owner, l.token)
	}

	waitFor(t, 2*time.Second, func() bool {
		_, renew, _ := store.counts()
		return renew >= 2
	}, "at least two renewals")

	if err := l.release(context.Background()); err != nil {
		t.Fatalf("release() error = %v", err)
	}
	if owner := store.owner(testLeaseKey); owner != "" {
		t.Errorf("owner after release = %q, want deleted", owner)
	}
	_, renewAfterRelease, _ := store.counts()
	time.Sleep(60 * time.Millisecond)
	if _, renewLater, _ := store.counts(); renewLater != renewAfterRelease {
		t.Errorf("renewals continued after release: %d -> %d", renewAfterRelease, renewLater)
	}
}

func TestLeaseLostStopsRenewalAndDoesNotDeleteNewOwner(t *testing.T) {
	store := newFakeLeaseStore()
	lost := make(chan struct{})
	l := newLease(store, testLeaseKey, time.Minute, 10*time.Millisecond, func() {
		close(lost)
	})
	acquired, err := l.tryAcquire(context.Background())
	if err != nil || !acquired {
		t.Fatalf("tryAcquire() = (%v, %v), want (true, nil)", acquired, err)
	}

	store.mu.Lock()
	store.stealOnRenew = true
	store.mu.Unlock()

	select {
	case <-lost:
	case <-time.After(2 * time.Second):
		t.Fatal("lease loss callback was not invoked")
	}

	if err := l.release(context.Background()); err != nil {
		t.Fatalf("release() after loss error = %v", err)
	}
	if owner := store.owner(testLeaseKey); owner != "another-owner" {
		t.Errorf("owner after releasing a lost lease = %q, want another-owner untouched", owner)
	}
}

func TestLeaseTransientRenewErrorsKeepLease(t *testing.T) {
	store := newFakeLeaseStore()
	lost := make(chan struct{})
	l := newLease(store, testLeaseKey, time.Minute, 10*time.Millisecond, func() {
		close(lost)
	})
	acquired, err := l.tryAcquire(context.Background())
	if err != nil || !acquired {
		t.Fatalf("tryAcquire() = (%v, %v), want (true, nil)", acquired, err)
	}

	store.mu.Lock()
	store.renewErr = errors.New("redis unavailable")
	store.mu.Unlock()
	t.Cleanup(func() { _ = l.release(context.Background()) })

	waitFor(t, 2*time.Second, func() bool {
		_, renew, _ := store.counts()
		return renew >= 3
	}, "retried renewals during a transient error")

	select {
	case <-lost:
		t.Fatal("lease reported lost on a transient renewal error")
	case <-time.After(30 * time.Millisecond):
	}
	if owner := store.owner(testLeaseKey); owner != l.token {
		t.Errorf("owner = %q, want %q", owner, l.token)
	}

	store.mu.Lock()
	store.renewErr = nil
	store.mu.Unlock()
	before, _, _ := store.counts()
	waitFor(t, 2*time.Second, func() bool {
		setNX, renew, _ := store.counts()
		return setNX == before && renew > before
	}, "renewals to resume")
}

// --- manager tests ---------------------------------------------------------

func TestManagerLeaseMutualExclusion(t *testing.T) {
	store := newFakeLeaseStore()
	first := &fakeClientFactory{}
	second := &fakeClientFactory{}
	m1 := newManager(store, testLeaseKey, time.Minute, first.new)
	m2 := newManager(store, testLeaseKey, time.Minute, second.new)
	t.Cleanup(func() {
		m1.Close()
		m2.Close()
	})

	ctx := context.Background()
	var firstCalls, secondCalls int
	owned, err := m1.WithLease(ctx, Options{}, "fingerprint", func(_ context.Context, client PollClient) error {
		firstCalls++
		if _, ok := client.(*fakeManagedClient); !ok {
			t.Errorf("callback client type = %T, want *fakeManagedClient", client)
		}
		return nil
	})
	if err != nil || !owned || firstCalls != 1 {
		t.Fatalf("first manager WithLease() = (%v, %v) with %d calls, want (true, nil) with 1", owned, err, firstCalls)
	}

	owned, err = m2.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error {
		secondCalls++
		return nil
	})
	if err != nil {
		t.Fatalf("second manager WithLease() error = %v", err)
	}
	if owned {
		t.Error("second manager owned = true, want false")
	}
	if secondCalls != 0 {
		t.Errorf("second manager callback calls = %d, want 0", secondCalls)
	}
	if second.count() != 0 {
		t.Errorf("second manager created %d clients without the lease, want 0", second.count())
	}

	// The owner reuses its long-lived client and keeps the lease between calls.
	owned, err = m1.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error {
		firstCalls++
		return nil
	})
	if err != nil || !owned || firstCalls != 2 {
		t.Fatalf("owner second WithLease() = (%v, %v) with %d calls, want (true, nil) with 2", owned, err, firstCalls)
	}
	if first.count() != 1 {
		t.Errorf("owner created %d clients, want 1 (long-lived)", first.count())
	}
	if _, setNX, _ := store.counts(); setNX != 1 {
		t.Errorf("SetNX calls = %d, want 1 (lease held across calls)", setNX)
	}

	// Releasing lets the other process take over.
	m1.Close()
	owned, err = m2.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error {
		secondCalls++
		return nil
	})
	if err != nil || !owned || secondCalls != 1 {
		t.Fatalf("second manager after release = (%v, %v) with %d calls, want (true, nil) with 1", owned, err, secondCalls)
	}
	if second.count() != 1 {
		t.Errorf("second manager created %d clients, want 1", second.count())
	}
}

func TestManagerFingerprintChangeReopensClient(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)
	t.Cleanup(m.Close)

	ctx := context.Background()
	if _, err := m.WithLease(ctx, Options{}, "credentials-a", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("WithLease(a) error = %v", err)
	}
	if _, err := m.WithLease(ctx, Options{}, "credentials-a", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("WithLease(a) again error = %v", err)
	}
	if factory.count() != 1 {
		t.Fatalf("client count after same fingerprint = %d, want 1", factory.count())
	}
	firstClient := factory.at(0)
	if firstClient.isClosed() {
		t.Fatal("long-lived client closed after a same-fingerprint call")
	}

	if _, err := m.WithLease(ctx, Options{}, "credentials-b", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("WithLease(b) error = %v", err)
	}
	if factory.count() != 2 {
		t.Fatalf("client count after fingerprint change = %d, want 2", factory.count())
	}
	if !firstClient.isClosed() {
		t.Error("previous client was not closed after the fingerprint change")
	}
	if factory.at(1).isClosed() {
		t.Error("new client is closed, want running")
	}
}

func TestManagerClientFailureKeepsLeaseAndSkipsCallback(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{startErr: errors.New("connect failed")}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)
	t.Cleanup(m.Close)

	ctx := context.Background()
	called := false
	owned, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error {
		called = true
		return nil
	})
	if err == nil {
		t.Fatal("WithLease() error = nil, want start error")
	}
	if !owned {
		t.Error("owned = false, want true (the lease was acquired before the client failed)")
	}
	if called {
		t.Error("callback ran even though the client was not ready")
	}
	if factory.count() != 1 {
		t.Fatalf("client count = %d, want 1", factory.count())
	}
	if !factory.at(0).isClosed() {
		t.Error("failed client was not closed")
	}
	if _, setNX, _ := store.counts(); setNX != 1 {
		t.Errorf("SetNX calls = %d, want 1 (lease kept for the retry)", setNX)
	}

	// A later call retries the client with the already-held lease.
	factory.setStartErr(nil)
	if _, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("retry WithLease() error = %v", err)
	}
	if factory.count() != 2 {
		t.Errorf("client count after retry = %d, want 2", factory.count())
	}
	if _, setNX, _ := store.counts(); setNX != 1 {
		t.Errorf("SetNX calls after retry = %d, want 1", setNX)
	}
}

func TestManagerLosingLeaseClosesClientAndReacquires(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, 120*time.Millisecond, factory.new)
	t.Cleanup(m.Close)

	ctx := context.Background()
	if _, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("WithLease() error = %v", err)
	}
	firstClient := factory.at(0)

	store.mu.Lock()
	store.stealOnRenew = true
	store.mu.Unlock()

	waitFor(t, 2*time.Second, firstClient.isClosed, "client close after lease loss")

	// Another process owns the key: this manager must not call fn or dial.
	called := false
	owned, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("WithLease(while stolen) error = %v", err)
	}
	if owned || called {
		t.Errorf("WithLease(while stolen) = (owned %v, called %v), want (false, false)", owned, called)
	}
	if factory.count() != 1 {
		t.Errorf("client count while stolen = %d, want 1 (no dial without lease)", factory.count())
	}

	// When the other owner disappears, the next call acquires a new lease and
	// opens a fresh client.
	store.delete(testLeaseKey)
	store.mu.Lock()
	store.stealOnRenew = false
	store.mu.Unlock()
	owned, err = m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil })
	if err != nil || !owned {
		t.Fatalf("WithLease(reacquire) = (%v, %v), want (true, nil)", owned, err)
	}
	if factory.count() != 2 {
		t.Errorf("client count after reacquire = %d, want 2", factory.count())
	}
}

func TestManagerTransientRenewErrorKeepsClient(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, 120*time.Millisecond, factory.new)
	t.Cleanup(m.Close)

	ctx := context.Background()
	if _, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("WithLease() error = %v", err)
	}
	client := factory.at(0)

	store.mu.Lock()
	store.renewErr = errors.New("redis unavailable")
	store.mu.Unlock()
	waitFor(t, 2*time.Second, func() bool {
		_, renew, _ := store.counts()
		return renew >= 3
	}, "renew retries")
	if client.isClosed() {
		t.Fatal("client closed on a transient renewal error")
	}

	store.mu.Lock()
	store.renewErr = nil
	store.mu.Unlock()
	owned, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil })
	if err != nil || !owned {
		t.Fatalf("WithLease() after recovery = (%v, %v), want (true, nil)", owned, err)
	}
	if factory.count() != 1 {
		t.Errorf("client count = %d, want 1", factory.count())
	}
}

func TestManagerCloseReleasesLeaseAndClient(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)

	ctx := context.Background()
	if _, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil }); err != nil {
		t.Fatalf("WithLease() error = %v", err)
	}
	client := factory.at(0)

	m.Close()
	if !client.isClosed() {
		t.Error("client not closed by Close()")
	}
	if owner := store.owner(testLeaseKey); owner != "" {
		t.Errorf("lease owner after Close() = %q, want deleted", owner)
	}
	if _, _, releases := store.counts(); releases != 1 {
		t.Errorf("release calls = %d, want 1", releases)
	}

	// Close is idempotent.
	m.Close()
	if _, _, releases := store.counts(); releases != 1 {
		t.Errorf("release calls after second Close() = %d, want 1", releases)
	}

	// WithLease fails cleanly after Close.
	called := false
	owned, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error {
		called = true
		return nil
	})
	if !errors.Is(err, ErrManagerClosed) {
		t.Errorf("WithLease() after Close error = %v, want ErrManagerClosed", err)
	}
	if owned || called {
		t.Errorf("WithLease() after Close = (owned %v, called %v), want (false, false)", owned, called)
	}
}

func TestManagerSerializesConcurrentCalls(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)
	t.Cleanup(m.Close)

	var (
		mu       sync.Mutex
		inFlight int
		maxSeen  int
	)
	fn := func(context.Context, PollClient) error {
		mu.Lock()
		inFlight++
		if inFlight > maxSeen {
			maxSeen = inFlight
		}
		mu.Unlock()
		time.Sleep(2 * time.Millisecond)
		mu.Lock()
		inFlight--
		mu.Unlock()
		return nil
	}

	const goroutines = 5
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, goroutines)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			owned, err := m.WithLease(context.Background(), Options{}, "fingerprint", fn)
			if err != nil {
				errs <- err
				return
			}
			if !owned {
				errs <- errors.New("expected ownership")
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent WithLease() error = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if maxSeen != 1 {
		t.Errorf("max parallel callbacks = %d, want 1", maxSeen)
	}
	if factory.count() != 1 {
		t.Errorf("client count = %d, want 1", factory.count())
	}
}

func TestManagerWithoutRedis(t *testing.T) {
	m := NewManager(nil, "", 0)
	t.Cleanup(m.Close)

	if m.leaseKey != DefaultLeaseKey {
		t.Errorf("leaseKey = %q, want %q", m.leaseKey, DefaultLeaseKey)
	}
	if m.leaseTTL != DefaultLeaseTTL {
		t.Errorf("leaseTTL = %s, want %s", m.leaseTTL, DefaultLeaseTTL)
	}

	called := false
	owned, err := m.WithLease(context.Background(), Options{}, "", func(context.Context, PollClient) error {
		called = true
		return nil
	})
	if err == nil {
		t.Fatal("WithLease() error = nil, want redis error")
	}
	if owned || called {
		t.Errorf("WithLease() = (owned %v, called %v), want (false, false)", owned, called)
	}
}

func TestManagerLeaseKeyAndTTLDefaults(t *testing.T) {
	m := newManager(newFakeLeaseStore(), "", 0, (&fakeClientFactory{}).new)
	if m.leaseKey != DefaultLeaseKey {
		t.Errorf("leaseKey = %q, want %q", m.leaseKey, DefaultLeaseKey)
	}
	if m.leaseTTL != DefaultLeaseTTL {
		t.Errorf("leaseTTL = %s, want %s", m.leaseTTL, DefaultLeaseTTL)
	}
	wantInterval := DefaultLeaseTTL / 3
	if m.renewInterval != wantInterval {
		t.Errorf("renewInterval = %s, want %s", m.renewInterval, wantInterval)
	}
}

func TestManagerDisconnectReleasesLeaseAndReopens(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, 120*time.Millisecond, factory.new)
	t.Cleanup(m.Close)

	ctx := context.Background()
	if owned, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil }); err != nil || !owned {
		t.Fatalf("WithLease() = (%v, %v), want (true, nil)", owned, err)
	}
	firstClient := factory.at(0)

	if err := m.Disconnect(ctx); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}
	if !firstClient.isClosed() {
		t.Error("Disconnect() did not close the long-lived client")
	}
	if owner := store.owner(testLeaseKey); owner != "" {
		t.Errorf("lease owner after Disconnect() = %q, want deleted", owner)
	}

	// The manager stays usable: the next call re-acquires the lease and reopens
	// a client on demand.
	owned, err := m.WithLease(ctx, Options{}, "fingerprint", func(context.Context, PollClient) error { return nil })
	if err != nil || !owned {
		t.Fatalf("WithLease() after Disconnect = (%v, %v), want (true, nil)", owned, err)
	}
	if factory.count() != 2 {
		t.Errorf("client count after Disconnect = %d, want 2", factory.count())
	}
	if factory.at(1).isClosed() {
		t.Error("reopened client is closed, want running")
	}

	// Close still works after Disconnect and remains terminal.
	m.Close()
	if !factory.at(1).isClosed() {
		t.Error("Close() after Disconnect did not close the reopened client")
	}
}

func TestManagerDisconnectWaitsForRunningCallback(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)
	t.Cleanup(m.Close)

	callbackStarted := make(chan struct{})
	callbackRelease := make(chan struct{})
	withLeaseDone := make(chan error, 1)
	go func() {
		_, err := m.WithLease(context.Background(), Options{}, "fingerprint", func(context.Context, PollClient) error {
			close(callbackStarted)
			<-callbackRelease
			return nil
		})
		withLeaseDone <- err
	}()
	<-callbackStarted

	disconnectDone := make(chan error, 1)
	go func() {
		disconnectDone <- m.Disconnect(context.Background())
	}()
	select {
	case err := <-disconnectDone:
		t.Fatalf("Disconnect() returned (%v) while the callback was still running", err)
	case <-time.After(20 * time.Millisecond):
	}

	client := factory.at(0)
	close(callbackRelease)
	if err := <-withLeaseDone; err != nil {
		t.Fatalf("WithLease() error = %v", err)
	}
	if err := <-disconnectDone; err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}
	if !client.isClosed() {
		t.Error("client not closed after the callback finished")
	}
	if owner := store.owner(testLeaseKey); owner != "" {
		t.Errorf("lease owner after Disconnect() = %q, want deleted", owner)
	}
}

func TestManagerDisconnectContextCancelledWhileWaiting(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)
	t.Cleanup(m.Close)

	callbackStarted := make(chan struct{})
	callbackRelease := make(chan struct{})
	withLeaseDone := make(chan error, 1)
	go func() {
		_, err := m.WithLease(context.Background(), Options{}, "fingerprint", func(context.Context, PollClient) error {
			close(callbackStarted)
			<-callbackRelease
			return nil
		})
		withLeaseDone <- err
	}()
	<-callbackStarted

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.Disconnect(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("Disconnect() error = %v, want context.Canceled", err)
	}
	client := factory.at(0)
	if client.isClosed() {
		t.Error("client closed even though Disconnect gave up waiting")
	}

	close(callbackRelease)
	if err := <-withLeaseDone; err != nil {
		t.Fatalf("WithLease() error = %v", err)
	}
	if owner := store.owner(testLeaseKey); owner == "" {
		t.Error("lease released even though Disconnect was cancelled")
	}
}

func TestManagerDisconnectWithoutLeaseIsNoop(t *testing.T) {
	store := newFakeLeaseStore()
	factory := &fakeClientFactory{}
	m := newManager(store, testLeaseKey, time.Minute, factory.new)
	t.Cleanup(m.Close)

	if err := m.Disconnect(context.Background()); err != nil {
		t.Fatalf("Disconnect() without lease error = %v, want nil", err)
	}
	if factory.count() != 0 {
		t.Errorf("client count = %d, want 0", factory.count())
	}
	owned, err := m.WithLease(context.Background(), Options{}, "fingerprint", func(context.Context, PollClient) error { return nil })
	if err != nil || !owned {
		t.Fatalf("WithLease() after no-op Disconnect = (%v, %v), want (true, nil)", owned, err)
	}
}

package telegramclient

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// DefaultLeaseKey is the Redis key of the single-instance Telegram lease
	// (contract B1). It lives outside the BullMQ keyspace on purpose: it only
	// coordinates which api-go process may hold the MTProto connection.
	DefaultLeaseKey = "situation-monitor:signals:telegram:lease"

	// DefaultLeaseTTL is the lease TTL. Renewal runs at a third of it, so a
	// crashed owner stops blocking the other process within the TTL.
	DefaultLeaseTTL = 30 * time.Second
)

// ErrManagerClosed is returned by WithLease after Close. Close is the terminal
// process-shutdown hook, so a poll racing with it must fail cleanly.
var ErrManagerClosed = errors.New("telegramclient: manager is closed")

// managedClient is the long-lived client behaviour the Manager needs. *Client
// implements it; tests inject a fake so no MTProto connection is ever opened.
//
// Compile-time check: the production client must satisfy the Manager contract.
var _ managedClient = (*Client)(nil)

type managedClient interface {
	PollClient
	// Start starts the background connection and waits until it is ready or ctx
	// expires. It is idempotent: calling it on a running client only waits.
	Start(ctx context.Context) error
	// Close stops the client and its connection. It is idempotent.
	Close()
}

// Manager owns the single-instance lease (B1) and the one long-lived Telegram
// client (O2) of this process.
//
// A Manager never dials without the lease: WithLease first acquires the Redis
// lease and only then creates or starts a client, so a second api-go instance
// that loses the race performs no MTProto work at all. The lease is long-lived
// and renewed in the background between polls; it is released by Disconnect (the
// settings-clear hook, leaving the Manager reusable) or by Close (terminal
// shutdown).
//
// WithLease is fully serialized by callSlot: concurrent callers wait instead of
// running fn in parallel (signals-worker consumes with concurrency 1, but the
// cleanup/reconnect paths can race with a poll). Disconnect shares the same slot
// so it never tears the client down in the middle of fn.
type Manager struct {
	store         leaseStore
	leaseKey      string
	leaseTTL      time.Duration
	renewInterval time.Duration
	newClient     func(Options) (managedClient, error)

	// callSlot serializes WithLease and Disconnect so fn never runs twice in
	// parallel and a disconnect cannot tear the client down mid-callback. It is
	// a one-token channel instead of a mutex so both callers can honour ctx while
	// waiting.
	callSlot chan struct{}
	// stateMu guards closed, lease, client and fingerprint. It is never held
	// while fn runs.
	stateMu     sync.Mutex
	closed      bool
	lease       *lease
	client      managedClient
	fingerprint string
}

// NewManager builds the lease owner for the shared go-redis client. An empty
// leaseKey uses DefaultLeaseKey and a non-positive leaseTTL uses
// DefaultLeaseTTL. A nil Redis client is accepted here but WithLease reports
// errLeaseStoreUnavailable, because the single-instance guarantee needs Redis.
func NewManager(redis *redis.Client, leaseKey string, leaseTTL time.Duration) *Manager {
	// The long-lived clients get the O1 peer cache backed by the same Redis
	// client. New() itself has no cache because Options is part of the public
	// contract and carries no Redis handle; the Manager is the production path.
	cache := redisPeerCache{client: redis}
	return newManager(redisLeaseStore{client: redis}, leaseKey, leaseTTL, func(opts Options) (managedClient, error) {
		client, err := New(opts)
		if err != nil {
			return nil, err
		}
		client.setPeerCache(cache)
		return client, nil
	})
}

// newManager is the testable constructor: it accepts the narrow lease store
// and client factory as dependencies.
func newManager(store leaseStore, leaseKey string, leaseTTL time.Duration, newClient func(Options) (managedClient, error)) *Manager {
	if leaseKey == "" {
		leaseKey = DefaultLeaseKey
	}
	if leaseTTL <= 0 {
		leaseTTL = DefaultLeaseTTL
	}
	renewInterval := leaseTTL / 3
	if renewInterval < minManagerRenewInterval {
		renewInterval = minManagerRenewInterval
	}
	m := &Manager{
		store:         store,
		leaseKey:      leaseKey,
		leaseTTL:      leaseTTL,
		renewInterval: renewInterval,
		newClient:     newClient,
		callSlot:      make(chan struct{}, 1),
	}
	m.callSlot <- struct{}{}
	return m
}

// WithLease runs fn while this process owns the single-instance lease and the
// long-lived client for fingerprint is connected.
//
// owned is false when another process holds the lease; fn is then not called
// and no client is created. When the lease is owned, client is the process-wide
// long-lived client and stays open between calls. A fingerprint change closes
// and reopens that client (credentials/session change).
func (m *Manager) WithLease(ctx context.Context, cfg Options, fingerprint string, fn func(ctx context.Context, client PollClient) error) (owned bool, err error) {
	if fn == nil {
		return false, errors.New("telegramclient: manager: nil callback")
	}

	if err := m.acquireCall(ctx); err != nil {
		return false, err
	}
	defer m.releaseCall()

	client, leased, err := m.leaseClient(ctx, cfg, fingerprint)
	if err != nil {
		return leased, err
	}
	if !leased {
		return false, nil
	}
	return true, fn(ctx, client)
}

// Disconnect releases the lease and closes the long-lived client, but keeps the
// Manager usable: the next WithLease re-acquires the lease and reopens the
// client on demand. It is the A2 cleanup hook (settings were cleared or new
// credentials were written), not a shutdown hook.
//
// Disconnect waits for an in-flight WithLease callback to finish before the
// client is closed (it shares the callSlot with WithLease); ctx bounds that
// wait and the token-checked Redis release. A manager that was already closed
// is a no-op, and Disconnect never returns ErrManagerClosed on its own.
func (m *Manager) Disconnect(ctx context.Context) error {
	if err := m.acquireCall(ctx); err != nil {
		return err
	}
	defer m.releaseCall()

	m.stateMu.Lock()
	if m.closed {
		m.stateMu.Unlock()
		return nil
	}
	current := m.lease
	m.lease = nil
	m.stopClientLocked()
	m.stateMu.Unlock()

	if current == nil {
		return nil
	}
	releaseCtx, cancel := context.WithTimeout(ctx, leaseIOtimeout)
	defer cancel()
	return current.release(releaseCtx)
}

// acquireCall takes the single call token, honouring ctx while waiting.
func (m *Manager) acquireCall(ctx context.Context) error {
	select {
	case <-m.callSlot:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// releaseCall returns the single call token.
func (m *Manager) releaseCall() {
	m.callSlot <- struct{}{}
}

// leaseClient acquires the lease when needed and returns the ready long-lived
// client. leased reports whether fn may run.
func (m *Manager) leaseClient(ctx context.Context, cfg Options, fingerprint string) (PollClient, bool, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	if m.closed {
		return nil, false, ErrManagerClosed
	}
	if m.lease == nil {
		acquired, err := m.acquireLeaseLocked(ctx)
		if err != nil {
			return nil, false, err
		}
		if !acquired {
			return nil, false, nil
		}
	}

	if m.client != nil && m.fingerprint == fingerprint {
		// Already running: Start only waits for the first ready signal.
		if err := m.client.Start(ctx); err != nil {
			return nil, true, fmt.Errorf("telegramclient: manager: wait for client: %w", err)
		}
		return m.client, true, nil
	}

	m.stopClientLocked()

	client, err := m.newClient(cfg)
	if err != nil {
		return nil, true, fmt.Errorf("telegramclient: manager: create client: %w", err)
	}
	if err := client.Start(ctx); err != nil {
		client.Close()
		return nil, true, fmt.Errorf("telegramclient: manager: start client: %w", err)
	}
	m.client = client
	m.fingerprint = fingerprint
	return client, true, nil
}

// acquireLeaseLocked attempts one SET NX. It must be called with stateMu held.
func (m *Manager) acquireLeaseLocked(ctx context.Context) (bool, error) {
	if m.store == nil {
		return false, errLeaseStoreUnavailable
	}
	var candidate *lease
	candidate = newLease(m.store, m.leaseKey, m.leaseTTL, m.renewInterval, func() {
		m.handleLeaseLost(candidate)
	})
	acquired, err := candidate.tryAcquire(ctx)
	if err != nil {
		return false, fmt.Errorf("telegramclient: manager: acquire lease: %w", err)
	}
	if !acquired {
		return false, nil
	}
	m.lease = candidate
	return true, nil
}

// handleLeaseLost runs from the renewal goroutine when the token-checked renew
// proves another process may now own the lease. The long-lived client is
// closed immediately so this process stops speaking MTProto.
func (m *Manager) handleLeaseLost(lost *lease) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if m.lease != lost {
		return
	}
	m.lease = nil
	m.stopClientLocked()
}

// stopClientLocked closes the long-lived client and clears its fingerprint. It
// must be called with stateMu held.
func (m *Manager) stopClientLocked() {
	if m.client == nil {
		return
	}
	m.client.Close()
	m.client = nil
	m.fingerprint = ""
}

// Close releases the lease and closes the long-lived client, and marks the
// Manager as terminally closed: every later WithLease returns ErrManagerClosed.
// It is the process-shutdown hook; the cleanup broadcast uses Disconnect so the
// Manager can reopen afterwards. Close is idempotent and does not wait for an
// in-flight poll (callSlot is not taken); that poll's client calls fail instead.
func (m *Manager) Close() {
	m.stateMu.Lock()
	if m.closed {
		m.stateMu.Unlock()
		return
	}
	m.closed = true
	current := m.lease
	m.lease = nil
	m.stopClientLocked()
	m.stateMu.Unlock()

	if current == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), leaseIOtimeout)
	defer cancel()
	_ = current.release(ctx)
}

//go:build integration

// Integration tests for the migrated situation-monitor signals worker.
//
// They exercise the real Redis 7.2 and MySQL 8.4 contracts (state documents,
// leases, pub/sub, BullMQ keys and the OREF default alert rules) against the
// services the production API uses. Telegram is always a fake (the worker's
// TelegramOwner interface is implemented over the real Redis SETNX lease) and
// the OREF upstream/proxy are in-process httptest servers, so this file never
// dials the network.
package situationsignalsworker

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

var (
	// sitWorkerITISOTimestamp matches the wire timestamps both implementations
	// write (Date.prototype.toISOString: UTC, three fractional digits, Z).
	sitWorkerITISOTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	// sitWorkerITFingerprint matches telegramCredentialsFingerprint (sha256 hex).
	sitWorkerITFingerprint = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ---- real Redis / MySQL fixtures ----

// sitWorkerITMySQL creates a throwaway MySQL database for one test. The job runs
// other integration steps against the shared `app` schema, so a dedicated
// database keeps the Org/AlertRule fixture isolated from their leftovers (and
// removes any dependency on the order the job steps run in).
func sitWorkerITMySQL(t *testing.T) *sql.DB {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if baseURL == "" {
		t.Skip("DATABASE_URL not set - integration test requires MySQL")
	}
	base, err := usersettings.OpenMySQLFromURL(baseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	databaseName := "situation_signals_worker_it_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := base.ExecContext(ctx, "CREATE DATABASE `"+databaseName+"`"); err != nil {
		_ = base.Close()
		t.Fatalf("create integration database: %v", err)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		_ = base.Close()
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	parsed.Path = "/" + databaseName
	db, err := usersettings.OpenMySQLFromURL(parsed.String())
	if err != nil {
		_ = base.Close()
		t.Fatalf("open integration mysql: %v", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		_ = base.Close()
		t.Fatalf("ping integration mysql: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = db.Close()
		_, _ = base.ExecContext(cleanupCtx, "DROP DATABASE `"+databaseName+"`")
		_ = base.Close()
	})
	return db
}

// sitWorkerITRedis addresses a dedicated Redis database so the job's other
// integration steps (which use database 0/9/11) can never collide with the
// worker keys, and cleanly flushes it before and after every test.
func sitWorkerITRedis(t *testing.T) *redis.Client {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set - integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: address, DB: 13, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		_ = client.Close()
		t.Fatalf("redis ping: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.FlushDB(cleanupCtx).Err()
		_ = client.Close()
	})
	return client
}

// sitWorkerITResetRedis clears the dedicated test database. Only database 13 is
// touched, never the shared keyspace of the other integration steps.
func sitWorkerITResetRedis(t *testing.T, client *redis.Client) {
	t.Helper()
	if err := client.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush integration redis database: %v", err)
	}
}

// sitWorkerITEnv resolves the worker environment from an explicit map.
func sitWorkerITEnv(values map[string]string) Env {
	return NewEnvFromLookup(func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	})
}

func sitWorkerITRedisString(t *testing.T, client *redis.Client, key string) string {
	t.Helper()
	value, err := client.Get(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("get %q: %v", key, err)
	}
	return value
}

// sitWorkerITAssertTTL checks that key exists with the expected TTL.
func sitWorkerITAssertTTL(t *testing.T, client *redis.Client, key string, want, tolerance time.Duration) {
	t.Helper()
	ttl, err := client.TTL(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("ttl %q: %v", key, err)
	}
	if ttl <= 0 || ttl > want || ttl < want-tolerance {
		t.Fatalf("ttl %q = %s, want ~%s", key, ttl, want)
	}
}

// sitWorkerITWaitKeyGone polls until key disappears (or fails after 5s).
func sitWorkerITWaitKeyGone(t *testing.T, client *redis.Client, key string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		exists, err := client.Exists(context.Background(), key).Result()
		if err != nil {
			t.Fatalf("exists %q: %v", key, err)
		}
		if exists == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("key %q still exists after 5s", key)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// sitWorkerITNextMessage returns the next realtime-bridge message.
func sitWorkerITNextMessage(t *testing.T, pubsub *redis.PubSub) *redis.Message {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		received, err := pubsub.ReceiveTimeout(context.Background(), 250*time.Millisecond)
		if err != nil {
			continue
		}
		message, ok := received.(*redis.Message)
		if !ok {
			continue
		}
		return message
	}
	t.Fatal("no realtime event within 5s")
	return nil
}

// sitWorkerITAssertNoMessage fails when a realtime-bridge message arrives.
func sitWorkerITAssertNoMessage(t *testing.T, pubsub *redis.PubSub) {
	t.Helper()
	received, err := pubsub.ReceiveTimeout(context.Background(), 300*time.Millisecond)
	if err != nil {
		return
	}
	if message, ok := received.(*redis.Message); ok {
		t.Fatalf("unexpected realtime event on %q: %s", message.Channel, message.Payload)
	}
	t.Fatalf("unexpected pubsub frame: %#v", received)
}

// ---- fake Telegram owner backed by the real Redis lease ----

// sitWorkerITLeaseOwner is the Redis-lease shape of telegramclient.Manager: only
// the instance that wins SETNX on the shared lease key "creates a connection"
// (runs the callback). It keeps the key until the test releases it, exactly like
// the production Manager's long-lived lease.
type sitWorkerITLeaseOwner struct {
	redis  *redis.Client
	id     string
	client telegramclient.PollClient

	mu          sync.Mutex
	connects    int
	skipped     int
	disconnects int
	closes      int
	fingerprint string
}

func (o *sitWorkerITLeaseOwner) WithLease(ctx context.Context, _ telegramclient.Options, fingerprint string, fn func(context.Context, telegramclient.PollClient) error) (bool, error) {
	acquired, err := o.redis.SetNX(ctx, telegramclient.DefaultLeaseKey, o.id, telegramclient.DefaultLeaseTTL).Result()
	if err != nil {
		return false, err
	}
	if !acquired {
		// Re-entrant like telegramclient.Manager: while this instance owns the lease
		// key it keeps using the connection instead of treating its own key as a
		// foreign lease. A nested cycle (the handover request path) therefore runs
		// here, and only the TTL is renewed.
		current, getErr := o.redis.Get(ctx, telegramclient.DefaultLeaseKey).Result()
		if getErr != nil && !errors.Is(getErr, redis.Nil) {
			return false, getErr
		}
		if current != o.id {
			o.mu.Lock()
			o.fingerprint = fingerprint
			o.skipped++
			o.mu.Unlock()
			return false, nil
		}
		if expireErr := o.redis.Expire(ctx, telegramclient.DefaultLeaseKey, telegramclient.DefaultLeaseTTL).Err(); expireErr != nil {
			return false, expireErr
		}
	}
	o.mu.Lock()
	o.fingerprint = fingerprint
	o.connects++
	o.mu.Unlock()
	return true, fn(ctx, o.client)
}

func (o *sitWorkerITLeaseOwner) release(t *testing.T) {
	t.Helper()
	if err := o.redis.Del(context.Background(), telegramclient.DefaultLeaseKey).Err(); err != nil {
		t.Fatalf("release telegram lease: %v", err)
	}
}

func (o *sitWorkerITLeaseOwner) Disconnect(ctx context.Context) error {
	o.mu.Lock()
	o.disconnects++
	o.mu.Unlock()
	return o.redis.Del(ctx, telegramclient.DefaultLeaseKey).Err()
}

func (o *sitWorkerITLeaseOwner) Close() {
	o.mu.Lock()
	o.closes++
	o.mu.Unlock()
}

func (o *sitWorkerITLeaseOwner) counts() (connects, skipped, disconnects int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.connects, o.skipped, o.disconnects
}

func (o *sitWorkerITLeaseOwner) fingerprintValue() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.fingerprint
}

// sitWorkerITUnusedTelegram fails loudly if a Telegram poll runs: the OREF
// tests must never build an MTProto connection.
type sitWorkerITUnusedTelegram struct{}

func (sitWorkerITUnusedTelegram) WithLease(context.Context, telegramclient.Options, string, func(context.Context, telegramclient.PollClient) error) (bool, error) {
	return false, errors.New("situationsignalsworker integration test: telegram must not run here")
}

func (sitWorkerITUnusedTelegram) Disconnect(context.Context) error { return nil }

func (sitWorkerITUnusedTelegram) Close() {}

// ---- Telegram B1: two instances share the Redis state document ----

// sitWorkerITTelegramStateDocument mirrors the Redis state document both the
// worker (writer) and internal/situationsignals (reader) understand.
type sitWorkerITTelegramStateDocument struct {
	ChannelSet     *string          `json:"channelSet"`
	CursorByHandle map[string]int64 `json:"cursorByHandle"`
	Items          []TelegramItem   `json:"items"`
	LastPollAt     int64            `json:"lastPollAt"`
	LastError      *string          `json:"lastError"`
}

func sitWorkerITLoadTelegramState(t *testing.T, client *redis.Client) sitWorkerITTelegramStateDocument {
	t.Helper()
	raw := sitWorkerITRedisString(t, client, telegramStateCacheKey)
	var document sitWorkerITTelegramStateDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode telegram state document %s: %v", raw, err)
	}
	return document
}

// sitWorkerITAssertTelegramState asserts the persistent state after one poll.
func sitWorkerITAssertTelegramState(t *testing.T, client *redis.Client, handle string, wantCursor int64, wantIDs []string) {
	t.Helper()
	document := sitWorkerITLoadTelegramState(t, client)
	if document.ChannelSet == nil || *document.ChannelSet != "full" {
		t.Fatalf("channelSet = %v, want %q", document.ChannelSet, "full")
	}
	if document.LastError != nil {
		t.Fatalf("lastError = %q, want null after a successful cycle", *document.LastError)
	}
	if document.LastPollAt <= 0 {
		t.Fatalf("lastPollAt = %d", document.LastPollAt)
	}
	if got := document.CursorByHandle[handle]; got != wantCursor {
		t.Fatalf("cursor[%s] = %d, want %d (cursor must not regress across instances)", handle, got, wantCursor)
	}
	if len(document.Items) != len(wantIDs) {
		t.Fatalf("items = %d, want %d: %+v", len(document.Items), len(wantIDs), document.Items)
	}
	for index, wantID := range wantIDs {
		if document.Items[index].ID != wantID {
			t.Fatalf("item[%d] = %q, want %q", index, document.Items[index].ID, wantID)
		}
	}
	for index := 1; index < len(document.Items); index++ {
		if document.Items[index-1].TS < document.Items[index].TS {
			t.Fatalf("items are not sorted by ts descending at %d", index)
		}
	}
	sitWorkerITAssertTTL(t, client, telegramStateCacheKey, 24*time.Hour, time.Minute)
}

// TestSituationSignalsWorkerTelegramTwoInstanceIntegration covers B1: two worker
// processes (each with its own Manager and in-process scratch state) alternate
// queue jobs while sharing the real Redis document. Every cycle must resume from
// the persisted cursor/items, and an instance without the lease must not dial.
func TestSituationSignalsWorkerTelegramTwoInstanceIntegration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx := context.Background()

	channels := loadTelegramChannels("full")
	if len(channels) == 0 {
		t.Fatal("embedded Telegram channel catalog has no channels")
	}
	handle := channels[0].Handle
	effective := defaultEffectiveSettings(t)

	newInstance := func(id string) (*Service, *sitWorkerITLeaseOwner, *fakePollClient, *fakePublisher) {
		pollClient := newFakePollClient()
		owner := &sitWorkerITLeaseOwner{redis: client, id: id, client: pollClient}
		publisher := &fakePublisher{}
		service, err := New(Options{
			Redis:      client,
			Settings:   &fakeSettings{effective: effective},
			Telegram:   owner,
			Dispatcher: publisher,
			Env:        testEnv(),
			Logger:     func(string, ...any) {},
		})
		if err != nil {
			t.Fatalf("build worker instance %s: %v", id, err)
		}
		t.Cleanup(service.Close)
		return service, owner, pollClient, publisher
	}

	first, firstOwner, firstPoll, firstPublisher := newInstance("instance-a")
	second, secondOwner, secondPoll, secondPublisher := newInstance("instance-b")

	cumulative := []telegramclient.Message{
		{ID: 10, DateUnix: 1_700_000_010, Text: "first"},
		{ID: 11, DateUnix: 1_700_000_011, Text: "second"},
		{ID: 12, DateUnix: 1_700_000_012, Text: "third"},
		{ID: 13, DateUnix: 1_700_000_013, Text: "fourth"},
		{ID: 14, DateUnix: 1_700_000_014, Text: "fifth"},
	}

	// Round 1: instance A owns the lease and persists the first two messages.
	firstPoll.setMessages(handle, cumulative[:2]...)
	if err := first.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("instance A first job: %v", err)
	}
	sitWorkerITAssertTelegramState(t, client, handle, 11, []string{handle + ":11", handle + ":10"})
	if _, _, _, minIDs := firstPoll.stats(); len(minIDs) == 0 || minIDs[0] != 0 {
		t.Fatalf("instance A minID = %v, want 0 for the empty cache", minIDs)
	}
	if events := firstPublisher.snapshot(); len(events) != 1 || events[0].Type != RealtimeEventTelegramUpdate {
		t.Fatalf("instance A events = %+v", events)
	}

	// Lease contention: while A holds the lease, B must not dial and must leave the
	// shared document byte-identical. B2: the cycle is not dropped silently any
	// more — B publishes a poll request, and because no instance subscribes to the
	// handover channel in this test the lease is retried once (two skips).
	before := sitWorkerITRedisString(t, client, telegramStateCacheKey)
	if err := second.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("instance B contended job: %v", err)
	}
	if after := sitWorkerITRedisString(t, client, telegramStateCacheKey); after != before {
		t.Fatalf("state changed while the other instance held the lease")
	}
	if connects, skipped, _ := secondOwner.counts(); connects != 0 || skipped != 2 {
		t.Fatalf("instance B connects/skips = %d/%d, want 0/2 (the handover retries the lease once)", connects, skipped)
	}
	if events := secondPublisher.snapshot(); len(events) != 0 {
		t.Fatalf("instance B published while it did not own the lease: %+v", events)
	}

	// Round 2: A loses the lease (crash/shutdown), B takes over and must resume
	// from the cursor A persisted in Redis.
	firstOwner.release(t)
	secondPoll.setMessages(handle, cumulative[:3]...)
	if err := second.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("instance B first job: %v", err)
	}
	sitWorkerITAssertTelegramState(t, client, handle, 12, []string{handle + ":12", handle + ":11", handle + ":10"})
	if _, _, _, minIDs := secondPoll.stats(); len(minIDs) < len(channels) || minIDs[len(minIDs)-len(channels)] != 11 {
		t.Fatalf("instance B minID = %v, want the cursor 11 persisted by instance A", minIDs)
	}
	if events := secondPublisher.snapshot(); len(events) != 1 {
		t.Fatalf("instance B events = %+v", events)
	}

	// Round 3: A takes the lease back and continues from B's cursor.
	secondOwner.release(t)
	firstPoll.setMessages(handle, cumulative[:4]...)
	if err := first.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("instance A second job: %v", err)
	}
	sitWorkerITAssertTelegramState(t, client, handle, 13, []string{handle + ":13", handle + ":12", handle + ":11", handle + ":10"})
	if _, _, _, minIDs := firstPoll.stats(); len(minIDs) < 2*len(channels) || minIDs[len(minIDs)-len(channels)] != 12 {
		t.Fatalf("instance A minIDs = %v, want the second cycle to start at cursor 12", minIDs)
	}

	// Round 4: B finishes the sequence.
	firstOwner.release(t)
	secondPoll.setMessages(handle, cumulative...)
	if err := second.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("instance B second job: %v", err)
	}
	sitWorkerITAssertTelegramState(t, client, handle, 14, []string{
		handle + ":14", handle + ":13", handle + ":12", handle + ":11", handle + ":10",
	})
	secondOwner.release(t)

	// Only the lease owner built a connection: two connects per instance over
	// four rounds, and the contended cycle is the only skip.
	if connects, skipped, _ := firstOwner.counts(); connects != 2 || skipped != 0 {
		t.Fatalf("instance A connects/skips = %d/%d, want 2/0", connects, skipped)
	}
	if connects, skipped, _ := secondOwner.counts(); connects != 2 || skipped != 2 {
		t.Fatalf("instance B connects/skips = %d/%d, want 2/2", connects, skipped)
	}
	firstFingerprint := firstOwner.fingerprintValue()
	secondFingerprint := secondOwner.fingerprintValue()
	if firstFingerprint == "" || firstFingerprint != secondFingerprint || !sitWorkerITFingerprint.MatchString(firstFingerprint) {
		t.Fatalf("credential fingerprints = %q/%q", firstFingerprint, secondFingerprint)
	}
	if events := firstPublisher.snapshot(); len(events) != 2 {
		t.Fatalf("instance A event count = %d, want 2", len(events))
	}
	if events := secondPublisher.snapshot(); len(events) != 2 {
		t.Fatalf("instance B event count = %d, want 2", len(events))
	}
}

// TestSituationSignalsWorkerTelegramManagerLeaseIntegration exercises the real
// telegramclient.Manager lease against Redis (B1) without any MTProto dial: the
// invalid API id makes client creation fail before Run, so the callback never
// runs and no socket is opened.
func TestSituationSignalsWorkerTelegramManagerLeaseIntegration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	callbacks := 0
	callback := func(context.Context, telegramclient.PollClient) error {
		callbacks++
		return nil
	}
	// APIID 0 fails validation inside New before any network I/O happens.
	invalidCredentials := telegramclient.Options{APIID: 0, APIHash: "integration-test-invalid"}

	first := telegramclient.NewManager(client, telegramclient.DefaultLeaseKey, 900*time.Millisecond)
	defer first.Close()
	owned, err := first.WithLease(ctx, invalidCredentials, "fingerprint-a", callback)
	if !owned {
		t.Fatalf("first manager did not acquire the lease")
	}
	if err == nil {
		t.Fatalf("invalid credentials must fail client creation")
	}
	if callbacks != 0 {
		t.Fatalf("callback ran without a client")
	}
	if exists, existsErr := client.Exists(ctx, telegramclient.DefaultLeaseKey).Result(); existsErr != nil || exists != 1 {
		t.Fatalf("lease key exists = %d, err = %v (the manager must hold the lease)", exists, existsErr)
	}

	second := telegramclient.NewManager(client, telegramclient.DefaultLeaseKey, 900*time.Millisecond)
	defer second.Close()
	owned, err = second.WithLease(ctx, invalidCredentials, "fingerprint-b", callback)
	if owned || err != nil {
		t.Fatalf("second manager with the lease held: owned=%t err=%v, want false/nil", owned, err)
	}
	if callbacks != 0 {
		t.Fatalf("callback ran for the manager without the lease")
	}

	// Disconnect releases the token-checked lease and keeps the manager usable.
	if err := first.Disconnect(ctx); err != nil {
		t.Fatalf("disconnect first manager: %v", err)
	}
	if exists, existsErr := client.Exists(ctx, telegramclient.DefaultLeaseKey).Result(); existsErr != nil || exists != 0 {
		t.Fatalf("lease key after Disconnect exists = %d, err = %v", exists, existsErr)
	}
	owned, err = second.WithLease(ctx, invalidCredentials, "fingerprint-b", callback)
	if !owned || err == nil {
		t.Fatalf("second manager after release: owned=%t err=%v, want true with a creation error", owned, err)
	}
	if callbacks != 0 {
		t.Fatalf("callback ran even though client creation failed")
	}
	if err := second.Disconnect(ctx); err != nil {
		t.Fatalf("disconnect second manager: %v", err)
	}

	// Close is the terminal hook: later calls report ErrManagerClosed.
	second.Close()
	if _, closeErr := second.WithLease(ctx, invalidCredentials, "fingerprint-b", callback); !errors.Is(closeErr, telegramclient.ErrManagerClosed) {
		t.Fatalf("WithLease after Close error = %v, want ErrManagerClosed", closeErr)
	}
}

// ---- OREF B3: real HTTP proxy + upstream + Redis documents + event bridge ----

// sitWorkerITOrefProxyRequest is one request the proxy forwarded.
type sitWorkerITOrefProxyRequest struct {
	Path          string
	Accept        string
	Referer       string
	RequestedWith string
}

// sitWorkerITOrefProxy is an HTTP proxy with Basic auth that forwards to the
// OREF upstream httptest server. It records the headers http.Client sends
// through the worker's proxied OREF client.
type sitWorkerITOrefProxy struct {
	upstream  *httptest.Server
	user      string
	pass      string
	transport *http.Transport

	mu           sync.Mutex
	requests     []sitWorkerITOrefProxyRequest
	authFailures int
}

func newSitWorkerITOrefProxy(upstream *httptest.Server) *sitWorkerITOrefProxy {
	return &sitWorkerITOrefProxy{
		upstream:  upstream,
		user:      "oref-user",
		pass:      "oref-pass",
		transport: &http.Transport{Proxy: nil},
	}
}

func (p *sitWorkerITOrefProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte(p.user+":"+p.pass))

	p.mu.Lock()
	p.requests = append(p.requests, sitWorkerITOrefProxyRequest{
		Path:          r.URL.Path,
		Accept:        r.Header.Get("Accept"),
		Referer:       r.Header.Get("Referer"),
		RequestedWith: r.Header.Get("X-Requested-With"),
	})
	if r.Header.Get("Proxy-Authorization") != expected {
		p.authFailures++
		p.mu.Unlock()
		w.WriteHeader(http.StatusProxyAuthRequired)
		return
	}
	p.mu.Unlock()

	outbound, err := http.NewRequestWithContext(r.Context(), r.Method, p.upstream.URL+r.URL.Path, nil)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	outbound.Header.Set("Accept", r.Header.Get("Accept"))
	outbound.Header.Set("Referer", r.Header.Get("Referer"))
	outbound.Header.Set("X-Requested-With", r.Header.Get("X-Requested-With"))

	response, err := p.transport.RoundTrip(outbound)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	defer func() { _ = response.Body.Close() }()
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func (p *sitWorkerITOrefProxy) snapshot() ([]sitWorkerITOrefProxyRequest, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]sitWorkerITOrefProxyRequest(nil), p.requests...), p.authFailures
}

func sitWorkerITLoadOrefAlerts(t *testing.T, client *redis.Client) orefAlertsDocument {
	t.Helper()
	raw := sitWorkerITRedisString(t, client, orefAlertsCacheKey)
	var document orefAlertsDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode OREF alerts document %s: %v", raw, err)
	}
	return document
}

func sitWorkerITLoadOrefHistory(t *testing.T, client *redis.Client) orefHistoryDocument {
	t.Helper()
	raw := sitWorkerITRedisString(t, client, orefHistoryCacheKey)
	var document orefHistoryDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode OREF history document %s: %v", raw, err)
	}
	return document
}

func sitWorkerITLoadOrefMetrics(t *testing.T, client *redis.Client) orefMetricsDocument {
	t.Helper()
	raw := sitWorkerITRedisString(t, client, orefMetricsCacheKey)
	var document orefMetricsDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode OREF metrics document %s: %v", raw, err)
	}
	return document
}

// TestSituationSignalsWorkerOrefB3Integration covers B3 plus the A6 event
// bridge: a non-2xx response or a 200 HTML error page is a failed poll that must
// keep the previous alerts/history/metrics documents and publish no event, while
// a valid body updates all three documents and the realtime channel.
func TestSituationSignalsWorkerOrefB3Integration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	upstream := newOrefServer()
	upstreamServer := httptest.NewServer(upstream)
	defer upstreamServer.Close()

	proxy := newSitWorkerITOrefProxy(upstreamServer)
	proxyServer := httptest.NewServer(proxy)
	defer proxyServer.Close()

	proxyAuth := proxy.user + ":" + proxy.pass + "@" + strings.TrimPrefix(proxyServer.URL, "http://")
	env := sitWorkerITEnv(map[string]string{
		"SITUATION_MONITOR_OREF_ENABLED":               "true",
		"SITUATION_MONITOR_OREF_PROXY_AUTH":            proxyAuth,
		"SITUATION_MONITOR_OREF_ALERTS_URL":            upstreamServer.URL + "/alerts",
		"SITUATION_MONITOR_OREF_HISTORY_URL":           upstreamServer.URL + "/history",
		"SITUATION_MONITOR_OREF_CURL_TIMEOUT_SEC":      "5",
		"SITUATION_MONITOR_OREF_BOOTSTRAP_MAX_RETRIES": "1",
	})

	service, err := New(Options{
		Redis:    client,
		Settings: &fakeSettings{effective: defaultEffectiveSettings(t)},
		Telegram: sitWorkerITUnusedTelegram{},
		Env:      env,
		Logger:   func(string, ...any) {},
	})
	if err != nil {
		t.Fatalf("build OREF worker: %v", err)
	}
	defer service.Close()

	subscription := client.Subscribe(ctx, RealtimeEventsChannel)
	defer func() { _ = subscription.Close() }()
	if _, err := subscription.Receive(ctx); err != nil {
		t.Fatalf("subscribe to %s: %v", RealtimeEventsChannel, err)
	}

	runCycle := func() {
		t.Helper()
		if err := service.HandleJob(ctx, SourceOref); err != nil {
			t.Fatalf("OREF HandleJob error = %v", err)
		}
	}

	// (a) "[]" means no active alerts: no event, empty documents.
	upstream.setAlerts("[]", http.StatusOK)
	runCycle()
	sitWorkerITAssertNoMessage(t, subscription)
	emptyAlerts := sitWorkerITLoadOrefAlerts(t, client)
	if emptyAlerts.Scope != "global" || !emptyAlerts.Configured {
		t.Fatalf("alerts document header = %+v", emptyAlerts)
	}
	if len(emptyAlerts.Alerts) != 0 || emptyAlerts.Error != nil {
		t.Fatalf("alerts document = %+v, want an empty alert list without error", emptyAlerts)
	}
	if emptyAlerts.HistoryCount24h != 0 || emptyAlerts.TotalHistoryCount != 0 {
		t.Fatalf("empty alert counts = %d/%d", emptyAlerts.HistoryCount24h, emptyAlerts.TotalHistoryCount)
	}
	if history := sitWorkerITLoadOrefHistory(t, client); len(history.History) != 0 || !history.Configured {
		t.Fatalf("history document = %+v", history)
	}
	if metrics := sitWorkerITLoadOrefMetrics(t, client); metrics.ActiveAlerts != 0 || metrics.HistoryCount24h != 0 {
		t.Fatalf("metrics document = %+v", metrics)
	}
	sitWorkerITAssertTTL(t, client, orefAlertsCacheKey, time.Hour, time.Minute)
	sitWorkerITAssertTTL(t, client, orefHistoryCacheKey, 7*24*time.Hour, time.Minute)
	sitWorkerITAssertTTL(t, client, orefMetricsCacheKey, 7*24*time.Hour, time.Minute)

	// The bootstrap history request and the alerts request went through the
	// authenticated proxy with the NestJS curl headers.
	if alerts, history := upstream.counts(); alerts != 1 || history != 1 {
		t.Fatalf("upstream requests = %d alerts / %d history, want 1/1", alerts, history)
	}

	// (b) two real alerts: documents, history entry and a precise event payload.
	rawAlertOne := `{"id": "alert-1", "cat": "1", "title": "Rocket fire", "data": ["Tel Aviv", "Haifa"], "desc": "desc-1", "alertDate": "2026-10-20 12:00:00"}`
	rawAlertTwo := `{"id": "alert-2", "cat": "2", "title": "UAV intrusion", "data": ["Ashkelon"], "desc": "", "alertDate": "2026-10-20 12:05:00"}`
	compactedOne, err := compactJSON([]byte(rawAlertOne))
	if err != nil {
		t.Fatalf("compact alert one: %v", err)
	}
	compactedTwo, err := compactJSON([]byte(rawAlertTwo))
	if err != nil {
		t.Fatalf("compact alert two: %v", err)
	}
	expectedAlerts := []string{string(compactedOne), string(compactedTwo)}
	upstream.setAlerts("["+rawAlertOne+","+rawAlertTwo+"\n]", http.StatusOK)
	runCycle()

	message := sitWorkerITNextMessage(t, subscription)
	if message.Channel != RealtimeEventsChannel {
		t.Fatalf("event channel = %q, want %q", message.Channel, RealtimeEventsChannel)
	}
	envelope := regexp.MustCompile(`^\{"version":1,"type":"situation:oref\.update","payload":(\{.*\}),"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"\}$`)
	parts := envelope.FindStringSubmatch(message.Payload)
	if len(parts) != 3 {
		t.Fatalf("event envelope = %s, want exact version/type/payload/timestamp order", message.Payload)
	}
	if !sitWorkerITISOTimestamp.MatchString(parts[2]) {
		t.Fatalf("event timestamp = %q", parts[2])
	}
	payloadBytes := []byte(parts[1])
	if !strings.HasPrefix(string(payloadBytes), `{"alerts":[`) {
		t.Fatalf("event payload = %s, want alerts first", payloadBytes)
	}
	var payload orefUpdatePayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	if len(payload.Alerts) != 2 {
		t.Fatalf("event alerts = %d, want 2", len(payload.Alerts))
	}
	for index, want := range expectedAlerts {
		if got := string(payload.Alerts[index]); got != want {
			t.Fatalf("event alert[%d] = %s, want %s (must mirror the upstream bytes)", index, got, want)
		}
	}
	if payload.HistoryCount24h != 3 || payload.TotalHistoryCount != 3 {
		t.Fatalf("event counts = %d/%d, want 3/3 (2+1 alert areas)", payload.HistoryCount24h, payload.TotalHistoryCount)
	}
	if payload.HistoryEntry == nil {
		t.Fatal("event historyEntry = null, want the new wave")
	}
	if len(payload.HistoryEntry.Alerts) != 2 || string(payload.HistoryEntry.Alerts[0]) != expectedAlerts[0] {
		t.Fatalf("event historyEntry alerts = %+v", payload.HistoryEntry.Alerts)
	}
	if !sitWorkerITISOTimestamp.MatchString(payload.UpdatedAt) {
		t.Fatalf("event updatedAt = %q", payload.UpdatedAt)
	}

	alertsDocument := sitWorkerITLoadOrefAlerts(t, client)
	if len(alertsDocument.Alerts) != 2 {
		t.Fatalf("alerts document = %+v", alertsDocument)
	}
	for index, want := range expectedAlerts {
		if got := string(alertsDocument.Alerts[index]); got != want {
			t.Fatalf("alerts document alert[%d] = %s, want %s", index, got, want)
		}
	}
	if alertsDocument.HistoryCount24h != 3 || alertsDocument.TotalHistoryCount != 3 {
		t.Fatalf("alerts document counts = %d/%d", alertsDocument.HistoryCount24h, alertsDocument.TotalHistoryCount)
	}
	if alertsDocument.Timestamp != payload.UpdatedAt {
		t.Fatalf("alerts timestamp = %q, payload updatedAt = %q", alertsDocument.Timestamp, payload.UpdatedAt)
	}
	if alertsDocument.Error != nil {
		t.Fatalf("alerts document error = %q", *alertsDocument.Error)
	}

	historyDocument := sitWorkerITLoadOrefHistory(t, client)
	if len(historyDocument.History) != 1 {
		t.Fatalf("history waves = %d, want 1", len(historyDocument.History))
	}
	if len(historyDocument.History[0].Alerts) != 2 || string(historyDocument.History[0].Alerts[0]) != expectedAlerts[0] {
		t.Fatalf("history wave = %+v", historyDocument.History[0])
	}
	if !sitWorkerITISOTimestamp.MatchString(historyDocument.History[0].Timestamp) {
		t.Fatalf("history wave timestamp = %q", historyDocument.History[0].Timestamp)
	}
	if historyDocument.Timestamp != payload.UpdatedAt {
		t.Fatalf("history timestamp = %q, payload updatedAt = %q", historyDocument.Timestamp, payload.UpdatedAt)
	}

	metricsDocument := sitWorkerITLoadOrefMetrics(t, client)
	if metricsDocument.ActiveAlerts != 2 || metricsDocument.HistoryCount24h != 3 || metricsDocument.UpdatedAt != payload.UpdatedAt {
		t.Fatalf("metrics document = %+v", metricsDocument)
	}

	// (c) HTTP 200 with an HTML error page: a failed poll keeps every document
	// and publishes no event (B3).
	alertsBefore := sitWorkerITRedisString(t, client, orefAlertsCacheKey)
	historyBefore := sitWorkerITRedisString(t, client, orefHistoryCacheKey)
	metricsBefore := sitWorkerITRedisString(t, client, orefMetricsCacheKey)
	upstream.setAlerts("<html><body>Bad Gateway</body></html>", http.StatusOK)
	runCycle()
	sitWorkerITAssertNoMessage(t, subscription)
	if got := sitWorkerITRedisString(t, client, orefAlertsCacheKey); got != alertsBefore {
		t.Fatalf("alerts document changed after an invalid 200 body:\n%s\n%s", alertsBefore, got)
	}
	if got := sitWorkerITRedisString(t, client, orefHistoryCacheKey); got != historyBefore {
		t.Fatalf("history document changed after an invalid 200 body")
	}
	if got := sitWorkerITRedisString(t, client, orefMetricsCacheKey); got != metricsBefore {
		t.Fatalf("metrics document changed after an invalid 200 body")
	}

	// (d) HTTP 500 with an HTML body: same failure semantics.
	upstream.setAlerts("<html><body>Internal Server Error</body></html>", http.StatusInternalServerError)
	runCycle()
	sitWorkerITAssertNoMessage(t, subscription)
	if got := sitWorkerITRedisString(t, client, orefAlertsCacheKey); got != alertsBefore {
		t.Fatalf("alerts document changed after an HTTP 500")
	}
	if got := sitWorkerITRedisString(t, client, orefHistoryCacheKey); got != historyBefore {
		t.Fatalf("history document changed after an HTTP 500")
	}
	if got := sitWorkerITRedisString(t, client, orefMetricsCacheKey); got != metricsBefore {
		t.Fatalf("metrics document changed after an HTTP 500")
	}

	// (e) An empty body still means "no active alerts": the alert list is
	// cleared and the change is published without a history entry.
	upstream.setAlerts("", http.StatusOK)
	runCycle()
	cleared := sitWorkerITNextMessage(t, subscription)
	clearedParts := envelope.FindStringSubmatch(cleared.Payload)
	if len(clearedParts) != 3 {
		t.Fatalf("cleared event envelope = %s", cleared.Payload)
	}
	var clearedPayload orefUpdatePayload
	if err := json.Unmarshal([]byte(clearedParts[1]), &clearedPayload); err != nil {
		t.Fatalf("decode cleared event payload: %v", err)
	}
	if len(clearedPayload.Alerts) != 0 {
		t.Fatalf("cleared event alerts = %+v", clearedPayload.Alerts)
	}
	if clearedPayload.HistoryEntry != nil {
		t.Fatalf("cleared event historyEntry = %+v, want null", clearedPayload.HistoryEntry)
	}
	if clearedPayload.HistoryCount24h != 3 || clearedPayload.TotalHistoryCount != 3 {
		t.Fatalf("cleared event kept counts = %d/%d, want the previous waves", clearedPayload.HistoryCount24h, clearedPayload.TotalHistoryCount)
	}
	if clearedDocument := sitWorkerITLoadOrefAlerts(t, client); len(clearedDocument.Alerts) != 0 || clearedDocument.Error != nil {
		t.Fatalf("cleared alerts document = %+v", clearedDocument)
	}
	if clearedMetrics := sitWorkerITLoadOrefMetrics(t, client); clearedMetrics.ActiveAlerts != 0 {
		t.Fatalf("cleared metrics = %+v", clearedMetrics)
	}

	// Every request reached the proxy with Basic auth and the NestJS headers.
	requests, authFailures := proxy.snapshot()
	if authFailures != 0 {
		t.Fatalf("proxy rejected %d unauthenticated requests", authFailures)
	}
	if alerts, history := upstream.counts(); alerts != 5 || history != 1 {
		t.Fatalf("upstream requests = %d alerts / %d history, want 5/1", alerts, history)
	}
	for _, request := range requests {
		if request.Path != "/alerts" && request.Path != "/history" {
			t.Fatalf("proxy received unexpected path %q", request.Path)
		}
		if request.Accept != orefAcceptHeader {
			t.Fatalf("OREF Accept header = %q, want %q", request.Accept, orefAcceptHeader)
		}
		if request.Referer != orefAlertsReferer {
			t.Fatalf("OREF Referer header = %q, want %q", request.Referer, orefAlertsReferer)
		}
		if request.RequestedWith != orefRequestedWith {
			t.Fatalf("OREF X-Requested-With header = %q, want %q", request.RequestedWith, orefRequestedWith)
		}
	}
}

// ---- A6: realtime event bridge wire format ----

// TestSituationSignalsWorkerEventBridgeIntegration pins the exact event
// envelope: version, type, payload and a millisecond ISO timestamp, in this
// order, as consumed by the NestJS subscriber.
func TestSituationSignalsWorkerEventBridgeIntegration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	publisher := NewRedisEventPublisher(client)
	pattern := "situation-monitor:signals:events:*"
	subscription := client.PSubscribe(ctx, pattern)
	defer func() { _ = subscription.Close() }()
	if _, err := subscription.Receive(ctx); err != nil {
		t.Fatalf("psubscribe %s: %v", pattern, err)
	}

	// A fixed timestamp makes the envelope byte-comparable.
	payload := json.RawMessage(`{"alerts":[],"historyCount24h":0,"totalHistoryCount":0,"updatedAt":"2026-01-02T03:04:05.678Z","historyEntry":null}`)
	fixed := "2026-01-02T03:04:05.678Z"
	if err := publisher.Publish(ctx, RealtimeEvent{
		Version:   realtimeEventVersion,
		Type:      RealtimeEventOrefUpdate,
		Payload:   payload,
		Timestamp: fixed,
	}); err != nil {
		t.Fatalf("publish fixed-timestamp event: %v", err)
	}
	message := sitWorkerITNextMessage(t, subscription)
	if message.Channel != RealtimeEventsChannel || message.Pattern != pattern {
		t.Fatalf("message channel/pattern = %q/%q", message.Channel, message.Pattern)
	}
	want := `{"version":1,"type":"situation:oref.update","payload":` + string(payload) + `,"timestamp":"` + fixed + `"}`
	if message.Payload != want {
		t.Fatalf("event payload = %s, want %s", message.Payload, want)
	}

	// An empty Timestamp is stamped by the publisher with the ISO millisecond
	// form both implementations write.
	if err := publisher.Publish(ctx, RealtimeEvent{
		Version: realtimeEventVersion,
		Type:    RealtimeEventTelegramUpdate,
		Payload: json.RawMessage(`{"count":0,"updatedAt":"2026-01-02T03:04:05.678Z","items":[]}`),
	}); err != nil {
		t.Fatalf("publish auto-timestamp event: %v", err)
	}
	auto := sitWorkerITNextMessage(t, subscription)
	autoPattern := regexp.MustCompile(`^\{"version":1,"type":"situation:telegram\.update","payload":\{"count":0,"updatedAt":"2026-01-02T03:04:05\.678Z","items":\[\]\},"timestamp":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}$`)
	if !autoPattern.MatchString(auto.Payload) {
		t.Fatalf("auto-timestamped event = %s", auto.Payload)
	}
}

// ---- A2: cross-instance Telegram clear broadcast ----

// TestSituationSignalsWorkerClearBroadcastIntegration runs the real Redis
// subscriber loop and proves the clear broadcast disconnects the fake owner and
// deletes the state document, while malformed/version-mismatched messages are
// ignored.
func TestSituationSignalsWorkerClearBroadcastIntegration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	owner := &sitWorkerITLeaseOwner{redis: client, id: "clear-broadcast"}
	ready := make(chan struct{}, 1)
	service, err := New(Options{
		Redis:      client,
		Settings:   &fakeSettings{effective: defaultEffectiveSettings(t)},
		Telegram:   owner,
		Dispatcher: &fakePublisher{},
		Env:        testEnv(),
		Logger: func(format string, _ ...any) {
			if strings.Contains(format, "subscribed to") {
				select {
				case ready <- struct{}{}:
				default:
				}
			}
		},
	})
	if err != nil {
		t.Fatalf("build clear-broadcast worker: %v", err)
	}
	runDone := make(chan error, 1)
	go func() { runDone <- service.Run(ctx) }()
	defer func() {
		cancel()
		service.Close()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Fatal("Service.Run did not stop after cancellation")
		}
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not subscribe to the clear broadcast")
	}

	seedState := func() {
		t.Helper()
		document := `{"channelSet":"full","cursorByHandle":{"VahidOnline":7},"items":[{"id":"VahidOnline:7"}],"lastPollAt":7,"lastError":null}`
		if err := client.Set(ctx, telegramStateCacheKey, document, time.Hour).Err(); err != nil {
			t.Fatalf("seed telegram state: %v", err)
		}
	}

	seedState()
	if err := client.Publish(ctx, clearBroadcastChannel, `{"version":1,"clearItems":true}`).Err(); err != nil {
		t.Fatalf("publish clear broadcast: %v", err)
	}
	sitWorkerITWaitKeyGone(t, client, telegramStateCacheKey)
	if _, _, disconnects := owner.counts(); disconnects != 1 {
		t.Fatalf("disconnect calls = %d, want 1", disconnects)
	}
	service.mu.Lock()
	channelSet := service.telegramState.ChannelSet
	items := len(service.telegramState.Items)
	lastPollAt := service.telegramState.LastPollAt
	service.mu.Unlock()
	if channelSet != nil || items != 0 || lastPollAt != 0 {
		t.Fatalf("local state after clear = %v/%d/%d", channelSet, items, lastPollAt)
	}

	// Malformed and version-mismatched messages are ignored.
	seedState()
	if err := client.Publish(ctx, clearBroadcastChannel, `{"version":2,"clearItems":true}`).Err(); err != nil {
		t.Fatalf("publish version mismatch: %v", err)
	}
	if err := client.Publish(ctx, clearBroadcastChannel, `not json`).Err(); err != nil {
		t.Fatalf("publish malformed broadcast: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if exists, err := client.Exists(ctx, telegramStateCacheKey).Result(); err != nil || exists != 1 {
		t.Fatalf("state key after ignored broadcasts: exists=%d err=%v", exists, err)
	}
	if _, _, disconnects := owner.counts(); disconnects != 1 {
		t.Fatalf("disconnect calls after ignored broadcasts = %d, want 1", disconnects)
	}

	// clearItems=false still deletes the shared document and disconnects the
	// connection (the feed retention only concerns the in-process buffer).
	if err := client.Publish(ctx, clearBroadcastChannel, `{"version":1,"clearItems":false}`).Err(); err != nil {
		t.Fatalf("publish clearItems=false: %v", err)
	}
	sitWorkerITWaitKeyGone(t, client, telegramStateCacheKey)
	if _, _, disconnects := owner.counts(); disconnects != 2 {
		t.Fatalf("disconnect calls after second clear = %d, want 2", disconnects)
	}
}

// ---- A4/A5: repeatable job registration ----

// TestSituationSignalsWorkerRepeatablesIntegration asserts the BullMQ keys
// EnsureRepeatables installs for the OREF repeat and the Telegram JobScheduler,
// against the real Redis the Node producer/worker consume.
func TestSituationSignalsWorkerRepeatablesIntegration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx := context.Background()

	const (
		orefEvery = 300_000
		queueBase = QueuePrefix + ":" + QueueName
		repeatKey = queueBase + ":repeat"
	)
	telegramDisabled := RepeatablesConfig{TelegramEnabled: false, TelegramIntervalMS: 0, OrefIntervalMS: orefEvery}
	if err := EnsureRepeatables(ctx, client, telegramDisabled); err != nil {
		t.Fatalf("EnsureRepeatables(telegram disabled): %v", err)
	}

	// The legacy Oref repeat protocol: a zset member scored with the next epoch
	// aligned iteration and a repeat hash carrying the schedule.
	repeatHash := hashRepeatKey(repeatConcatOptions(OrefPollJobName, orefRepeatJobID, orefEvery))
	if repeatHash != "6b648cafe515bda8b978dcbd05bdb090" {
		t.Fatalf("oref repeat hash = %q", repeatHash)
	}
	score, err := client.ZScore(ctx, repeatKey, repeatHash).Result()
	if err != nil {
		t.Fatalf("oref repeat zset member: %v", err)
	}
	nextMillis := int64(score)
	if nextMillis <= 0 || nextMillis%orefEvery != 0 {
		t.Fatalf("oref repeat score = %d, want an epoch aligned %d ms iteration", nextMillis, orefEvery)
	}
	repeatFields, err := client.HGetAll(ctx, repeatKey+":"+repeatHash).Result()
	if err != nil {
		t.Fatalf("oref repeat hash: %v", err)
	}
	if repeatFields["name"] != OrefPollJobName || repeatFields["every"] != "300000" {
		t.Fatalf("oref repeat hash = %v", repeatFields)
	}

	// The first iteration was added as a delayed job with the Queue
	// defaultJobOptions merged in.
	iterationID := repeatDelayedJobID(repeatHash, nextMillis)
	iterationKey := queueBase + ":" + iterationID
	iterationFields, err := client.HGetAll(ctx, iterationKey).Result()
	if err != nil {
		t.Fatalf("oref repeat iteration hash: %v", err)
	}
	if iterationFields["name"] != OrefPollJobName {
		t.Fatalf("oref iteration name = %q", iterationFields["name"])
	}
	if iterationFields["data"] != `{"type":"poll","source":"oref"}` {
		t.Fatalf("oref iteration data = %s", iterationFields["data"])
	}
	if !strings.Contains(iterationFields["opts"], `"repeatJobKey":"`+repeatHash+`"`) {
		t.Fatalf("oref iteration opts = %s", iterationFields["opts"])
	}
	if !strings.Contains(iterationFields["opts"], `"attempts":3`) ||
		!strings.Contains(iterationFields["opts"], `"removeOnComplete":true`) ||
		!strings.Contains(iterationFields["opts"], `"type":"exponential"`) {
		t.Fatalf("oref iteration default options missing: %s", iterationFields["opts"])
	}
	delayedScore, err := client.ZScore(ctx, queueBase+":delayed", iterationID).Result()
	if err != nil {
		t.Fatalf("delayed score: %v", err)
	}
	// BullMQ packs the delayed timestamp into the high bits of the score:
	// delayedTimestamp * 0x1000 (plus a small slot offset for collisions).
	if minimum, maximum := float64(nextMillis*0x1000), float64((nextMillis+1)*0x1000-1); delayedScore < minimum || delayedScore > maximum {
		t.Fatalf("delayed score = %v, want the %d millisecond slot", delayedScore, nextMillis)
	}

	// Telegram is disabled: no JobScheduler and no Telegram bootstrap job, but
	// the Oref bootstrap job is always enqueued for a fast first run.
	if _, err := client.ZScore(ctx, repeatKey, "telegram-poll:scheduler").Result(); !errors.Is(err, redis.Nil) {
		t.Fatalf("telegram scheduler must not exist when disabled: %v", err)
	}
	if id, fields := sitWorkerITFindJob(t, client, queueBase+":wait", TelegramPollJobName+":bootstrap"); id != "" {
		t.Fatalf("unexpected telegram bootstrap job %s (%v)", id, fields)
	}
	if id, fields := sitWorkerITFindJob(t, client, queueBase+":wait", OrefPollJobName+":bootstrap"); id == "" || fields["data"] != `{"type":"poll","source":"oref"}` {
		t.Fatalf("oref bootstrap job = %s (%v)", id, fields)
	}

	// Telegram enabled: the BullMQ 5 JobScheduler is upserted and its initial
	// iteration plus the bootstrap job are written.
	if err := EnsureRepeatables(ctx, client, RepeatablesConfig{
		TelegramEnabled:    true,
		TelegramIntervalMS: 60_000,
		OrefIntervalMS:     orefEvery,
	}); err != nil {
		t.Fatalf("EnsureRepeatables(telegram enabled): %v", err)
	}
	if _, err := client.ZScore(ctx, repeatKey, "telegram-poll:scheduler").Result(); err != nil {
		t.Fatalf("telegram scheduler zset member: %v", err)
	}
	schedulerFields, err := client.HGetAll(ctx, repeatKey+":telegram-poll:scheduler").Result()
	if err != nil {
		t.Fatalf("telegram scheduler hash: %v", err)
	}
	if schedulerFields["name"] != TelegramPollJobName || schedulerFields["every"] != "60000" {
		t.Fatalf("telegram scheduler hash = %v", schedulerFields)
	}
	if schedulerFields["data"] != `{"type":"poll","source":"telegram"}` {
		t.Fatalf("telegram scheduler data = %s", schedulerFields["data"])
	}
	if id, fields := sitWorkerITFindJob(t, client, queueBase+":wait", TelegramPollJobName+":bootstrap"); id == "" || fields["data"] != `{"type":"poll","source":"telegram"}` {
		t.Fatalf("telegram bootstrap job = %s (%v)", id, fields)
	}
	// The Oref schedule survives the Telegram upsert.
	if _, err := client.ZScore(ctx, repeatKey, repeatHash).Result(); err != nil {
		t.Fatalf("oref repeat removed by the telegram upsert: %v", err)
	}
}

// sitWorkerITFindJob returns the id and hash of the first queued job named name,
// or empty values when it does not exist.
func sitWorkerITFindJob(t *testing.T, client *redis.Client, listKey, name string) (string, map[string]string) {
	t.Helper()
	ctx := context.Background()
	ids, err := client.LRange(ctx, listKey, 0, -1).Result()
	if err != nil {
		t.Fatalf("lrange %s: %v", listKey, err)
	}
	for _, id := range ids {
		fields, err := client.HGetAll(ctx, QueuePrefix+":"+QueueName+":"+id).Result()
		if err != nil {
			t.Fatalf("hgetall job %s: %v", id, err)
		}
		if fields["name"] == name {
			return id, fields
		}
	}
	return "", nil
}

// ---- MySQL: OREF default alert rules ----

const sitWorkerITOrgTableSchema = "CREATE TABLE IF NOT EXISTS `Org` (" +
	"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
	"`isActive` BOOLEAN NOT NULL DEFAULT true," +
	"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
	"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

const sitWorkerITAlertRuleTableSchema = "CREATE TABLE IF NOT EXISTS `AlertRule` (" +
	"`id` VARCHAR(191) NOT NULL," +
	"`orgId` VARCHAR(191) NOT NULL," +
	"`name` VARCHAR(191) NOT NULL," +
	"`description` VARCHAR(191) NULL," +
	"`severity` VARCHAR(16) NOT NULL DEFAULT 'medium'," +
	"`status` VARCHAR(16) NOT NULL DEFAULT 'active'," +
	"`metricProvider` VARCHAR(32) NOT NULL DEFAULT 'economic_data'," +
	"`dataItemId` VARCHAR(191) NULL," +
	"`metricSlug` VARCHAR(191) NOT NULL," +
	"`operator` VARCHAR(32) NOT NULL," +
	"`thresholdValue` DECIMAL(38, 12) NULL," +
	"`thresholdLower` DECIMAL(38, 12) NULL," +
	"`thresholdUpper` DECIMAL(38, 12) NULL," +
	"`changeWindowMin` INT NULL," +
	"`cooldownSeconds` INT NOT NULL DEFAULT 3600," +
	"`checkIntervalSec` INT NOT NULL DEFAULT 300," +
	"`lastTriggeredAt` DATETIME(3) NULL," +
	"`metadata` JSON NULL," +
	"`createdById` VARCHAR(191) NULL," +
	"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"`updatedAt` DATETIME(3) NOT NULL," +
	"PRIMARY KEY (`id`)," +
	"KEY `AlertRule_org_provider_slug_idx` (`orgId`, `metricProvider`, `metricSlug`)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

// TestSituationSignalsWorkerOrefAlertRulesMySQLIntegration covers the OREF
// default alert rules against real MySQL and Redis: the two system-metric rules
// are created once per tick-gate interval, the evaluation jobs are enqueued for
// every active rule, and a second pass neither duplicates rows nor dedupes the
// evaluations.
func TestSituationSignalsWorkerOrefAlertRulesMySQLIntegration(t *testing.T) {
	db := sitWorkerITMySQL(t)
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	const orgID = "it-org-situation-signals-worker"
	// The dedicated database is empty, so this org is the only active
	// organization the default-rule maintenance can fan out to.
	t.Cleanup(func() { _ = client.Del(context.Background(), orefDefaultRuleTickGateKey).Err() })

	for _, statement := range []string{sitWorkerITOrgTableSchema, sitWorkerITAlertRuleTableSchema} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create schema: %v", err)
		}
	}
	if _, err := db.ExecContext(ctx,
		"INSERT INTO `Org` (`id`, `name`, `slug`, `isActive`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, 1, NOW(3), NOW(3))",
		orgID, "Situation Signals Worker Integration", orgID,
	); err != nil {
		t.Fatalf("insert org: %v", err)
	}

	alerts := &fakeAlertEnqueuer{}
	service, err := New(Options{
		DB:         db,
		Redis:      client,
		Settings:   &fakeSettings{effective: defaultEffectiveSettings(t)},
		Telegram:   sitWorkerITUnusedTelegram{},
		Alerts:     alerts,
		Dispatcher: &fakePublisher{},
		Env:        testEnv(),
		Logger:     func(string, ...any) {},
	})
	if err != nil {
		t.Fatalf("build alert-rules worker: %v", err)
	}
	defer service.Close()

	if err := service.triggerOrefAlertChecks(ctx); err != nil {
		t.Fatalf("triggerOrefAlertChecks: %v", err)
	}

	type expectedRule struct {
		slug      string
		severity  string
		threshold float64
	}
	expectedRules := []expectedRule{
		{slug: orefActiveAlertsMetricSlug, severity: "high", threshold: 1},
		{slug: orefHistory24hMetricSlug, severity: "medium", threshold: 25},
	}
	rows, err := db.QueryContext(ctx,
		"SELECT `id`, `severity`, `status`, `metricProvider`, `metricSlug`, `operator`, `thresholdValue`, "+
			"`changeWindowMin`, `cooldownSeconds`, `checkIntervalSec`, `metadata` "+
			"FROM `AlertRule` WHERE `orgId` = ? ORDER BY `metricSlug` ASC", orgID)
	if err != nil {
		t.Fatalf("query alert rules: %v", err)
	}
	var storedRules []expectedRule
	var storedIDs []string
	for rows.Next() {
		var id, severity, status, provider, slug, operator string
		var threshold sql.NullString
		var changeWindow, cooldown, checkInterval int
		var metadata []byte
		if err := rows.Scan(&id, &severity, &status, &provider, &slug, &operator, &threshold,
			&changeWindow, &cooldown, &checkInterval, &metadata); err != nil {
			_ = rows.Close()
			t.Fatalf("scan alert rule: %v", err)
		}
		if status != orefDefaultRuleStatusActive || provider != orefSystemMetricProvider || operator != orefDefaultRuleOperatorGte {
			t.Fatalf("rule %s fields = %s/%s/%s", slug, status, provider, operator)
		}
		if changeWindow != orefDefaultRuleChangeWindowMin || cooldown != orefDefaultRuleCooldownSeconds || checkInterval != orefDefaultRuleCheckInterval {
			t.Fatalf("rule %s windows = %d/%d/%d", slug, changeWindow, cooldown, checkInterval)
		}
		var metadataFields map[string]any
		if err := json.Unmarshal(metadata, &metadataFields); err != nil {
			t.Fatalf("rule %s metadata = %s: %v", slug, metadata, err)
		}
		if metadataFields["source"] != "situation-monitor-signals" || metadataFields["systemDefault"] != true {
			t.Fatalf("rule %s metadata = %s", slug, metadata)
		}
		thresholdValue, parseErr := strconv.ParseFloat(strings.TrimSpace(threshold.String), 64)
		if parseErr != nil {
			t.Fatalf("rule %s threshold = %q: %v", slug, threshold.String, parseErr)
		}
		storedRules = append(storedRules, expectedRule{slug: slug, severity: severity, threshold: thresholdValue})
		storedIDs = append(storedIDs, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		t.Fatalf("iterate alert rules: %v", err)
	}
	_ = rows.Close()
	if len(storedRules) != len(expectedRules) {
		t.Fatalf("alert rules = %d, want %d", len(storedRules), len(expectedRules))
	}
	for index, want := range expectedRules {
		got := storedRules[index]
		if got.slug != want.slug || got.severity != want.severity || got.threshold != want.threshold {
			t.Fatalf("rule[%d] = %+v, want %+v", index, got, want)
		}
		if wantID := buildDefaultOrefRuleID(orgID, want.slug); storedIDs[index] != wantID {
			t.Fatalf("rule[%d] id = %q, want %q", index, storedIDs[index], wantID)
		}
	}

	expectedCallIDs := map[string]bool{
		buildDefaultOrefRuleID(orgID, orefActiveAlertsMetricSlug): true,
		buildDefaultOrefRuleID(orgID, orefHistory24hMetricSlug):   true,
	}
	// The tick-gate owner fans the OREF maintenance out to every active
	// organization in the shared database, so only this test organization's
	// jobs are asserted here.
	assertOrgRuleChecks := func(want int) {
		t.Helper()
		matched := 0
		for _, call := range alerts.snapshot() {
			if !expectedCallIDs[call.RuleID] {
				continue
			}
			if call.OrgID != orgID {
				t.Fatalf("enqueued rule check = %+v, want org %s", call, orgID)
			}
			if strings.TrimSpace(call.TraceID) == "" {
				t.Fatalf("enqueued rule check for %s has no trace id", call.RuleID)
			}
			matched++
		}
		if matched != want {
			t.Fatalf("enqueued checks for org %s = %d, want %d", orgID, matched, want)
		}
	}
	assertOrgRuleChecks(2)
	if exists, err := client.Exists(ctx, orefDefaultRuleTickGateKey).Result(); err != nil || exists != 1 {
		t.Fatalf("OREF default rule tick gate exists = %d (err=%v)", exists, err)
	}

	// Second pass: the 30s process throttle was reset and the shared tick gate
	// expired/deleted, so the rules are re-read (no duplicates) and every active
	// rule is enqueued again.
	service.mu.Lock()
	service.lastOrefAlertRuleCheckAt = time.Time{}
	service.orefEnsureRulesAt = time.Time{}
	service.mu.Unlock()
	if err := client.Del(ctx, orefDefaultRuleTickGateKey).Err(); err != nil {
		t.Fatalf("delete tick gate: %v", err)
	}
	if err := service.triggerOrefAlertChecks(ctx); err != nil {
		t.Fatalf("second triggerOrefAlertChecks: %v", err)
	}
	var ruleCount int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ?", orgID).Scan(&ruleCount); err != nil {
		t.Fatalf("count alert rules: %v", err)
	}
	if ruleCount != 2 {
		t.Fatalf("alert rules after the second pass = %d, want 2 (no duplicates)", ruleCount)
	}
	assertOrgRuleChecks(4)
}

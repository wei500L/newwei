package telegramclient

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

// fakeTelegramAPI is a telegramAPI that records calls and returns scripted
// values, so resolve/history tests never open an MTProto connection.
type fakeTelegramAPI struct {
	mu sync.Mutex

	resolveCalls []string
	historyCalls []*tg.MessagesGetHistoryRequest

	resolveFn func(ctx context.Context, username string) (*tg.ContactsResolvedPeer, error)
	historyFn func(ctx context.Context, request *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error)
}

func (f *fakeTelegramAPI) ContactsResolveUsername(ctx context.Context, request *tg.ContactsResolveUsernameRequest) (*tg.ContactsResolvedPeer, error) {
	f.mu.Lock()
	f.resolveCalls = append(f.resolveCalls, request.Username)
	f.mu.Unlock()
	if f.resolveFn == nil {
		return &tg.ContactsResolvedPeer{}, nil
	}
	return f.resolveFn(ctx, request.Username)
}

func (f *fakeTelegramAPI) MessagesGetHistory(ctx context.Context, request *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	f.mu.Lock()
	f.historyCalls = append(f.historyCalls, request)
	f.mu.Unlock()
	if f.historyFn == nil {
		return &tg.MessagesChannelMessages{}, nil
	}
	return f.historyFn(ctx, request)
}

func (f *fakeTelegramAPI) resolveCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.resolveCalls)
}

func (f *fakeTelegramAPI) historyCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.historyCalls)
}

func (f *fakeTelegramAPI) historyRequest(index int) *tg.MessagesGetHistoryRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.historyCalls[index]
}

// fakePeerCache is an in-memory peerCacheStore.
type fakePeerCache struct {
	mu   sync.Mutex
	data map[string][]byte
	ttls map[string]time.Duration

	getErr error
	setErr error
	delErr error

	gets, sets, dels int
}

func newFakePeerCache() *fakePeerCache {
	return &fakePeerCache{data: make(map[string][]byte), ttls: make(map[string]time.Duration)}
}

func (c *fakePeerCache) Get(_ context.Context, key string) ([]byte, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gets++
	if c.getErr != nil {
		return nil, false, c.getErr
	}
	value, ok := c.data[key]
	if !ok {
		return nil, false, nil
	}
	return append([]byte(nil), value...), true, nil
}

func (c *fakePeerCache) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sets++
	if c.setErr != nil {
		return c.setErr
	}
	c.data[key] = append([]byte(nil), value...)
	c.ttls[key] = ttl
	return nil
}

func (c *fakePeerCache) Del(_ context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dels++
	if c.delErr != nil {
		return c.delErr
	}
	delete(c.data, key)
	return nil
}

func (c *fakePeerCache) raw(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.data[key]
	return value, ok
}

func (c *fakePeerCache) counts() (gets, sets, dels int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gets, c.sets, c.dels
}

// newPollTestClient builds a Client whose RPC and cache edges are fakes. New
// only constructs the gotd client and does no network I/O.
func newPollTestClient(t *testing.T, api telegramAPI, cache peerCacheStore) *Client {
	t.Helper()
	client, err := New(Options{APIID: 1, APIHash: "test-api-hash"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if api != nil {
		client.api = api
	}
	if cache != nil {
		client.setPeerCache(cache)
	}
	return client
}

func channelPeer(channelID, accessHash int64) *tg.Channel {
	return &tg.Channel{ID: channelID, AccessHash: accessHash, Title: "channel"}
}

func resolveToChannel(channelID, accessHash int64) func(context.Context, string) (*tg.ContactsResolvedPeer, error) {
	return func(context.Context, string) (*tg.ContactsResolvedPeer, error) {
		return &tg.ContactsResolvedPeer{
			Peer:  &tg.PeerChannel{ChannelID: channelID},
			Chats: []tg.ChatClass{channelPeer(channelID, accessHash)},
		}, nil
	}
}

func TestNormalizeChannelHandle(t *testing.T) {
	tests := map[string]string{
		"channel":     "channel",
		"@channel":    "channel",
		"  @channel ": "@channel", // the @ is stripped before trimming, like NestJS
		"  channel  ": "channel",
		"@":           "",
		"":            "",
		// NestJS strips the "@" before trimming, so a leading space keeps it.
		" @channel": "@channel",
	}
	for input, want := range tests {
		if got := normalizeChannelHandle(input); got != want {
			t.Errorf("normalizeChannelHandle(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestResolveChannelCachesPeer(t *testing.T) {
	api := &fakeTelegramAPI{resolveFn: resolveToChannel(123456789, 987654321)}
	cache := newFakePeerCache()
	client := newPollTestClient(t, api, cache)

	peer, err := client.ResolveChannel(context.Background(), "@some_channel")
	if err != nil {
		t.Fatalf("ResolveChannel() error = %v", err)
	}
	if peer.ChannelID != 123456789 || peer.AccessHash != 987654321 {
		t.Errorf("ResolveChannel() = %+v, want {123456789 987654321}", peer)
	}
	if api.resolveCount() != 1 {
		t.Errorf("resolve calls = %d, want 1", api.resolveCount())
	}

	cached, ok := cache.raw(PeerCacheKeyPrefix + "some_channel")
	if !ok {
		t.Fatal("peer cache entry missing")
	}
	var stored Peer
	if err := json.Unmarshal(cached, &stored); err != nil {
		t.Fatalf("cached peer JSON = %q: %v", cached, err)
	}
	if stored != (Peer{ChannelID: 123456789, AccessHash: 987654321}) {
		t.Errorf("cached peer = %+v", stored)
	}
	if ttl := cache.ttls[PeerCacheKeyPrefix+"some_channel"]; ttl != PeerCacheTTL {
		t.Errorf("cache TTL = %s, want %s", ttl, PeerCacheTTL)
	}

	// Second resolve is served from the cache.
	peer, err = client.ResolveChannel(context.Background(), "some_channel")
	if err != nil {
		t.Fatalf("cached ResolveChannel() error = %v", err)
	}
	if peer.ChannelID != 123456789 {
		t.Errorf("cached ResolveChannel() = %+v", peer)
	}
	if api.resolveCount() != 1 {
		t.Errorf("resolve calls after cache hit = %d, want 1", api.resolveCount())
	}
}

func TestResolveChannelCorruptCacheEntry(t *testing.T) {
	api := &fakeTelegramAPI{resolveFn: resolveToChannel(11, 22)}
	cache := newFakePeerCache()
	cache.data[PeerCacheKeyPrefix+"broken"] = []byte("not json")
	client := newPollTestClient(t, api, cache)

	peer, err := client.ResolveChannel(context.Background(), "broken")
	if err != nil {
		t.Fatalf("ResolveChannel() error = %v", err)
	}
	if peer.ChannelID != 11 {
		t.Errorf("ResolveChannel() = %+v", peer)
	}
	if api.resolveCount() != 1 {
		t.Errorf("resolve calls = %d, want 1", api.resolveCount())
	}
	if _, sets, dels := cache.counts(); sets != 1 || dels != 1 {
		t.Errorf("cache counts = (%d sets, %d dels), want (1, 1)", sets, dels)
	}
}

func TestResolveChannelCacheErrorsFallBackToRPC(t *testing.T) {
	api := &fakeTelegramAPI{resolveFn: resolveToChannel(33, 44)}
	cache := newFakePeerCache()
	cache.getErr = errors.New("redis down")
	cache.setErr = errors.New("redis down")
	client := newPollTestClient(t, api, cache)

	peer, err := client.ResolveChannel(context.Background(), "channel")
	if err != nil {
		t.Fatalf("ResolveChannel() error = %v", err)
	}
	if peer.ChannelID != 33 || peer.AccessHash != 44 {
		t.Errorf("ResolveChannel() = %+v", peer)
	}
	if api.resolveCount() != 1 {
		t.Errorf("resolve calls = %d, want 1", api.resolveCount())
	}
}

func TestResolveChannelNotAChannel(t *testing.T) {
	api := &fakeTelegramAPI{resolveFn: func(context.Context, string) (*tg.ContactsResolvedPeer, error) {
		return &tg.ContactsResolvedPeer{
			Peer:  &tg.PeerChat{ChatID: 7},
			Chats: []tg.ChatClass{&tg.Chat{ID: 7, Title: "group"}},
		}, nil
	}}
	client := newPollTestClient(t, api, newFakePeerCache())

	if _, err := client.ResolveChannel(context.Background(), "group"); !errors.Is(err, ErrNotAChannel) {
		t.Errorf("ResolveChannel() error = %v, want ErrNotAChannel", err)
	}
}

func TestResolveChannelEmptyHandle(t *testing.T) {
	client := newPollTestClient(t, &fakeTelegramAPI{}, newFakePeerCache())
	if _, err := client.ResolveChannel(context.Background(), "   "); err == nil {
		t.Error("ResolveChannel() error = nil, want error")
	}
}

func TestResolveChannelWithoutCacheStore(t *testing.T) {
	// A Client built without a Redis-backed cache still resolves (no O1 cache).
	api := &fakeTelegramAPI{resolveFn: resolveToChannel(55, 66)}
	client := newPollTestClient(t, api, nil)

	for i := 0; i < 2; i++ {
		peer, err := client.ResolveChannel(context.Background(), "channel")
		if err != nil {
			t.Fatalf("ResolveChannel() error = %v", err)
		}
		if peer.ChannelID != 55 {
			t.Errorf("ResolveChannel() = %+v", peer)
		}
	}
	if api.resolveCount() != 2 {
		t.Errorf("resolve calls = %d, want 2 (no cache)", api.resolveCount())
	}
}

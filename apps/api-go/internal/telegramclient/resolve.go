package telegramclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gotd/td/tg"
	"github.com/redis/go-redis/v9"
)

const (
	// PeerCacheKeyPrefix prefixes the O1 channel resolution cache keys. The
	// full key is PeerCacheKeyPrefix + <normalized handle>.
	PeerCacheKeyPrefix = "situation-monitor:signals:telegram:peer:"

	// PeerCacheTTL is how long a resolved channel (id + access hash) is cached.
	// The NestJS poller resolved the entity on every cycle; this cache removes
	// that round trip for the 15s/30s polling intervals.
	PeerCacheTTL = 24 * time.Hour
)

// Peer identifies a Telegram channel. ChannelID is the positive channel id
// (never the -100 marked form) and AccessHash is the channel access hash from
// contacts.resolveUsername.
type Peer struct {
	ChannelID  int64 `json:"channelId"`
	AccessHash int64 `json:"accessHash"`
}

// ErrNotAChannel is returned by ResolveChannel when the handle resolves to a
// user or a basic group instead of a channel.
var ErrNotAChannel = errors.New("telegramclient: resolved entity is not a channel")

// peerCacheStore is the narrow Redis surface of the O1 peer cache. It is an
// interface so tests can substitute an in-memory implementation.
type peerCacheStore interface {
	// Get returns the stored bytes and whether the key exists.
	Get(ctx context.Context, key string) (value []byte, ok bool, err error)
	// Set stores value under key for ttl.
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// Del removes key; a missing key is not an error.
	Del(ctx context.Context, key string) error
}

// redisPeerCache adapts the shared go-redis client to peerCacheStore. A nil
// client behaves as a cache miss, so a Client built without Redis still works
// (it just resolves every time).
type redisPeerCache struct {
	client *redis.Client
}

func (c redisPeerCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if c.client == nil {
		return nil, false, nil
	}
	value, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

func (c redisPeerCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if c.client == nil {
		return nil
	}
	return c.client.Set(ctx, key, value, ttl).Err()
}

func (c redisPeerCache) Del(ctx context.Context, key string) error {
	if c.client == nil {
		return nil
	}
	return c.client.Del(ctx, key).Err()
}

// ResolveChannel resolves a channel handle to its numeric id and access hash,
// using the Redis peer cache when possible (O1).
//
// The handle is normalized like the NestJS poller
// (channel.handle.replace(/^@/, "").trim()). A cache miss performs
// contacts.resolveUsername and stores the pair for PeerCacheTTL. Cache failures
// are never fatal: the cache is an optimization, so lookup/write errors fall
// back to the RPC.
func (c *Client) ResolveChannel(ctx context.Context, handle string) (Peer, error) {
	normalized := normalizeChannelHandle(handle)
	if normalized == "" {
		return Peer{}, errors.New("telegramclient: channel handle is empty")
	}

	if peer, ok := c.loadCachedPeer(ctx, normalized); ok {
		c.rememberChannelHandle(peer.ChannelID, normalized)
		return peer, nil
	}

	peer, err := c.resolveChannelHandle(ctx, normalized)
	if err != nil {
		return Peer{}, err
	}
	c.storeCachedPeer(ctx, normalized, peer)
	c.rememberChannelHandle(peer.ChannelID, normalized)
	return peer, nil
}

// normalizeChannelHandle mirrors NestJS: strip one leading "@", then trim
// surrounding whitespace. The order matters for inputs like " @name".
func normalizeChannelHandle(handle string) string {
	return strings.TrimSpace(strings.TrimPrefix(handle, "@"))
}

// resolveChannelHandle performs the uncached contacts.resolveUsername call. The
// resolved peer must be a *tg.Channel: users and basic groups have no access
// hash and cannot be polled as signal channels.
func (c *Client) resolveChannelHandle(ctx context.Context, handle string) (Peer, error) {
	resolved, err := c.api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{
		Username: handle,
	})
	if err != nil {
		return Peer{}, fmt.Errorf("telegramclient: resolve channel %q: %w", handle, err)
	}
	for _, chat := range resolved.Chats {
		channel, ok := chat.(*tg.Channel)
		if !ok {
			continue
		}
		if channel.ID == 0 || channel.AccessHash == 0 {
			continue
		}
		return Peer{ChannelID: channel.ID, AccessHash: channel.AccessHash}, nil
	}
	return Peer{}, fmt.Errorf("%w: %q", ErrNotAChannel, handle)
}

// loadCachedPeer reads and validates a peer cache entry. Corrupt entries are
// deleted so the next call resolves and rewrites them.
func (c *Client) loadCachedPeer(ctx context.Context, handle string) (Peer, bool) {
	if c.peerCache == nil {
		return Peer{}, false
	}
	raw, ok, err := c.peerCache.Get(ctx, PeerCacheKeyPrefix+handle)
	if err != nil || !ok {
		return Peer{}, false
	}
	var peer Peer
	if err := json.Unmarshal(raw, &peer); err != nil || peer.ChannelID == 0 {
		c.deleteCachedPeer(ctx, handle)
		return Peer{}, false
	}
	return peer, true
}

// storeCachedPeer writes a peer cache entry. Write failures are ignored: the
// caller already has a valid peer from Telegram.
func (c *Client) storeCachedPeer(ctx context.Context, handle string, peer Peer) {
	if c.peerCache == nil {
		return
	}
	encoded, err := json.Marshal(peer)
	if err != nil {
		return
	}
	_ = c.peerCache.Set(ctx, PeerCacheKeyPrefix+handle, encoded, PeerCacheTTL)
}

// deleteCachedPeer removes a peer cache entry after a stale-entity error or a
// corrupt payload.
func (c *Client) deleteCachedPeer(ctx context.Context, handle string) {
	if c.peerCache == nil {
		return
	}
	_ = c.peerCache.Del(ctx, PeerCacheKeyPrefix+handle)
}

// rememberChannelHandle records the channel-id to handle mapping used to
// re-resolve a peer when getHistory reports a stale access hash. The map is
// bounded by the configured channel set, so it is never evicted.
func (c *Client) rememberChannelHandle(channelID int64, handle string) {
	c.handlesMu.Lock()
	defer c.handlesMu.Unlock()
	c.handleByChannel[channelID] = handle
}

// channelHandle looks up the handle for a channel id previously resolved by
// this client.
func (c *Client) channelHandle(channelID int64) (string, bool) {
	c.handlesMu.RLock()
	defer c.handlesMu.RUnlock()
	handle, ok := c.handleByChannel[channelID]
	return handle, ok
}

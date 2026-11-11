package newspipeline

// This file holds the in-flight duplicate registry used before the dedupe stage.
//
// The dedupe candidates come from Mongo's completed ProcessedItems and the
// vector service, and both only receive an entry after the outbox delivers the
// persisted result. When the worker processes several near-identical items from
// the same source concurrently (default concurrency 3) they do not see each
// other in either candidate set, so every one is kept.
//
// The registry closes that window: before dedupe, an item registers the clean
// stage's content hash in Redis with SET NX + TTL. A later item that finds a
// live registration owned by a different itemMetaId is an in-flight duplicate.
// Only an exact content-hash match is handled here; semantic in-flight
// near-duplicates are out of scope, and the normalized title is deliberately not
// used (fixed column titles would conflate unrelated articles). A retry of the
// same item finds its own registration and is not treated as a duplicate.
//
// When an item reaches its final failure (dead letter) its own registration is
// released so a later same-content item is not falsely rejected against an item
// that never persisted; the release only removes keys whose stored itemMetaId is
// the failing item's own.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// inflightKV is the minimal key/value surface the in-flight registry needs.
// Redis backs it in production; tests swap in a memory implementation so the
// registration and release algorithms run without a server.
type inflightKV interface {
	get(ctx context.Context, key string) (string, bool)
	setNX(ctx context.Context, key, value string, ttl time.Duration) bool
	set(ctx context.Context, key, value string, ttl time.Duration)
	// releaseOwned deletes the item's content registration (only when its stored
	// itemMetaId is still itemMetaID) and the reverse-index key. contentHash is
	// the value previously read from the reverse index.
	releaseOwned(ctx context.Context, orgID, itemMetaID, contentHash string)
}

// inflightRegistration is the value stored under each in-flight key. The
// processedItemId is the id the registrant will persist, which the job carries
// (the itemPipeline processor resolves it before the pipeline runs), so a peer
// can point DuplicateOf at the real ProcessedItem.
type inflightRegistration struct {
	ItemMetaID      string `json:"itemMetaId"`
	ProcessedItemID string `json:"processedItemId"`
}

// inflightRegistry registers an in-flight item by content hash.
type inflightRegistry struct {
	kv  inflightKV
	ttl time.Duration
}

// newInflightRegistry builds the registry with the configured TTL (10 minutes by
// default).
func newInflightRegistry(kv inflightKV, ttlSeconds int) *inflightRegistry {
	if ttlSeconds <= 0 {
		ttlSeconds = 600
	}
	return &inflightRegistry{kv: kv, ttl: time.Duration(ttlSeconds) * time.Second}
}

// checkAndRegister returns the processedItemId of a live peer registration when
// this item is an in-flight duplicate; otherwise it registers this item (unless
// it is already registered by itself) and returns nil. A nil registry, nil KV or
// empty content hash is a no-op. Every Redis read/write failure is treated as a
// miss and only logged.
func (r *inflightRegistry) checkAndRegister(ctx context.Context, orgID, itemMetaID, processedItemID, contentHash string) *string {
	if r == nil || r.kv == nil || contentHash == "" {
		return nil
	}
	key := inflightContentKey(orgID, contentHash)
	encoded, err := json.Marshal(inflightRegistration{ItemMetaID: itemMetaID, ProcessedItemID: processedItemID})
	if err != nil {
		log.Printf("newspipeline: in-flight registration encode failed itemMetaId=%s: %v", itemMetaID, err)
		return nil
	}
	value, found := r.kv.get(ctx, key)
	if peer, ok := inflightPeer(value, found, itemMetaID); ok {
		return peer
	}
	if r.kv.setNX(ctx, key, string(encoded), r.ttl) {
		// Write the reverse index with the same TTL so release can find this
		// item's content key without scanning the keyspace.
		r.kv.set(ctx, inflightOwnerKey(orgID, itemMetaID), contentHash, r.ttl)
		return nil
	}
	// The SET NX lost a race: a peer wins the conflict, while losing to our own
	// earlier registration is harmless.
	value, found = r.kv.get(ctx, key)
	if peer, ok := inflightPeer(value, found, itemMetaID); ok {
		return peer
	}
	if found {
		var registration inflightRegistration
		if json.Unmarshal([]byte(value), &registration) == nil && registration.ItemMetaID == itemMetaID {
			// Our own registration: make sure a missing/expired reverse index is
			// restored so a later final failure can still release it.
			r.kv.set(ctx, inflightOwnerKey(orgID, itemMetaID), contentHash, r.ttl)
		}
	}
	return nil
}

// release removes this item's own in-flight registrations for orgID. It first
// reads the reverse index; a missing or expired index means there is nothing to
// release (no-op).
func (r *inflightRegistry) release(ctx context.Context, orgID, itemMetaID string) {
	if r == nil || r.kv == nil || itemMetaID == "" {
		return
	}
	contentHash, ok := r.kv.get(ctx, inflightOwnerKey(orgID, itemMetaID))
	if !ok || contentHash == "" {
		return
	}
	r.kv.releaseOwned(ctx, orgID, itemMetaID, contentHash)
}

// inflightPeer decodes a stored registration and reports it as a peer when it
// belongs to a different itemMetaId than selfItemMetaID.
func inflightPeer(value string, found bool, selfItemMetaID string) (*string, bool) {
	if !found || value == "" {
		return nil, false
	}
	var registration inflightRegistration
	if err := json.Unmarshal([]byte(value), &registration); err != nil {
		return nil, false
	}
	if registration.ItemMetaID == "" || registration.ItemMetaID == selfItemMetaID || registration.ProcessedItemID == "" {
		return nil, false
	}
	processedItemID := registration.ProcessedItemID
	return &processedItemID, true
}

// inflightContentKey is the content registration key for one item.
func inflightContentKey(orgID, contentHash string) string {
	return fmt.Sprintf("pipeline:inflight:%s:content:%s", orgID, contentHash)
}

// inflightOwnerKey is the reverse index from itemMetaId to its content hash.
func inflightOwnerKey(orgID, itemMetaID string) string {
	return fmt.Sprintf("pipeline:inflight:%s:owner:%s", orgID, itemMetaID)
}

// ReleaseInflightRegistrations removes the in-flight registrations owned by
// itemMetaID for orgID. It is called by the itemPipeline failure listener when a
// job reaches its final failure, so a later same-content item is not rejected
// against an owner that never persisted. It is best effort: a Redis failure is
// logged and ignored.
func ReleaseInflightRegistrations(ctx context.Context, client *redis.Client, orgID, itemMetaID string) {
	if client == nil || orgID == "" || itemMetaID == "" {
		return
	}
	registry := &inflightRegistry{kv: &redisInflightKV{client: client}}
	registry.release(ctx, orgID, itemMetaID)
}

// inflightReleaseScript deletes the content key only when its stored itemMetaId
// still belongs to this item, then deletes the reverse index. Both keys are
// declared explicitly (KEYS[1] content, KEYS[2] owner) so the script never scans
// the keyspace; keeping the compare and delete in one invocation preserves a key
// that another item re-registered in between.
var inflightReleaseScript = redis.NewScript(`
local value = redis.call("GET", KEYS[1])
if value then
  local ok, decoded = pcall(cjson.decode, value)
  if ok and type(decoded) == "table" and decoded["itemMetaId"] == ARGV[1] then
    redis.call("DEL", KEYS[1])
  end
end
redis.call("DEL", KEYS[2])
return 1
`)

// redisInflightKV is the Redis-backed inflightKV.
type redisInflightKV struct {
	client *redis.Client
}

func (k *redisInflightKV) get(ctx context.Context, key string) (string, bool) {
	if k == nil || k.client == nil {
		return "", false
	}
	value, err := k.client.Get(ctx, key).Result()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			log.Printf("newspipeline: in-flight read failed key=%s: %v", key, err)
		}
		return "", false
	}
	return value, true
}

func (k *redisInflightKV) setNX(ctx context.Context, key, value string, ttl time.Duration) bool {
	if k == nil || k.client == nil {
		return false
	}
	ok, err := k.client.SetNX(ctx, key, value, ttl).Result()
	if err != nil {
		log.Printf("newspipeline: in-flight register failed key=%s: %v", key, err)
		return false
	}
	return ok
}

func (k *redisInflightKV) set(ctx context.Context, key, value string, ttl time.Duration) {
	if k == nil || k.client == nil {
		return
	}
	if err := k.client.Set(ctx, key, value, ttl).Err(); err != nil {
		log.Printf("newspipeline: in-flight reverse index write failed key=%s: %v", key, err)
	}
}

func (k *redisInflightKV) releaseOwned(ctx context.Context, orgID, itemMetaID, contentHash string) {
	if k == nil || k.client == nil || itemMetaID == "" || contentHash == "" {
		return
	}
	contentKey := inflightContentKey(orgID, contentHash)
	ownerKey := inflightOwnerKey(orgID, itemMetaID)
	if _, err := inflightReleaseScript.Run(ctx, k.client, []string{contentKey, ownerKey}, itemMetaID).Result(); err != nil {
		log.Printf("newspipeline: in-flight release failed orgId=%s itemMetaId=%s: %v", orgID, itemMetaID, err)
	}
}

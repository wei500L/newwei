package newspipeline

// This file holds the in-flight duplicate registry used before the dedupe stage.
//
// The dedupe candidates come from Mongo's completed ProcessedItems and the
// vector service, and both only receive an entry after the outbox delivers the
// persisted result. When the worker processes several near-identical items from
// the same source concurrently (default concurrency 3) they do not see each
// other in either candidate set, so every one is kept.
//
// The registry closes that window: before dedupe, an item registers its
// normalized title and content hash in Redis with SET NX + TTL. A later item
// that finds a live registration owned by a different itemMetaId is an
// in-flight duplicate. Only exact title/content matches are handled here;
// semantic in-flight near-duplicates are out of scope. A retry of the same item
// finds its own registration and is not treated as a duplicate.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode"

	"github.com/redis/go-redis/v9"
)

// inflightKV is the minimal key/value surface the in-flight registry needs.
// Redis backs it in production; tests swap in a memory implementation so the
// registration algorithm runs without a server.
type inflightKV interface {
	get(ctx context.Context, key string) (string, bool)
	setNX(ctx context.Context, key, value string, ttl time.Duration) bool
}

// inflightRegistration is the value stored under each in-flight key. The
// processedItemId is the id the registrant will persist, which the job carries
// (the itemPipeline processor resolves it before the pipeline runs), so a peer
// can point DuplicateOf at the real ProcessedItem.
type inflightRegistration struct {
	ItemMetaID      string `json:"itemMetaId"`
	ProcessedItemID string `json:"processedItemId"`
}

// inflightRegistry registers an in-flight item by normalized title and content
// hash.
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
// it is already registered by itself) and returns nil. A nil registry or nil KV
// is a no-op. Every Redis read/write failure is treated as a miss and only
// logged.
func (r *inflightRegistry) checkAndRegister(ctx context.Context, orgID, itemMetaID, processedItemID, contentHash string, title *string) *string {
	if r == nil || r.kv == nil {
		return nil
	}
	keys := inflightKeys(orgID, contentHash, title)
	if len(keys) == 0 {
		return nil
	}
	encoded, err := json.Marshal(inflightRegistration{ItemMetaID: itemMetaID, ProcessedItemID: processedItemID})
	if err != nil {
		log.Printf("newspipeline: in-flight registration encode failed itemMetaId=%s: %v", itemMetaID, err)
		return nil
	}
	// Reject when a live peer already owns any key.
	for _, key := range keys {
		value, found := r.kv.get(ctx, key)
		if peer, ok := inflightPeer(value, found, itemMetaID); ok {
			return peer
		}
	}
	// Register every key. A SET NX that loses a race is re-checked: a peer wins
	// the conflict, while losing to our own earlier registration is harmless.
	for _, key := range keys {
		if r.kv.setNX(ctx, key, string(encoded), r.ttl) {
			continue
		}
		value, found := r.kv.get(ctx, key)
		if peer, ok := inflightPeer(value, found, itemMetaID); ok {
			return peer
		}
	}
	return nil
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

// inflightKeys builds the content-hash and normalized-title keys for one item.
// Empty contentHash or normalized title contributes no key.
func inflightKeys(orgID, contentHash string, title *string) []string {
	keys := make([]string, 0, 2)
	if contentHash != "" {
		keys = append(keys, fmt.Sprintf("pipeline:inflight:%s:content:%s", orgID, contentHash))
	}
	if normalized := normalizeInflightTitle(title); normalized != "" {
		keys = append(keys, fmt.Sprintf("pipeline:inflight:%s:title:%s", orgID, normalized))
	}
	return keys
}

// normalizeInflightTitle lowercases and drops whitespace, punctuation and
// symbols so trivially different surface forms of the same headline collide.
func normalizeInflightTitle(title *string) string {
	if title == nil {
		return ""
	}
	var builder strings.Builder
	for _, r := range strings.ToLower(*title) {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

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

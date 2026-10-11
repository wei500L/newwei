package transport

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// APQCache is an in-process document cache. It stores query text only, never
// identity or responses. Defaults: 1024 entries, 8 MiB total, 256 KiB per
// document, 1 hour TTL, least-recently-used eviction.
type APQCache struct {
	mu         sync.Mutex
	items      map[string]*list.Element
	order      *list.List
	totalBytes int
	maxEntries int
	maxBytes   int
	maxDoc     int
	ttl        time.Duration
	now        func() time.Time
}

type apqEntry struct {
	hash    string
	query   string
	expires time.Time
}

// APQConfig is the bounded cache policy.
type APQConfig struct {
	MaxEntries  int
	MaxBytes    int
	MaxDocument int
	TTL         time.Duration
}

// DefaultAPQConfig matches the pilot defaults documented in
// docs/refactor/go-graphql-read-pilot.md.
func DefaultAPQConfig() APQConfig {
	return APQConfig{
		MaxEntries:  1024,
		MaxBytes:    8 << 20,
		MaxDocument: 256 << 10,
		TTL:         time.Hour,
	}
}

// NewAPQCache returns an empty cache. Zero config fields use the defaults.
func NewAPQCache(cfg APQConfig) *APQCache {
	defaults := DefaultAPQConfig()
	if cfg.MaxEntries <= 0 {
		cfg.MaxEntries = defaults.MaxEntries
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = defaults.MaxBytes
	}
	if cfg.MaxDocument <= 0 {
		cfg.MaxDocument = defaults.MaxDocument
	}
	if cfg.TTL <= 0 {
		cfg.TTL = defaults.TTL
	}
	return &APQCache{
		items:      map[string]*list.Element{},
		order:      list.New(),
		maxEntries: cfg.MaxEntries,
		maxBytes:   cfg.MaxBytes,
		maxDoc:     cfg.MaxDocument,
		ttl:        cfg.TTL,
		now:        time.Now,
	}
}

// Get returns a stored document. Expired entries are misses and are removed.
func (c *APQCache) Get(hash string) (string, bool) {
	if c == nil {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	element := c.items[hash]
	if element == nil {
		return "", false
	}
	entry := element.Value.(*apqEntry)
	if c.now().After(entry.expires) {
		c.remove(element)
		return "", false
	}
	c.order.MoveToFront(element)
	return entry.query, true
}

// Put stores a document when it fits in the single-document limit. Oversized
// documents are refused without evicting other entries. The hash is the
// client-supplied SHA-256 that already matched the raw query string.
func (c *APQCache) Put(hash, query string) bool {
	if c == nil || hash == "" || query == "" {
		return false
	}
	size := len(query)
	if size > c.maxDoc || size > c.maxBytes {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if element := c.items[hash]; element != nil {
		c.remove(element)
	}
	for c.order.Len()+1 > c.maxEntries || c.totalBytes+size > c.maxBytes {
		back := c.order.Back()
		if back == nil {
			break
		}
		c.remove(back)
	}
	if c.order.Len()+1 > c.maxEntries || c.totalBytes+size > c.maxBytes {
		return false
	}
	element := c.order.PushFront(&apqEntry{
		hash:    hash,
		query:   query,
		expires: c.now().Add(c.ttl),
	})
	c.items[hash] = element
	c.totalBytes += size
	return true
}

// Close drops the cache so shutdown does not retain documents.
func (c *APQCache) Close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = map[string]*list.Element{}
	c.order.Init()
	c.totalBytes = 0
}

func (c *APQCache) remove(element *list.Element) {
	entry := element.Value.(*apqEntry)
	delete(c.items, entry.hash)
	c.order.Remove(element)
	c.totalBytes -= len(entry.query)
	if c.totalBytes < 0 {
		c.totalBytes = 0
	}
}

// SHA256Hex is the lowercase hex digest of the raw query string.
func SHA256Hex(query string) string {
	sum := sha256.Sum256([]byte(query))
	return hex.EncodeToString(sum[:])
}

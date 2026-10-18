package crawlmetadata

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// discoveryHTTPStateKeyPrefix and discoveryHTTPStateTTLSeconds mirror the
// NestJS constants so both runtimes read and write the same Redis entry and a
// mixed deployment keeps reusing each other's conditional GET state.
const (
	discoveryHTTPStateKeyPrefix  = "crawl:discover:http-state"
	discoveryHTTPStateTTLSeconds = 7 * 24 * 60 * 60
)

// discoveryHTTPState is DiscoveryHttpState: the conditional GET bookkeeping
// shared with the other sitemap discovery callers. Field names and the payload
// shape are part of the shared cache contract, so they must not be renamed.
type discoveryHTTPState struct {
	ETag                 string                `json:"etag,omitempty"`
	LastModified         string                `json:"lastModified,omitempty"`
	Body                 *string               `json:"body,omitempty"`
	ParsedSitemapPayload *parsedSitemapPayload `json:"parsedSitemapPayload,omitempty"`
	UpdatedAt            int64                 `json:"updatedAt"`
}

// cachedBody returns the cached body when it is a usable non-empty string. The
// source tests `state?.body` for truthiness, so an empty body counts as absent.
func (s *discoveryHTTPState) cachedBody() (string, bool) {
	if s == nil || s.Body == nil || *s.Body == "" {
		return "", false
	}
	return *s.Body, true
}

// discoveryStateStore persists that state. Production uses Redis; tests inject
// an in-memory store so the 304 reuse branches can be exercised without a
// Redis server.
type discoveryStateStore interface {
	read(ctx context.Context, url string) *discoveryHTTPState
	write(ctx context.Context, url string, state discoveryHTTPState)
}

// redisDiscoveryState is the shared Redis implementation.
type redisDiscoveryState struct {
	redis *redis.Client
}

// read loads the cached state. A missing Redis client, a cache miss and a
// malformed value all degrade to "no state"; the source logs and continues the
// same way.
func (s redisDiscoveryState) read(ctx context.Context, url string) *discoveryHTTPState {
	if s.redis == nil {
		return nil
	}
	payload, err := s.redis.Get(ctx, discoveryHTTPStateCacheKey(url)).Bytes()
	if err != nil || len(payload) == 0 {
		return nil
	}
	var state discoveryHTTPState
	if err := json.Unmarshal(payload, &state); err != nil {
		return nil
	}
	return &state
}

// write stores the state with the seven day TTL. Cache write failures never
// fail the request: the fetched body is already in hand.
func (s redisDiscoveryState) write(ctx context.Context, url string, state discoveryHTTPState) {
	if s.redis == nil {
		return
	}
	if state.UpdatedAt == 0 {
		state.UpdatedAt = time.Now().UnixMilli()
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = s.redis.Set(ctx, discoveryHTTPStateCacheKey(url), payload,
		time.Duration(discoveryHTTPStateTTLSeconds)*time.Second).Err()
}

// discoveryHTTPStateCacheKey is crawl:discover:http-state:<sha1(url)>.
func discoveryHTTPStateCacheKey(url string) string {
	digest := sha1.Sum([]byte(url))
	return discoveryHTTPStateKeyPrefix + ":" + hex.EncodeToString(digest[:])
}

// readDiscoveryHTTPState / writeDiscoveryHTTPState are the service-level
// wrappers used by discovery.
func (s *Service) readDiscoveryHTTPState(ctx context.Context, url string) *discoveryHTTPState {
	if s == nil || s.state == nil {
		return nil
	}
	return s.state.read(ctx, url)
}

func (s *Service) writeDiscoveryHTTPState(ctx context.Context, url string, state discoveryHTTPState) {
	if s == nil || s.state == nil {
		return
	}
	s.state.write(ctx, url, state)
}

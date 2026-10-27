package newseventsingest

import (
	"errors"
	"testing"

	"github.com/redis/go-redis/v9"
)

// TestDecodeActiveOrgCacheClassifiesAMissAsAMiss locks W3-01: the shared
// "org:active:list:v1" cache is filled by the caller only when the read reports
// a miss, so redis.Nil must not surface as an error. Reporting it as an error
// makes every tick fall back to MySQL and log a failure that did not happen.
func TestDecodeActiveOrgCacheClassifiesAMissAsAMiss(t *testing.T) {
	ids, found, err := decodeActiveOrgCache("", redis.Nil)
	if err != nil {
		t.Fatalf("miss reported as error: %v", err)
	}
	if found {
		t.Fatalf("miss reported as hit")
	}
	if len(ids) != 0 {
		t.Fatalf("miss produced %d ids", len(ids))
	}
}

// TestDecodeActiveOrgCacheReportsTransportFailures keeps a real Redis failure
// distinguishable from a miss: only the failure may skip the cache fill.
func TestDecodeActiveOrgCacheReportsTransportFailures(t *testing.T) {
	transportErr := errors.New("connection refused")
	ids, found, err := decodeActiveOrgCache("", transportErr)
	if !errors.Is(err, transportErr) {
		t.Fatalf("err = %v, want the transport error", err)
	}
	if found || len(ids) != 0 {
		t.Fatalf("transport failure reported found=%t ids=%v", found, ids)
	}
}

// TestDecodeActiveOrgCacheDecodesTheRegistryPayload covers the stored shape:
// the NestJS registry caches an array of ActiveOrgEntry objects ordered by id,
// and an entry with a blank id is dropped rather than yielded as "".
func TestDecodeActiveOrgCacheDecodesTheRegistryPayload(t *testing.T) {
	ids, found, err := decodeActiveOrgCache(
		`[{"id":"org_a"},{"id":"org_b"},{"id":""},{"id":null}]`, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !found {
		t.Fatalf("payload reported as miss")
	}
	if len(ids) != 2 || ids[0] != "org_a" || ids[1] != "org_b" {
		t.Fatalf("ids = %v, want [org_a org_b]", ids)
	}
}

// TestDecodeActiveOrgCacheRejectsMalformedPayload keeps a corrupted entry on the
// database fallback path instead of returning an empty organization list, which
// would silently skip every tenant for one tick.
func TestDecodeActiveOrgCacheRejectsMalformedPayload(t *testing.T) {
	if _, _, err := decodeActiveOrgCache("not-json", nil); err == nil {
		t.Fatalf("malformed payload decoded without an error")
	}
	if _, _, err := decodeActiveOrgCache(`{"id":"org_a"}`, nil); err == nil {
		t.Fatalf("object payload decoded without an error")
	}
}

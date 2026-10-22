package rbacapi

import "testing"

// TestRbacWriteKeySharesTheNestRateLimitNamespace pins the physical Redis key.
// RateLimiterService.consume prefixes "rate:", so the bucket NestJS writes is
// `rate:rbac:write:<orgId>:<actorId>`; Go must count in that same ZSET.
func TestRbacWriteKeySharesTheNestRateLimitNamespace(t *testing.T) {
	if got := rbacWriteKey("org-1", "user-1"); got != "rate:rbac:write:org-1:user-1" {
		t.Fatalf("key = %q, want rate:rbac:write:org-1:user-1", got)
	}
}

// TestParseRbacBucket covers the accepted and rejected shapes of the cached
// `rate_limit:settings` document, including the numeric-string form the writer
// has emitted historically.
func TestParseRbacBucket(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		limit  int
		window int
		ok     bool
	}{
		{"numbers", `{"rbacWrite":{"limit":20,"windowSeconds":600}}`, 20, 600, true},
		{"fractions truncate", `{"rbacWrite":{"limit":20.9,"windowSeconds":599.5}}`, 20, 599, true},
		{"numeric strings", `{"rbacWrite":{"limit":"20","windowSeconds":"600"}}`, 20, 600, true},
		{"other buckets ignored", `{"login":{"limit":5,"windowSeconds":60},"rbacWrite":{"limit":7,"windowSeconds":30}}`, 7, 30, true},
		{"missing bucket", `{"login":{"limit":5,"windowSeconds":60}}`, 0, 0, false},
		{"missing window", `{"rbacWrite":{"limit":20}}`, 0, 0, false},
		{"null limit", `{"rbacWrite":{"limit":null,"windowSeconds":600}}`, 0, 0, false},
		{"non-numeric string", `{"rbacWrite":{"limit":"x","windowSeconds":600}}`, 0, 0, false},
		{"boolean limit", `{"rbacWrite":{"limit":true,"windowSeconds":600}}`, 0, 0, false},
		{"bucket is not an object", `{"rbacWrite":5}`, 0, 0, false},
		{"document is not an object", `[]`, 0, 0, false},
		{"empty object", `{}`, 0, 0, false},
	}
	for _, testCase := range cases {
		limit, window, ok := parseRbacBucket([]byte(testCase.raw))
		if ok != testCase.ok || limit != testCase.limit || window != testCase.window {
			t.Fatalf("%s: got (%d, %d, %v), want (%d, %d, %v)",
				testCase.name, limit, window, ok, testCase.limit, testCase.window, testCase.ok)
		}
	}
}

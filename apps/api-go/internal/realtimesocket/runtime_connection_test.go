package realtimesocket

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
)

func TestSupportsOnlyTheFiveNamespaces(t *testing.T) {
	harness := newTestRuntime(t, nil)
	for _, namespace := range []string{
		NamespaceNewsnow,
		NamespaceOps,
		NamespaceQuality,
		NamespaceQueue,
		NamespaceSituationMonitor,
	} {
		if !harness.runtime.Supports(namespace) {
			t.Fatalf("Supports(%q) = false, want true", namespace)
		}
	}
	for _, namespace := range []string{"/", "/notifications", "/socket.io", ""} {
		if harness.runtime.Supports(namespace) {
			t.Fatalf("Supports(%q) = true, want false", namespace)
		}
	}
}

func TestConnectAllNamespacesEmitsConnectedPayload(t *testing.T) {
	harness := newTestRuntime(t, nil)
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "jti-1", time.Now().Add(time.Hour))
	namespaces := []string{
		NamespaceNewsnow,
		NamespaceOps,
		NamespaceQuality,
		NamespaceQueue,
		NamespaceSituationMonitor,
	}
	sids := map[string]string{}
	for _, namespace := range namespaces {
		sid := connectBrowser(t, conn, namespace, token, "o1", "u1")
		for otherNamespace, otherSID := range sids {
			if otherSID == sid {
				t.Fatalf("namespace sockets %s and %s share sid %q", otherNamespace, namespace, sid)
			}
		}
		sids[namespace] = sid
	}
	for _, namespace := range namespaces {
		if got := harness.runtime.LocalOrgIDs(namespace); !reflect.DeepEqual(got, []string{"o1"}) {
			t.Fatalf("LocalOrgIDs(%q) = %v, want [o1]", namespace, got)
		}
		if got := harness.runtime.LocalUsers(namespace, "o1"); !reflect.DeepEqual(got, []string{"u1"}) {
			t.Fatalf("LocalUsers(%q, o1) = %v, want [u1]", namespace, got)
		}
	}
	if got := harness.runtime.LocalOrgIDs("/notifications"); got != nil {
		t.Fatalf("LocalOrgIDs(unsupported) = %v, want nil", got)
	}
}

func TestNamespacePermissionGates(t *testing.T) {
	cases := []struct {
		name        string
		namespace   string
		permissions []string
	}{
		{"newsnow items.read", NamespaceNewsnow, []string{permissionItemsRead}},
		{"ops crawl.read", NamespaceOps, []string{permissionCrawlRead}},
		{"ops crawl.write", NamespaceOps, []string{permissionCrawlWrite}},
		{"quality settings.manage", NamespaceQuality, []string{permissionSettingsManage}},
		{"queue queue.manage", NamespaceQueue, []string{permissionQueueManage}},
		{"situation items.read", NamespaceSituationMonitor, []string{permissionItemsRead}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newTestRuntime(t, nil)
			harness.repository.setPermissions(testCase.permissions...)
			conn := harness.dial(t)
			readOpen(t, conn)
			token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
			connectBrowser(t, conn, testCase.namespace, token, "o1", "u1")
		})
	}

	t.Run("missing permission", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		harness.repository.setPermissions("unrelated.permission")
		token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
		for _, namespace := range []string{
			NamespaceNewsnow,
			NamespaceOps,
			NamespaceQuality,
			NamespaceQueue,
			NamespaceSituationMonitor,
		} {
			conn := harness.dial(t)
			readOpen(t, conn)
			beginConnect(t, conn, namespace, token)
			expectErrorEvent(t, conn, namespace, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
			expectFrame(t, conn, "41"+namespace+",")
			expectClosed(t, conn)
		}
		if failures := harness.limiter.failures(); len(failures) != 5 {
			t.Fatalf("recorded failures = %v, want 5 entries", failures)
		}
	})
}

func TestTokenPrecedencePerNamespace(t *testing.T) {
	harness := newTestRuntime(t, nil)
	goodToken := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	badToken := signToken(t, "evil", "evil-org", "", time.Now().Add(time.Hour))

	t.Run("newsnow header wins and bearer scheme is case insensitive", func(t *testing.T) {
		conn := harness.dialWith(t, "", http.Header{"Authorization": []string{"bearer " + goodToken}})
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceNewsnow, badToken, "o1", "u1")
	})

	t.Run("ops CONNECT auth wins over header", func(t *testing.T) {
		conn := harness.dialWith(t, "", http.Header{"Authorization": []string{"Bearer " + badToken}})
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceOps, goodToken, "o1", "u1")
	})

	t.Run("quality query wins over header", func(t *testing.T) {
		conn := harness.dialWith(t, "token="+goodToken, http.Header{"Authorization": []string{"Bearer " + badToken}})
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceQuality, "", "o1", "u1")
	})

	t.Run("newsnow query fallback", func(t *testing.T) {
		conn := harness.dialWith(t, "token="+goodToken, nil)
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceNewsnow, "", "o1", "u1")
	})

	t.Run("queue header wins", func(t *testing.T) {
		conn := harness.dialWith(t, "", http.Header{"Authorization": []string{"Bearer " + goodToken}})
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceQueue, badToken, "o1", "u1")
	})
}

func TestHandshakeRejectionPayloads(t *testing.T) {
	validToken := func(t *testing.T) string {
		return signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	}

	t.Run("ip rate limit", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		harness.limiter.setIP(false, 60_000)
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceNewsnow, validToken(t))
		expectErrorEvent(t, conn, NamespaceNewsnow, `{"code":"RATE_LIMIT_EXCEEDED","message":"Rate limit exceeded","retryAfterMs":60000}`)
		expectFrame(t, conn, "41/newsnow,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 0 {
			t.Fatalf("rate limit must not record a failed auth, got %v", failures)
		}
	})

	t.Run("failed auth backoff", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		harness.limiter.setBackoff(3 * time.Second)
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceOps, validToken(t))
		expectErrorEvent(t, conn, NamespaceOps, `{"code":"TOO_MANY_FAILED_ATTEMPTS","message":"Too many failed attempts","retryAfterMs":3000}`)
		expectFrame(t, conn, "41/ops,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 0 {
			t.Fatalf("backoff must not record a failed auth, got %v", failures)
		}
	})

	t.Run("missing token", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceQuality, "")
		expectErrorEvent(t, conn, NamespaceQuality, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
		expectFrame(t, conn, "41/quality,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 1 || failures[0] != "127.0.0.1" {
			t.Fatalf("recorded failures = %v, want one entry for 127.0.0.1", failures)
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceNewsnow, "not-a-jwt")
		expectErrorEvent(t, conn, NamespaceNewsnow, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
		expectFrame(t, conn, "41/newsnow,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 1 {
			t.Fatalf("recorded failures = %v, want 1 entry", failures)
		}
	})

	t.Run("revoked token", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		token := signToken(t, "u1", "o1", "jti-revoked", time.Now().Add(time.Hour))
		harness.blacklist.setRevoked("jti-revoked", true)
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceQueue, token)
		expectErrorEvent(t, conn, NamespaceQueue, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
		expectFrame(t, conn, "41/queue,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 1 {
			t.Fatalf("recorded failures = %v, want 1 entry", failures)
		}
	})

	t.Run("authorization query failure", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		harness.repository.setError(errors.New("mysql unavailable"))
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceQuality, validToken(t))
		expectErrorEvent(t, conn, NamespaceQuality, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
		expectFrame(t, conn, "41/quality,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 1 {
			t.Fatalf("recorded failures = %v, want 1 entry", failures)
		}
	})

	t.Run("user connection rate limit only for newsnow and situation", func(t *testing.T) {
		harness := newTestRuntime(t, nil)
		harness.limiter.setUser(false, 30_000)
		token := validToken(t)
		// newsnow uses the user bucket...
		conn := harness.dial(t)
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceNewsnow, token)
		expectErrorEvent(t, conn, NamespaceNewsnow, `{"code":"TOO_MANY_CONNECTION_ATTEMPTS","message":"Too many connection attempts","retryAfterMs":30000}`)
		expectFrame(t, conn, "41/newsnow,")
		expectClosed(t, conn)
		// ...ops does not.
		opsConn := harness.dial(t)
		readOpen(t, opsConn)
		connectBrowser(t, opsConn, NamespaceOps, token, "o1", "u1")
		if failures := harness.limiter.failures(); len(failures) != 0 {
			t.Fatalf("user rate limit must not record a failed auth, got %v", failures)
		}
	})

	t.Run("too many connections by user", func(t *testing.T) {
		harness := newTestRuntime(t, func(options *Options) { options.MaxConnectionsPerUser = 1 })
		token := validToken(t)
		first := harness.dial(t)
		readOpen(t, first)
		connectBrowser(t, first, NamespaceNewsnow, token, "o1", "u1")

		second := harness.dial(t)
		readOpen(t, second)
		beginConnect(t, second, NamespaceNewsnow, token)
		expectErrorEvent(t, second, NamespaceNewsnow, `{"code":"TOO_MANY_CONNECTIONS","message":"Too many connections"}`)
		expectFrame(t, second, "41/newsnow,")
		expectClosed(t, second)
		if failures := harness.limiter.failures(); len(failures) != 0 {
			t.Fatalf("connection cap must not record a failed auth, got %v", failures)
		}

		// The first socket is unaffected and still receives local pushes.
		harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "newsnow:update", json.RawMessage(`{"n":1}`))
		if event := readEvent(t, first); event.event != "newsnow:update" {
			t.Fatalf("first socket event = %q, want newsnow:update", event.event)
		}
	})
}

func TestConnectionCapsArePerNamespace(t *testing.T) {
	harness := newTestRuntime(t, func(options *Options) {
		options.MaxConnectionsPerUser = 1
		options.MaxConnectionsPerIP = 1
	})
	tokenU1 := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	tokenU2 := signToken(t, "u2", "o1", "", time.Now().Add(time.Hour))

	newsnow := harness.dial(t)
	readOpen(t, newsnow)
	connectBrowser(t, newsnow, NamespaceNewsnow, tokenU1, "o1", "u1")

	// Another namespace has its own counters: the same user and IP are fine.
	ops := harness.dial(t)
	readOpen(t, ops)
	connectBrowser(t, ops, NamespaceOps, tokenU2, "o1", "u2")

	// A second newsnow socket from the same IP is rejected by the IP cap even
	// though it belongs to a different user.
	rejected := harness.dial(t)
	readOpen(t, rejected)
	beginConnect(t, rejected, NamespaceNewsnow, tokenU2)
	expectErrorEvent(t, rejected, NamespaceNewsnow, `{"code":"TOO_MANY_CONNECTIONS","message":"Too many connections"}`)
	expectFrame(t, rejected, "41/newsnow,")
	expectClosed(t, rejected)

	if got := harness.runtime.LocalUsers(NamespaceNewsnow, "o1"); !reflect.DeepEqual(got, []string{"u1"}) {
		t.Fatalf("LocalUsers(newsnow, o1) = %v, want [u1]", got)
	}
	if got := harness.runtime.LocalUsers(NamespaceOps, "o1"); !reflect.DeepEqual(got, []string{"u2"}) {
		t.Fatalf("LocalUsers(ops, o1) = %v, want [u2]", got)
	}
}

func TestOriginAllowList(t *testing.T) {
	harness := newTestRuntime(t, func(options *Options) {
		options.CORS = cors.New("https://console.example")
	})
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))

	t.Run("allowed origin", func(t *testing.T) {
		conn := harness.dialWith(t, "", http.Header{"Origin": []string{"https://console.example"}})
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")
	})

	t.Run("rejected origin", func(t *testing.T) {
		conn := harness.dialWith(t, "", http.Header{"Origin": []string{"https://evil.example"}})
		readOpen(t, conn)
		beginConnect(t, conn, NamespaceNewsnow, token)
		expectErrorEvent(t, conn, NamespaceNewsnow, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
		expectFrame(t, conn, "41/newsnow,")
		expectClosed(t, conn)
		if failures := harness.limiter.failures(); len(failures) != 1 {
			t.Fatalf("recorded failures = %v, want 1 entry", failures)
		}
	})

	t.Run("missing origin is allowed", func(t *testing.T) {
		conn := harness.dial(t)
		readOpen(t, conn)
		connectBrowser(t, conn, NamespaceOps, token, "o1", "u1")
	})
}

func TestMultiplexedConnectionClosesEveryNamespace(t *testing.T) {
	harness := newTestRuntime(t, nil)
	harness.repository.setPermissions(permissionItemsRead)
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")
	connectBrowser(t, conn, NamespaceSituationMonitor, token, "o1", "u1")

	// The quality gate needs settings.manage, which this identity does not
	// have. The rejection performs disconnect(true) for the whole Engine.IO
	// connection: every connected namespace receives a DISCONNECT frame.
	beginConnect(t, conn, NamespaceQuality, token)
	expectErrorEvent(t, conn, NamespaceQuality, `{"code":"UNAUTHORIZED","message":"Unauthorized"}`)
	expectFrame(t, conn, "41/newsnow,")
	expectFrame(t, conn, "41/situation-monitor,")
	expectFrame(t, conn, "41/quality,")
	expectClosed(t, conn)

	waitFor(t, "every namespace index to be cleaned", func() bool {
		return len(harness.runtime.LocalUsers(NamespaceNewsnow, "o1")) == 0 &&
			len(harness.runtime.LocalUsers(NamespaceSituationMonitor, "o1")) == 0
	})
	waitFor(t, "the newsnow disconnect callback", func() bool {
		return harness.clientEvents.disconnectCount() == 1
	})
	disconnect := harness.clientEvents.disconnectSnapshot()[0]
	if disconnect.namespace != NamespaceNewsnow || disconnect.identity.UserID != "u1" || disconnect.identity.OrgID != "o1" {
		t.Fatalf("disconnect callback = %+v, want the newsnow socket of u1/o1", disconnect)
	}
}

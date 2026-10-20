//go:build integration

package realtimeintegration

import (
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
)

// TestRealtimeRevalidateIntegration covers B2 (identity revalidation):
//
//   - connect a queue socket, then deactivate the Membership row in MySQL;
//   - the transport must silently disconnect the socket within one
//     RevalidateInterval (namespace DISCONNECT frame, no queue:error event) and
//     close the underlying Engine.IO connection;
//   - restoring the membership allows a fresh connection to succeed again.
//
// The Redis-availability fail-open branch (infrastructure errors keep the
// connection alive) is intentionally not exercised here: closing the shared
// Redis would also break the rate limiter and blacklist fixtures of the same
// harness, which makes the scenario non-deterministic in CI.
func TestRealtimeRevalidateIntegration(t *testing.T) {
	h := newHarness(t)
	h.seedMember(t, "org-revalidate", "user-revalidate", "queue.manage")
	options := h.realtimeOptions()
	// 300ms keeps the "one cycle" assertion well inside the 5s test budget.
	options.RevalidateInterval = 300 * time.Millisecond
	runtime := h.newRealtimeRuntime(t, options)
	server := serveRealtime(t, runtime)
	token := h.accessToken(t, "user-revalidate", "org-revalidate")

	client := dialSocketClient(t, server.URL, realtimesocket.Path)
	_ = client.connectNamespace(t, realtimesocket.NamespaceQueue, map[string]any{"token": token})
	connected := client.waitEvent(t, realtimesocket.NamespaceQueue, "queue:connected", defaultFrameTimeout)
	payload := decodePayload[struct {
		OrgID  string `json:"orgId"`
		UserID string `json:"userId"`
	}](t, connected)
	if payload.OrgID != "org-revalidate" || payload.UserID != "user-revalidate" {
		t.Fatalf("queue:connected payload = %+v, want the fixture identity", payload)
	}

	// Revoke the membership after the socket is live; the next revalidation
	// tick must notice the authz rejection.
	h.setMembershipActive(t, "org-revalidate", "user-revalidate", false)

	client.waitDisconnect(t, realtimesocket.NamespaceQueue, testRevalidateTimeout)
	// The revalidation disconnect is silent: no <ns>:error event may precede
	// the DISCONNECT frame (NestJS socket-token-revalidation semantics).
	client.assertNoEvent(t, realtimesocket.NamespaceQueue, "queue:error")
	client.waitClosed(t, defaultFrameTimeout)

	// Restoring the Membership makes the authz re-derivation succeed again, so
	// a fresh connection must be accepted and join the rooms.
	h.setMembershipActive(t, "org-revalidate", "user-revalidate", true)
	reconnected := dialSocketClient(t, server.URL, realtimesocket.Path)
	_ = reconnected.connectNamespace(t, realtimesocket.NamespaceQueue, map[string]any{"token": token})
	reconnectedEvent := reconnected.waitEvent(t, realtimesocket.NamespaceQueue, "queue:connected", defaultFrameTimeout)
	reconnectedPayload := decodePayload[struct {
		OrgID  string `json:"orgId"`
		UserID string `json:"userId"`
	}](t, reconnectedEvent)
	if reconnectedPayload.OrgID != "org-revalidate" || reconnectedPayload.UserID != "user-revalidate" {
		t.Fatalf("reconnected queue:connected payload = %+v, want the fixture identity", reconnectedPayload)
	}
}

// testRevalidateTimeout is the upper bound for one revalidation cycle: the
// configured interval is 300ms, and the transport is allowed to need up to ten
// cycles before the assertion fails (still under the 5s budget).
const testRevalidateTimeout = 3 * time.Second

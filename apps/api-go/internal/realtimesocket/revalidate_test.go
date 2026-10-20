package realtimesocket

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// unitSocketState builds the minimal state keepSession inspects. The protocol
// session is not needed for the decision, so the unit tests avoid a live
// WebSocket.
func unitSocketState(namespace, userID, orgID, jti string) *socketState {
	return &socketState{
		spec:     namespaceSpecs[namespace],
		identity: ClientIdentity{SocketID: "sid-" + namespace, OrgID: orgID, UserID: userID},
		jti:      jti,
	}
}

func TestKeepSessionTokenExpiry(t *testing.T) {
	runtime, _, _, _ := newUnitRuntime(t, nil)
	ctx := context.Background()

	expired := unitSocketState(NamespaceNewsnow, "u1", "o1", "")
	expired.expiresAt = time.Now().Add(-time.Second)
	if runtime.keepSession(ctx, expired) {
		t.Fatal("keepSession() = true for an expired token, want false")
	}

	alive := unitSocketState(NamespaceNewsnow, "u1", "o1", "")
	alive.expiresAt = time.Now().Add(time.Hour)
	if !runtime.keepSession(ctx, alive) {
		t.Fatal("keepSession() = false for a valid token, want true")
	}
}

func TestKeepSessionBlacklist(t *testing.T) {
	t.Run("revoked token drops the socket", func(t *testing.T) {
		runtime, _, blacklist, _ := newUnitRuntime(t, nil)
		blacklist.setRevoked("jti-1", true)
		state := unitSocketState(NamespaceOps, "u1", "o1", "jti-1")
		if runtime.keepSession(context.Background(), state) {
			t.Fatal("keepSession() = true for a revoked token, want false")
		}
	})

	t.Run("blacklist failure fails open", func(t *testing.T) {
		runtime, _, blacklist, _ := newUnitRuntime(t, nil)
		blacklist.setError(errors.New("redis unavailable"))
		state := unitSocketState(NamespaceOps, "u1", "o1", "jti-1")
		if !runtime.keepSession(context.Background(), state) {
			t.Fatal("keepSession() = false on a blacklist infrastructure error, want fail-open true")
		}
	})
}

func TestKeepSessionAuthorization(t *testing.T) {
	t.Run("authz rejection drops the socket", func(t *testing.T) {
		runtime, _, _, repository := newUnitRuntime(t, nil)
		repository.setRejection("Organization access disabled")
		state := unitSocketState(NamespaceNewsnow, "u1", "o1", "")
		if runtime.keepSession(context.Background(), state) {
			t.Fatal("keepSession() = true for an authz rejection, want false")
		}
	})

	t.Run("authz failure fails open", func(t *testing.T) {
		runtime, _, _, repository := newUnitRuntime(t, nil)
		repository.setError(errors.New("mysql unavailable"))
		state := unitSocketState(NamespaceNewsnow, "u1", "o1", "")
		if !runtime.keepSession(context.Background(), state) {
			t.Fatal("keepSession() = false on an authz infrastructure error, want fail-open true")
		}
	})

	t.Run("lost permission drops the socket", func(t *testing.T) {
		runtime, _, _, repository := newUnitRuntime(t, nil)
		repository.setPermissions("unrelated.permission")
		state := unitSocketState(NamespaceQueue, "u1", "o1", "")
		if runtime.keepSession(context.Background(), state) {
			t.Fatal("keepSession() = true without queue.manage, want false")
		}
	})

	t.Run("valid identity and permission are kept", func(t *testing.T) {
		runtime, _, _, _ := newUnitRuntime(t, nil)
		state := unitSocketState(NamespaceQuality, "u1", "o1", "")
		if !runtime.keepSession(context.Background(), state) {
			t.Fatal("keepSession() = false for a valid quality identity, want true")
		}
	})
}

func TestKeepSessionCachesDerivationPerCycle(t *testing.T) {
	runtime, _, _, repository := newUnitRuntime(t, func(options *Options) {
		options.RevalidateInterval = 100 * time.Millisecond
	})
	state := unitSocketState(NamespaceNewsnow, "u1", "o1", "")
	ctx := context.Background()

	if !runtime.keepSession(ctx, state) {
		t.Fatal("first keepSession() = false, want true")
	}
	if !runtime.keepSession(ctx, state) {
		t.Fatal("second keepSession() = false, want true")
	}
	if calls := repository.callCount(); calls != 1 {
		t.Fatalf("authorization queries within one cycle = %d, want 1", calls)
	}

	time.Sleep(250 * time.Millisecond)
	if !runtime.keepSession(ctx, state) {
		t.Fatal("third keepSession() = false, want true")
	}
	if calls := repository.callCount(); calls != 2 {
		t.Fatalf("authorization queries after cache expiry = %d, want 2", calls)
	}
}

func TestRevalidationDisconnectIsSilent(t *testing.T) {
	// /quality is included on purpose: the NestJS gateway has no revalidation,
	// this batch enables it for all five namespaces.
	for _, namespace := range []string{NamespaceNewsnow, NamespaceQuality} {
		t.Run(namespace, func(t *testing.T) {
			harness := newTestRuntime(t, func(options *Options) {
				options.RevalidateInterval = 20 * time.Millisecond
			})
			conn := harness.dial(t)
			readOpen(t, conn)
			token := signToken(t, "u1", "o1", "jti-revalidate", time.Now().Add(time.Hour))
			connectBrowser(t, conn, namespace, token, "o1", "u1")

			harness.blacklist.setRevoked("jti-revalidate", true)

			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				frame, err := readFrame(conn, 2*time.Second)
				if err != nil {
					t.Fatalf("connection closed before the DISCONNECT frame: %v", err)
				}
				if strings.HasPrefix(frame, "42"+namespace+",") {
					t.Fatalf("revalidation emitted an event, want a silent disconnect: %q", frame)
				}
				if frame == "41"+namespace+"," {
					break
				}
				t.Fatalf("unexpected frame during revalidation: %q", frame)
			}
			expectClosed(t, conn)
			waitFor(t, "the namespace index to be empty", func() bool {
				return len(harness.runtime.LocalUsers(namespace, "o1")) == 0
			})
		})
	}
}

func TestRevalidationDropsRevokedMembership(t *testing.T) {
	harness := newTestRuntime(t, func(options *Options) {
		options.RevalidateInterval = 50 * time.Millisecond
	})
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")

	harness.repository.setRejection("Organization access disabled")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frame, err := readFrame(conn, 2*time.Second)
		if err != nil {
			t.Fatalf("connection closed before the DISCONNECT frame: %v", err)
		}
		if strings.HasPrefix(frame, "42/newsnow,") {
			t.Fatalf("revalidation emitted an event, want a silent disconnect: %q", frame)
		}
		if frame == "41/newsnow," {
			return
		}
		t.Fatalf("unexpected frame during revalidation: %q", frame)
	}
	t.Fatal("timed out waiting for the silent revalidation disconnect")
}

func TestRevalidationFailsOpenOnInfrastructureErrors(t *testing.T) {
	harness := newTestRuntime(t, func(options *Options) {
		options.RevalidateInterval = 20 * time.Millisecond
	})
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "jti-fail-open", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")

	harness.blacklist.setError(errors.New("redis unavailable"))
	harness.repository.setError(errors.New("mysql unavailable"))

	// Several revalidation ticks must leave the socket connected.
	time.Sleep(120 * time.Millisecond)
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "newsnow:update", json.RawMessage(`{"n":1}`))
	event := readEvent(t, conn)
	if event.event != "newsnow:update" {
		t.Fatalf("event after fail-open revalidation = %q, want newsnow:update", event.event)
	}
	if got := harness.runtime.LocalUsers(NamespaceNewsnow, "o1"); len(got) != 1 || got[0] != "u1" {
		t.Fatalf("LocalUsers(newsnow, o1) = %v, want [u1]", got)
	}
}

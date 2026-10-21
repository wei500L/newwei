package realtimesocket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newUpgradeRequest(method, path, rawQuery string, headers map[string]string) *http.Request {
	request := httptest.NewRequest(method, path+"?"+rawQuery, nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return request
}

func validUpgradeHeaders() map[string]string {
	return map[string]string{
		"Upgrade":    "websocket",
		"Connection": "keep-alive, Upgrade",
	}
}

func TestHandles(t *testing.T) {
	harness := newTestRuntime(t, nil)
	cases := []struct {
		name    string
		request *http.Request
		want    bool
	}{
		{
			name:    "trailing slash used by engine.io-client",
			request: newUpgradeRequest(http.MethodGet, Path+"/", "EIO=4&transport=websocket", validUpgradeHeaders()),
			want:    true,
		},
		{
			name:    "path without trailing slash",
			request: newUpgradeRequest(http.MethodGet, Path, "EIO=4&transport=websocket", validUpgradeHeaders()),
			want:    true,
		},
		{
			name:    "wrong path",
			request: newUpgradeRequest(http.MethodGet, "/socket.io/", "EIO=4&transport=websocket", validUpgradeHeaders()),
			want:    false,
		},
		{
			name:    "path prefix is not a match",
			request: newUpgradeRequest(http.MethodGet, Path+"-extra/", "EIO=4&transport=websocket", validUpgradeHeaders()),
			want:    false,
		},
		{
			name:    "post is not an upgrade",
			request: newUpgradeRequest(http.MethodPost, Path+"/", "EIO=4&transport=websocket", validUpgradeHeaders()),
			want:    false,
		},
		{
			name:    "missing upgrade header",
			request: newUpgradeRequest(http.MethodGet, Path+"/", "EIO=4&transport=websocket", map[string]string{"Connection": "Upgrade"}),
			want:    false,
		},
		{
			name:    "connection without upgrade token",
			request: newUpgradeRequest(http.MethodGet, Path+"/", "EIO=4&transport=websocket", map[string]string{"Upgrade": "websocket", "Connection": "keep-alive"}),
			want:    false,
		},
		{
			name:    "engine.io v3",
			request: newUpgradeRequest(http.MethodGet, Path+"/", "EIO=3&transport=websocket", validUpgradeHeaders()),
			want:    false,
		},
		{
			name:    "polling transport",
			request: newUpgradeRequest(http.MethodGet, Path+"/", "EIO=4&transport=polling", validUpgradeHeaders()),
			want:    false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := harness.runtime.Handles(testCase.request); got != testCase.want {
				t.Fatalf("Handles() = %v, want %v", got, testCase.want)
			}
		})
	}
	if harness.runtime.Handles(nil) {
		t.Fatal("Handles(nil) = true, want false")
	}
}

func TestStartIsANoop(t *testing.T) {
	harness := newTestRuntime(t, nil)
	if err := harness.runtime.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
}

func TestServeHTTPRejectsForeignRequests(t *testing.T) {
	harness := newTestRuntime(t, nil)
	recorder := httptest.NewRecorder()
	request := newUpgradeRequest(http.MethodGet, "/socket.io/", "EIO=4&transport=websocket", validUpgradeHeaders())
	harness.runtime.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("ServeHTTP status = %d, want 400", recorder.Code)
	}
}

func TestCloseClosesTransportAndIsIdempotent(t *testing.T) {
	harness := newTestRuntime(t, nil)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))

	newsnow := harness.dial(t)
	readOpen(t, newsnow)
	connectBrowser(t, newsnow, NamespaceNewsnow, token, "o1", "u1")

	ops := harness.dial(t)
	readOpen(t, ops)
	connectBrowser(t, ops, NamespaceOps, token, "o1", "u1")

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := harness.runtime.Close(ctx); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	// socket.io Server#close only closes the Engine.IO transports: the browser
	// must observe a transport close (and then reconnect), never a Socket.IO
	// DISCONNECT packet "41/<ns>,". Session contexts are still cancelled and
	// Handler.Disconnect runs exactly once per namespace socket.
	if frame, err := readFrame(newsnow, 2*time.Second); err == nil {
		t.Fatalf("expected a transport close without a DISCONNECT packet, read %q", frame)
	}
	if frame, err := readFrame(ops, 2*time.Second); err == nil {
		t.Fatalf("expected a transport close without a DISCONNECT packet, read %q", frame)
	}
	waitFor(t, "all namespace indexes to be empty", func() bool {
		return len(harness.runtime.LocalUsers(NamespaceNewsnow, "o1")) == 0 &&
			len(harness.runtime.LocalUsers(NamespaceOps, "o1")) == 0
	})
	waitFor(t, "the newsnow disconnect callback", func() bool {
		return harness.clientEvents.disconnectCount() == 1
	})

	if err := harness.runtime.Close(ctx); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}

	recorder := httptest.NewRecorder()
	request := newUpgradeRequest(http.MethodGet, Path+"/", "EIO=4&transport=websocket", validUpgradeHeaders())
	harness.runtime.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("ServeHTTP after Close status = %d, want 503", recorder.Code)
	}
}

func TestNewAppliesNestDefaults(t *testing.T) {
	runtime, err := New(Options{
		Verifier:  newTestVerifier(),
		Blacklist: newFakeBlacklist(),
		Authz:     newFakeAuthzRepository(),
		limiter:   newFakeLimiter(),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		if closeErr := runtime.Close(ctx); closeErr != nil {
			t.Errorf("Runtime.Close() error = %v", closeErr)
		}
	}()
	if runtime.revalidateInterval != defaultRevalidateInterval {
		t.Fatalf("revalidateInterval = %v, want %v", runtime.revalidateInterval, defaultRevalidateInterval)
	}
	if runtime.maxConnectionsPerUser != defaultMaxConnectionsPerUser {
		t.Fatalf("maxConnectionsPerUser = %d, want %d", runtime.maxConnectionsPerUser, defaultMaxConnectionsPerUser)
	}
	if runtime.maxConnectionsPerIP != defaultMaxConnectionsPerIP {
		t.Fatalf("maxConnectionsPerIP = %d, want %d", runtime.maxConnectionsPerIP, defaultMaxConnectionsPerIP)
	}
}

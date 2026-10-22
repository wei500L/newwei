package aisrelay

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Upstream tests: the AISStream subscribe payload, the reconnect backoff, the
// handshake timeout and the close/reason bookkeeping.
//
// The websocket coverage runs against a loopback httptest server (plus one raw TCP
// listener for the handshake case), so nothing here needs network access beyond
// 127.0.0.1. Every duration is injected - client fields, a stub random, or a wake
// nudge - so no test waits out the production 5s/15s/60s timers.

// upstreamTestSocketTimeout bounds each websocket wait in these tests. It is a test
// guard, not a production value: a healthy loopback handshake and read complete in
// microseconds.
const upstreamTestSocketTimeout = 5 * time.Second

// upstreamTestConfig is the base configuration for the upstream tests. Only the API
// key and the queue sizing matter here; the HTTP listener fields stay zero because
// these tests never start the relay's HTTP server.
func upstreamTestConfig() Config {
	return Config{
		UpstreamURL:          "ws://127.0.0.1:1/stream",
		UpstreamAPIKey:       "test-api-key",
		UpstreamQueueHardCap: 8,
		UpstreamDrainBatch:   4,
		UpstreamDrainBudget:  20 * time.Millisecond,
	}
}

// upstreamTestNewClient builds an engine and its upstream client with the production
// backoff/handshake defaults, so each test overrides only the fields it cares about.
func upstreamTestNewClient(cfg Config) (*engine, *upstreamClient) {
	e := newEngine(cfg, nil)
	return e, newUpstreamClient(e, cfg)
}

// upstreamTestAttempt reads the backoff attempt counter under the client mutex.
func upstreamTestAttempt(u *upstreamClient) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.attempt
}

// upstreamTestUpstreamState reads the upstream bookkeeping under the engine mutex. The
// supervisor goroutine writes these fields, so assertions made while it runs must take
// the same lock to stay race free.
func upstreamTestUpstreamState(e *engine) (connState, *string, int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state, e.lastUpstreamErrorMessage, e.lastUpstreamErrorAt
}

// upstreamTestWebsocketURL turns an httptest base URL (http://host:port) into the ws
// URL the upstream client dials.
func upstreamTestWebsocketURL(server *httptest.Server) string {
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

// upstreamTestRecv waits for one value on ch and fails the test when the timeout
// expires. Tests wait on the code's own timers instead of sleeping for them.
func upstreamTestRecv[T any](t *testing.T, ch <-chan T, timeout time.Duration, description string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(timeout):
		var zero T
		t.Fatalf("timed out after %v waiting for %s", timeout, description)
		return zero
	}
}

// TestUpstreamSubscriptionPayload pins the subscribe message byte for byte.
//
// The payload is the AISStream contract: member order APIKey, BoundingBoxes,
// FilterMessageTypes comes from the upstreamSubscription field order, the bounding box
// holds integer corners covering the whole world, and exactly one message type is
// filtered. subscriptionPayload is asserted directly because the bytes are
// deterministic; TestUpstreamSubscriptionArrivesOnSocket then checks that these are the
// bytes that reach the peer.
func TestUpstreamSubscriptionPayload(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		apiKey string
		want   string
	}{
		{
			name:   "plain key",
			apiKey: "test-api-key",
			want:   `{"APIKey":"test-api-key","BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport"]}`,
		},
		{
			name:   "quote in key is escaped",
			apiKey: `k"ey`,
			// A double quote inside a JSON string is escaped as \" by both
			// JSON.stringify and encoding/json, so the key renders as k\"ey.
			want: `{"APIKey":"k\"ey","BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport"]}`,
		},
		{
			name:   "html characters stay raw",
			apiKey: "a<b&c>d",
			// encodeJSJSON disables encoding/json's HTML escaping, so <, > and & are
			// emitted raw exactly like JSON.stringify does; an escaped \u003c would make
			// the two relays send different subscribe frames.
			want: `{"APIKey":"a<b&c>d","BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport"]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			cfg := upstreamTestConfig()
			cfg.UpstreamAPIKey = tt.apiKey
			_, client := upstreamTestNewClient(cfg)

			if got := string(client.subscriptionPayload()); got != tt.want {
				t.Fatalf("subscriptionPayload() = %s, want %s", got, tt.want)
			}
			// The payload is pure, so a second call must render the same bytes; the
			// connect path calls it once per connection.
			if got := string(client.subscriptionPayload()); got != tt.want {
				t.Fatalf("second subscriptionPayload() call = %s, want %s", got, tt.want)
			}
		})
	}
}

// TestUpstreamSubscriptionArrivesOnSocket connects once and asserts that the frame the
// server reads is exactly the payload subscriptionPayload renders.
func TestUpstreamSubscriptionArrivesOnSocket(t *testing.T) {
	cfg := upstreamTestConfig()
	cfg.UpstreamAPIKey = `k"ey`

	received := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()

		// The request context is released once the handler returns, so the read gets its
		// own budget instead of inheriting the HTTP request lifetime.
		readCtx, cancelRead := context.WithTimeout(context.Background(), upstreamTestSocketTimeout)
		defer cancelRead()
		_, data, err := conn.Read(readCtx)
		if err != nil {
			return
		}
		received <- append([]byte(nil), data...)
	}))
	defer server.Close()

	_, client := upstreamTestNewClient(cfg)
	client.url = upstreamTestWebsocketURL(server)
	client.handshakeTimeout = upstreamTestSocketTimeout

	ctx, cancel := context.WithTimeout(t.Context(), upstreamTestSocketTimeout)
	defer cancel()

	// connectOnce streams until the peer ends the connection, which the handler does
	// when it returns, so the call terminates on its own once the frame is recorded.
	if err := client.connectOnce(ctx); err == nil {
		t.Fatal("connectOnce returned nil although the server ended the stream")
	}

	got := string(upstreamTestRecv(t, received, upstreamTestSocketTimeout, "subscription frame"))
	want := `{"APIKey":"k\"ey","BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport"]}`
	if got != want {
		t.Fatalf("subscription frame on the socket = %s, want %s", got, want)
	}
	if wantAgain := string(client.subscriptionPayload()); got != wantAgain {
		t.Fatalf("subscription frame on the socket = %s, want subscriptionPayload() %s", got, wantAgain)
	}
}

// TestUpstreamReconnectBackoffSequence pins the exact delay sequence.
//
// nextDelay reproduces scheduleReconnect, whose values are milliseconds:
//
//	attempt = min(attempt + 1, 8)
//	base    = 5000 * 2^(attempt-1)
//	capped  = min(base, 60000)
//	jittered = max(1000, round(capped * (0.8 + random*0.4)))
//
// The cap is applied before the jitter, so from the fifth attempt on the delay can
// reach 72000 ms (60000 * 1.2). Every row runs ten consecutive nextDelay() calls with a
// stubbed random value, which also covers the attempt saturation at 8.
func TestUpstreamReconnectBackoffSequence(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		random float64
		want   []time.Duration
	}{
		{
			name:   "lower jitter bound",
			random: 0,
			// factor = 0.8 + 0*0.4 = 0.8:
			// attempt 1: base = 5000*2^0   = 5000  ms -> 4000
			// attempt 2: base = 5000*2^1   = 10000 ms -> 8000
			// attempt 3: base = 5000*2^2   = 20000 ms -> 16000
			// attempt 4: base = 5000*2^3   = 40000 ms -> 32000
			// attempt 5: base = 5000*2^4   = 80000 ms, capped at 60000 ms -> 48000
			// attempts 6..10 stay at the 60000 ms cap because attempt saturated at 8.
			want: []time.Duration{
				4000 * time.Millisecond, 8000 * time.Millisecond, 16000 * time.Millisecond,
				32000 * time.Millisecond, 48000 * time.Millisecond, 48000 * time.Millisecond,
				48000 * time.Millisecond, 48000 * time.Millisecond, 48000 * time.Millisecond,
				48000 * time.Millisecond,
			},
		},
		{
			name:   "middle of the jitter window",
			random: 0.25,
			// factor = 0.8 + 0.25*0.4 = 0.9: 4500, 9000, 18000, 36000 then the cap gives
			// 60000*0.9 = 54000 for attempts 5..10.
			want: []time.Duration{
				4500 * time.Millisecond, 9000 * time.Millisecond, 18000 * time.Millisecond,
				36000 * time.Millisecond, 54000 * time.Millisecond, 54000 * time.Millisecond,
				54000 * time.Millisecond, 54000 * time.Millisecond, 54000 * time.Millisecond,
				54000 * time.Millisecond,
			},
		},
		{
			name:   "upper jitter bound",
			random: 0.75,
			// factor = 0.8 + 0.75*0.4 = 1.1: 5500, 11000, 22000, 44000 and then
			// 60000*1.1 = 66000, i.e. the jitter may exceed the 60s cap by 10%.
			want: []time.Duration{
				5500 * time.Millisecond, 11000 * time.Millisecond, 22000 * time.Millisecond,
				44000 * time.Millisecond, 66000 * time.Millisecond, 66000 * time.Millisecond,
				66000 * time.Millisecond, 66000 * time.Millisecond, 66000 * time.Millisecond,
				66000 * time.Millisecond,
			},
		},
		{
			name:   "near the top of [0,1)",
			random: 0.9999,
			// factor = 0.8 + 0.9999*0.4 = 1.19996:
			// 5000  -> 5999.8  -> round 6000
			// 10000 -> 11999.6 -> round 12000
			// 20000 -> 23999.2 -> round 23999
			// 40000 -> 47998.4 -> round 47998
			// 60000 (capped) -> 71997.6 -> round 71998
			want: []time.Duration{
				6000 * time.Millisecond, 12000 * time.Millisecond, 23999 * time.Millisecond,
				47998 * time.Millisecond, 71998 * time.Millisecond, 71998 * time.Millisecond,
				71998 * time.Millisecond, 71998 * time.Millisecond, 71998 * time.Millisecond,
				71998 * time.Millisecond,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, client := upstreamTestNewClient(upstreamTestConfig())
			client.random = func() float64 { return tt.random }

			for index, wantDelay := range tt.want {
				attempt := index + 1
				if attempt > reconnectMaxAttemptShift {
					attempt = reconnectMaxAttemptShift
				}
				// The expected values are milliseconds, as in the Node relay. If this
				// reports values in the millions, nextDelay is treating the nanosecond
				// magnitude of baseDelay as milliseconds: the JS formula above works on
				// millisecond numbers, so the duration must be divided by
				// time.Millisecond before the arithmetic.
				if got := client.nextDelay(); got != wantDelay {
					t.Fatalf("nextDelay() call %d (attempt %d) = %v, want %v", index+1, attempt, got, wantDelay)
				}
			}
			if got := upstreamTestAttempt(client); got != reconnectMaxAttemptShift {
				t.Fatalf("attempt after %d calls = %d, want the %d shift cap", len(tt.want), got, reconnectMaxAttemptShift)
			}
		})
	}
}

// TestUpstreamReconnectBackoffFloor covers the Math.max(1000, ...) floor.
//
// With the production 5s base the floor is unreachable (attempt 1 already jitters to
// 4000-6000 ms), so the base is lowered to 100 ms and the random stub is pinned to 0.
func TestUpstreamReconnectBackoffFloor(t *testing.T) {
	t.Parallel()

	_, client := upstreamTestNewClient(upstreamTestConfig())
	client.baseDelay = 100 * time.Millisecond
	client.maxDelay = 60 * time.Second
	client.random = func() float64 { return 0 }

	// attempt n: base = 100ms * 2^(n-1); the 0.8 factor gives 80, 160, 320, 640, 1280,
	// 2560, 5120, 10240 ms. The first four fall below minimumBackoff (1000 ms) and are
	// clamped to exactly 1000 ms; from attempt 5 the computed value wins. Attempts 9 and
	// 10 repeat attempt 8 because the counter saturates at reconnectMaxAttemptShift.
	want := []time.Duration{
		1000 * time.Millisecond, 1000 * time.Millisecond, 1000 * time.Millisecond,
		1000 * time.Millisecond, 1280 * time.Millisecond, 2560 * time.Millisecond,
		5120 * time.Millisecond, 10240 * time.Millisecond, 10240 * time.Millisecond,
		10240 * time.Millisecond,
	}

	for index, wantDelay := range want {
		if got := client.nextDelay(); got != wantDelay {
			t.Fatalf("nextDelay() call %d = %v, want %v", index+1, got, wantDelay)
		}
	}
	if got := upstreamTestAttempt(client); got != reconnectMaxAttemptShift {
		t.Fatalf("attempt after %d calls = %d, want %d", len(want), got, reconnectMaxAttemptShift)
	}
}

// TestUpstreamReconnectAttemptSaturationAndReset asserts that the counter stops at the
// shift cap and that a successful handshake clears it.
func TestUpstreamReconnectAttemptSaturationAndReset(t *testing.T) {
	t.Parallel()

	_, client := upstreamTestNewClient(upstreamTestConfig())
	client.random = func() float64 { return 0 }

	for call := 1; call <= reconnectMaxAttemptShift; call++ {
		_ = client.nextDelay()
	}
	if got := upstreamTestAttempt(client); got != reconnectMaxAttemptShift {
		t.Fatalf("attempt after %d calls = %d, want %d", reconnectMaxAttemptShift, got, reconnectMaxAttemptShift)
	}

	// Calls 9 and 10 must not grow the counter: attempt 8 = 5000*2^7 = 640000 ms capped
	// at 60000 ms, jittered with factor 0.8 to 48000 ms.
	for call := 9; call <= 10; call++ {
		if got, want := client.nextDelay(), 48000*time.Millisecond; got != want {
			t.Fatalf("nextDelay() call %d = %v, want the capped %v", call, got, want)
		}
	}
	if got := upstreamTestAttempt(client); got != reconnectMaxAttemptShift {
		t.Fatalf("attempt after 10 calls = %d, want %d", got, reconnectMaxAttemptShift)
	}

	// resetAttempt mirrors the Node open handler, so the next failure waits the first
	// attempt delay (5000*2^0*0.8 = 4000 ms) instead of resuming at the cap.
	client.resetAttempt()
	if got := upstreamTestAttempt(client); got != 0 {
		t.Fatalf("attempt after resetAttempt() = %d, want 0", got)
	}
	if got := client.nextDelay(); got != 4000*time.Millisecond {
		t.Fatalf("nextDelay() after resetAttempt() = %v, want 4000ms", got)
	}
	if got := upstreamTestAttempt(client); got != 1 {
		t.Fatalf("attempt after one post-reset nextDelay() = %d, want 1", got)
	}
}

// TestUpstreamCloseReasonMapping pins the diagnostic text of recordUpstreamClose:
// "close <code>" when the reason is empty or whitespace only, otherwise
// "close <code>: <reason>" with the reason JS-trimmed.
func TestUpstreamCloseReasonMapping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		code   int
		reason string
		want   string
	}{
		{
			name:   "abnormal close without reason",
			code:   statusAbnormalClosure,
			reason: "",
			want:   "close 1006",
		},
		{
			name:   "ascii whitespace reason is dropped",
			code:   statusAbnormalClosure,
			reason: " \t\n",
			want:   "close 1006",
		},
		{
			// U+00A0 is ECMAScript WhiteSpace, so String.prototype.trim removes it even
			// though an ASCII-only trim would keep it and emit "close 1006: \u00a0".
			name:   "js whitespace reason is dropped",
			code:   1006,
			reason: "\u00a0",
			want:   "close 1006",
		},
		{
			name:   "normal close with reason",
			code:   1000,
			reason: "normal shutdown",
			want:   "close 1000: normal shutdown",
		},
		{
			// jsTrim removes both the leading spaces and the trailing NBSP, so the
			// rendered text contains neither.
			name:   "reason is trimmed",
			code:   1001,
			reason: "  going away\u00a0",
			want:   "close 1001: going away",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			e := newEngine(upstreamTestConfig(), nil)
			e.recordUpstreamClose(tt.code, tt.reason)

			state, message, errorAt := upstreamTestUpstreamState(e)
			if state != connIdle {
				t.Fatalf("state after recordUpstreamClose = %d, want connIdle", state)
			}
			if message == nil {
				t.Fatalf("lastUpstreamErrorMessage is nil after recordUpstreamClose(%d, %q)", tt.code, tt.reason)
			}
			if *message != tt.want {
				t.Fatalf("lastUpstreamErrorMessage = %q, want %q", *message, tt.want)
			}
			if errorAt <= 0 {
				t.Fatalf("lastUpstreamErrorAt = %d, want a positive epoch millisecond value", errorAt)
			}
		})
	}
}

// TestUpstreamCloseDetails covers the close-code extraction that feeds the mapping
// above: a close frame keeps its code and reason, any other read error is the abnormal
// closure ws reports as 1006, and a non-positive code also collapses to 1006.
func TestUpstreamCloseDetails(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        error
		wantCode   int
		wantReason string
	}{
		{
			name:       "plain read error is an abnormal closure",
			err:        errors.New("connection reset by peer"),
			wantCode:   statusAbnormalClosure,
			wantReason: "",
		},
		{
			name:       "close frame keeps code and reason",
			err:        websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: "bye"},
			wantCode:   1000,
			wantReason: "bye",
		},
		{
			name:       "wrapped close frame is unwrapped",
			err:        fmt.Errorf("received close frame: %w", websocket.CloseError{Code: websocket.StatusGoingAway, Reason: "restart"}),
			wantCode:   1001,
			wantReason: "restart",
		},
		{
			// 1005 (StatusNoStatusRcvd) means "no code was sent" and cannot be rendered,
			// so it is treated as the abnormal closure.
			name:       "zero close code falls back to 1006",
			err:        websocket.CloseError{},
			wantCode:   statusAbnormalClosure,
			wantReason: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			code, reason := closeDetails(tt.err)
			if code != tt.wantCode || reason != tt.wantReason {
				t.Fatalf("closeDetails(%v) = (%d, %q), want (%d, %q)", tt.err, code, reason, tt.wantCode, tt.wantReason)
			}
		})
	}
}

// TestUpstreamReconnectsAfterDisconnect runs the supervisor against a server that ends
// the first stream with a close frame and asserts that a second connection is opened and
// subscribed to.
func TestUpstreamReconnectsAfterDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())

	subscriptions := make(chan string, 4)
	var mu sync.Mutex
	connections := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()

		mu.Lock()
		connections++
		attempt := connections
		mu.Unlock()

		readCtx, cancelRead := context.WithTimeout(context.Background(), upstreamTestSocketTimeout)
		defer cancelRead()
		_, data, err := conn.Read(readCtx)
		if err != nil {
			return
		}
		subscriptions <- string(data)

		if attempt == 1 {
			// End the first stream with an explicit close frame: the supervisor records
			// "close 1000: server restart" and schedules a reconnect.
			_ = conn.Close(websocket.StatusNormalClosure, "server restart")
			return
		}
		// Later connections stay open so the state assertion below observes connOpen;
		// cancelling the test context ends them.
		<-ctx.Done()
	}))
	t.Cleanup(func() {
		cancel()
		server.Close()
	})

	_, client := upstreamTestNewClient(upstreamTestConfig())
	client.url = upstreamTestWebsocketURL(server)
	client.handshakeTimeout = upstreamTestSocketTimeout
	client.baseDelay = 10 * time.Millisecond
	client.maxDelay = 20 * time.Millisecond
	client.random = func() float64 { return 0.5 }

	client.start(ctx)

	// The delay is never below minimumBackoff (1s) and grows from there, so the
	// reconnect is not waited out: wakeNow takes run()'s immediate-retry branch, which
	// is the Go equivalent of connectUpstream clearing the pending reconnect timer when
	// a request arrives. A wake with no receiver is dropped by design, hence the
	// repeated nudges until the supervisor reaches that select.
	nudgeDone := make(chan struct{})
	go func() {
		defer close(nudgeDone)
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				client.wakeNow()
			}
		}
	}()

	first := upstreamTestRecv(t, subscriptions, upstreamTestSocketTimeout, "first subscription")
	second := upstreamTestRecv(t, subscriptions, upstreamTestSocketTimeout, "second subscription after the reconnect")

	if second != first {
		t.Fatalf("subscription after the reconnect = %s, want the first one %s", second, first)
	}
	if want := string(client.subscriptionPayload()); second != want {
		t.Fatalf("subscription after the reconnect = %s, want %s", second, want)
	}

	mu.Lock()
	gotConnections := connections
	mu.Unlock()
	if gotConnections < 2 {
		t.Fatalf("server accepted %d connections, want at least 2", gotConnections)
	}

	state, message, errorAt := upstreamTestUpstreamState(client.engine)
	if state != connOpen {
		t.Fatalf("state after the reconnect = %d, want connOpen", state)
	}
	// The close frame carried code 1000 and reason "server restart", and the second
	// handshake only overwrote the connected-at timestamp, not the recorded failure.
	if message == nil {
		t.Fatal("lastUpstreamErrorMessage is nil, want the close text of the first stream")
	}
	if *message != "close 1000: server restart" {
		t.Fatalf("lastUpstreamErrorMessage = %q, want %q", *message, "close 1000: server restart")
	}
	if errorAt <= 0 {
		t.Fatalf("lastUpstreamErrorAt = %d, want a positive epoch millisecond value", errorAt)
	}

	cancel()
	<-nudgeDone
}

// TestUpstreamHandshakeTimeout drives a dial against a listener that accepts the TCP
// connection and never answers the upgrade, so only the handshake deadline can end it.
func TestUpstreamHandshakeTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	// A raw accepted-and-ignored socket is what makes this a timeout: an httptest server
	// would complete the upgrade instead.
	var mu sync.Mutex
	var accepted []net.Conn
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			mu.Lock()
			accepted = append(accepted, conn)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		<-acceptDone
		mu.Lock()
		defer mu.Unlock()
		for _, conn := range accepted {
			_ = conn.Close()
		}
	})

	_, client := upstreamTestNewClient(upstreamTestConfig())
	client.url = "ws://" + listener.Addr().String() + "/stream"
	client.handshakeTimeout = 150 * time.Millisecond

	// The supervisor marks a handshake in flight before every connectOnce, which is the
	// state the timeout must clear.
	client.engine.beginUpstreamConnect()
	if state, _, _ := upstreamTestUpstreamState(client.engine); state != connConnecting {
		t.Fatalf("state before the dial = %d, want connConnecting", state)
	}

	startedAt := time.Now()
	dialErr := client.connectOnce(t.Context())
	elapsed := time.Since(startedAt)

	if dialErr == nil {
		t.Fatal("connectOnce returned nil although the peer never completed the upgrade")
	}
	// The dial can only return once the 150ms budget expires; a faster return would mean
	// the listener caused an immediate failure rather than a handshake timeout.
	if elapsed < 100*time.Millisecond {
		t.Fatalf("connectOnce returned after %v, before the 150ms handshake deadline", elapsed)
	}

	state, message, errorAt := upstreamTestUpstreamState(client.engine)
	if state != connIdle {
		t.Fatalf("state after the timeout = %d, want connIdle", state)
	}
	// The Node relay ends up with the same close text: its handshake timer stores
	// "connection handshake timed out", then socket.terminate() emits `close` with code
	// 1006 and the close handler overwrites the stored message, so "close 1006" is the
	// only observable value. connectOnce records it for the dial failure as well.
	if message == nil {
		t.Fatal("lastUpstreamErrorMessage is nil, want the abnormal close text")
	}
	if *message != "close 1006" {
		t.Fatalf("lastUpstreamErrorMessage = %q, want %q", *message, "close 1006")
	}
	if errorAt <= 0 {
		t.Fatalf("lastUpstreamErrorAt = %d, want a positive epoch millisecond value", errorAt)
	}
}

package aisrelay

import (
	"context"
	"errors"
	"log"
	"math"
	"math/rand"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Upstream AISStream client.
//
// The Node relay drives its connection from websocket events: `open` sends the
// subscription, `message` feeds the backpressure queue, `close` schedules a reconnect
// and `error` records the failure. Go has no event loop, so a supervisor goroutine runs
// the same state machine as a loop: connect, subscribe, read until the stream ends, wait
// out the backoff, repeat.
//
// Two Node defects found while porting are not reproduced (see the PR description):
//
//   - the Node `error` handler has no stale-socket guard, so a socket that has already
//     been replaced can still overwrite the recorded upstream error; here a connection
//     is owned by exactly one iteration of the loop, so no generation check is needed,
//   - Node's error message and close message both write the same fields, so the
//     observable last error is always the close text; this port writes only the close
//     text and documents the reasoning on recordUpstreamClose.

// statusAbnormalClosure is the close code reported when a connection dies without a
// close frame, which is what the ws client in Node reports as 1006.
const statusAbnormalClosure = 1006

// minimumBackoff mirrors the `Math.max(1000, ...)` floor in scheduleReconnect.
const minimumBackoff = time.Second

// upstreamSubscription is the AISStream subscribe message. The member order, the
// integer bounding box corners and the single PositionReport filter must match the Node
// payload exactly; consumers and the upstream both treat this as a fixed contract.
type upstreamSubscription struct {
	APIKey             string     `json:"APIKey"`
	BoundingBoxes      [][][2]int `json:"BoundingBoxes"`
	FilterMessageTypes []string   `json:"FilterMessageTypes"`
}

// upstreamClient owns the upstream connection lifecycle.
type upstreamClient struct {
	engine *engine
	url    string
	apiKey string

	handshakeTimeout time.Duration
	baseDelay        time.Duration
	maxDelay         time.Duration
	// random returns a value in [0,1) for the backoff jitter. It is a field so tests can
	// assert the deterministic part of the reconnect sequence.
	random func() float64

	mu      sync.Mutex
	started bool
	attempt int

	// wake asks the supervisor to retry immediately instead of waiting out the backoff.
	// It is unbuffered so a wake sent while the stream is healthy is dropped rather than
	// being applied to a later outage.
	wake chan struct{}
}

// newUpstreamClient builds the upstream client for a configuration.
func newUpstreamClient(engine *engine, cfg Config) *upstreamClient {
	return &upstreamClient{
		engine:           engine,
		url:              cfg.UpstreamURL,
		apiKey:           cfg.UpstreamAPIKey,
		handshakeTimeout: upstreamHandshakeTimeout,
		baseDelay:        reconnectBaseDelay,
		maxDelay:         reconnectMaxDelay,
		random:           rand.Float64,
		wake:             make(chan struct{}),
	}
}

// start launches the supervisor goroutine. It is safe to call more than once.
func (u *upstreamClient) start(ctx context.Context) {
	u.mu.Lock()
	if u.started {
		u.mu.Unlock()
		return
	}
	u.started = true
	u.mu.Unlock()
	go u.run(ctx)
}

// wakeNow asks the supervisor to retry immediately, matching connectUpstream's effect
// of clearing the pending reconnect timer when a request arrives.
func (u *upstreamClient) wakeNow() {
	select {
	case u.wake <- struct{}{}:
	default:
	}
}

// run is the connection supervisor: dial, stream, wait, repeat.
func (u *upstreamClient) run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		u.engine.beginUpstreamConnect()
		_ = u.connectOnce(ctx)
		if ctx.Err() != nil {
			u.engine.finishUpstreamConnect()
			return
		}

		delay := u.nextDelay()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			u.engine.finishUpstreamConnect()
			return
		case <-u.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// connectOnce opens one connection and streams until it ends. It returns when the
// stream is over, either because the dial failed or because the read loop stopped.
func (u *upstreamClient) connectOnce(ctx context.Context) error {
	log.Printf("[ais-relay] connecting to %s", u.url)

	// The handshake budget is the context passed to Dial: coder/websocket uses that
	// context only for the upgrade request and the returned connection does not observe
	// it, so the cancel below cannot tear down the established stream. The Node relay
	// needs its own timer because the ws client has no handshake timeout at all, and a
	// black-holed DNS path would leave the socket in CONNECTING forever.
	dialCtx, cancelDial := context.WithTimeout(ctx, u.handshakeTimeout)
	conn, _, err := websocket.Dial(dialCtx, u.url, nil)
	cancelDial()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			log.Print("[ais-relay] upstream handshake timed out; terminating")
		} else {
			log.Printf("[ais-relay] upstream error: %v", err)
		}
		// Both Node paths end in the close handler (the handshake timer terminates the
		// socket, which emits `close`), so the observable failure is the abnormal close.
		u.engine.recordUpstreamClose(statusAbnormalClosure, "")
		return err
	}

	u.engine.markUpstreamOpen()
	u.resetAttempt()

	writeCtx, cancelWrite := context.WithTimeout(ctx, u.handshakeTimeout)
	writeErr := conn.Write(writeCtx, websocket.MessageText, u.subscriptionPayload())
	cancelWrite()
	if writeErr != nil {
		log.Printf("[ais-relay] upstream subscription failed: %v", writeErr)
		_ = conn.CloseNow()
		u.engine.recordUpstreamClose(statusAbnormalClosure, "")
		return writeErr
	}

	for {
		_, data, readErr := conn.Read(ctx)
		if readErr != nil {
			if ctx.Err() != nil {
				// Shutdown: close politely, mirroring closeUpstreamSocketForShutdown
				// which sends a close frame for an OPEN socket.
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return readErr
			}
			code, reason := closeDetails(readErr)
			_ = conn.CloseNow()
			u.engine.recordUpstreamClose(code, reason)
			return readErr
		}
		u.engine.submitUpstreamMessage(data)
	}
}

// subscriptionPayload renders the subscribe message.
func (u *upstreamClient) subscriptionPayload() []byte {
	encoded, err := encodeJSJSON(upstreamSubscription{
		APIKey:             u.apiKey,
		BoundingBoxes:      [][][2]int{{{-90, -180}, {90, 180}}},
		FilterMessageTypes: []string{"PositionReport"},
	})
	if err != nil {
		// Unreachable: the payload is a string, integers and a string slice.
		return nil
	}
	return encoded
}

// resetAttempt clears the backoff after a successful handshake, as the Node open
// handler does.
func (u *upstreamClient) resetAttempt() {
	u.mu.Lock()
	u.attempt = 0
	u.mu.Unlock()
}

// nextDelay reproduces scheduleReconnect's exponential backoff with jitter:
//
//	reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
//	base = 5000 * 2 ** (attempt - 1);
//	capped = Math.min(base, 60000);
//	jittered = Math.max(1000, Math.round(capped * (0.8 + Math.random() * 0.4)));
//
// The capped value therefore jitters within +/-20%: 4-6s, 8-12s, 16-24s, 32-48s and
// 48-72s once the cap engages from the fifth attempt onwards.
//
// The arithmetic runs in whole milliseconds because that is the unit the Node code works
// in: converting the durations up front keeps the returned duration from being scaled by
// 1e6 when the nanosecond values are reinterpreted as milliseconds.
func (u *upstreamClient) nextDelay() time.Duration {
	u.mu.Lock()
	if u.attempt < reconnectMaxAttemptShift {
		u.attempt++
	}
	attempt := u.attempt
	u.mu.Unlock()

	baseMillis := float64(u.baseDelay/time.Millisecond) * math.Pow(2, float64(attempt-1))
	cappedMillis := math.Min(baseMillis, float64(u.maxDelay/time.Millisecond))
	jitteredMillis := math.Max(
		float64(minimumBackoff/time.Millisecond),
		math.Round(cappedMillis*(0.8+u.random()*0.4)),
	)
	return time.Duration(jitteredMillis) * time.Millisecond
}

// closeDetails extracts the close code and reason from a read error. An error that is
// not a close frame is an abnormal closure, which is what the ws client reports for a
// dropped TCP connection.
func closeDetails(err error) (int, string) {
	var closeError websocket.CloseError
	if errors.As(err, &closeError) {
		code := int(closeError.Code)
		if code <= 0 {
			code = statusAbnormalClosure
		}
		return code, closeError.Reason
	}
	return statusAbnormalClosure, ""
}

// beginUpstreamConnect marks a handshake attempt and drops payloads queued by the
// previous connection, mirroring clearUpstreamQueue() inside connectUpstream.
func (e *engine) beginUpstreamConnect() {
	e.mu.Lock()
	e.state = connConnecting
	e.mu.Unlock()
	e.clearQueue()
}

// markUpstreamOpen records a completed handshake.
func (e *engine) markUpstreamOpen() {
	e.mu.Lock()
	e.state = connOpen
	e.lastUpstreamConnectedAt = e.nowMillis()
	e.mu.Unlock()
	log.Print("[ais-relay] upstream connected")
}

// recordUpstreamClose records a terminated connection.
//
// The Node relay writes lastUpstreamError twice for an abnormal end: the `error` event
// stores error.message first and the `close` event then overwrites it with
// "close <code>[: <reason>]". Only the second value is ever observable, so this port
// writes it directly; both processes therefore report the same diagnostics.
func (e *engine) recordUpstreamClose(code int, reason string) {
	message := "close " + strconv.Itoa(code)
	if trimmed := jsTrim(reason); trimmed != "" {
		message = message + ": " + trimmed
	}

	e.mu.Lock()
	e.state = connIdle
	e.lastUpstreamErrorAt = e.nowMillis()
	e.lastUpstreamErrorMessage = &message
	e.mu.Unlock()

	e.clearQueue()
	log.Printf("[ais-relay] upstream disconnected (%s)", message)
}

// finishUpstreamConnect returns the state to idle after the supervisor stops, so a
// shutting-down relay does not report a handshake that is no longer in flight.
func (e *engine) finishUpstreamConnect() {
	e.mu.Lock()
	e.state = connIdle
	e.mu.Unlock()
	e.clearQueue()
}

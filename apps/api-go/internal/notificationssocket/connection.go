package notificationssocket

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// connection is one upgraded browser socket. All writes go through writeRaw,
// which owns the single serialized writer required by Engine.IO: events from
// the Redis relay, pongs and disconnects can otherwise interleave mid-frame.
type connection struct {
	runtime *Runtime
	ws      *websocket.Conn
	request *http.Request

	id       string
	ip       string
	userID   string
	orgID    string
	jti      string
	expires  time.Time
	lastPong atomic.Int64

	ctx    context.Context
	cancel context.CancelFunc

	sendMu    sync.Mutex
	closeOnce sync.Once
}

func (c *connection) serve() {
	defer c.shutdown(false)
	c.ws.SetReadLimit(maxMessageBytes)
	if err := c.writeRaw(encodeOpen(c.id, int(c.runtime.pingInterval/time.Millisecond), int(c.runtime.pingTimeout/time.Millisecond))); err != nil {
		return
	}

	packet, err := c.readConnect()
	if err != nil {
		return
	}
	if packet.Namespace != Namespace {
		_ = c.writeRaw(encodeConnectError(packet.Namespace, "Unknown namespace"))
		_ = c.writeRaw(encodeDisconnect(packet.Namespace))
		return
	}
	// Socket.IO acknowledges the namespace before handleConnection runs. Auth
	// failures therefore arrive as "notification:error" on a connected socket,
	// exactly like the NestJS gateway, rather than as a pre-connect frame.
	if err := c.writeRaw(encodeConnectAck(Namespace, c.id)); err != nil {
		return
	}

	// The order mirrors NotificationsGateway.handleConnection: IP window,
	// failed-auth backoff, origin, JWT/blacklist/authz, user window, then the
	// per-user/per-IP connection caps. Every rejection emits
	// "notification:error" before disconnect(true).
	ipAllowed, retryAfter := c.runtime.limiter.checkIP(c.ctx, c.ip)
	if !ipAllowed {
		c.failAndClose("Rate limit exceeded", retryAfter, true)
		return
	}
	if delay := c.runtime.limiter.backoffDelay(c.ctx, c.ip); delay > 0 {
		c.failAndClose("Too many failed attempts", delay.Milliseconds(), true)
		return
	}
	if !c.runtime.cors.AllowsOrigin(requestOrigin(c.request)) {
		c.failAndClose("Unauthorized", 0, true)
		return
	}

	token := extractToken(c.request, packet.Payload)
	session, authErr := c.runtime.auth.authenticate(c.ctx, token)
	if authErr != nil {
		c.failAndClose("Unauthorized", 0, shouldRecordFailedAuth(authErr))
		return
	}
	userAllowed, userRetryAfter := c.runtime.limiter.checkUser(c.ctx, session.userID)
	if !userAllowed {
		c.failAndClose("Too many connection attempts", userRetryAfter, false)
		return
	}

	c.userID = session.userID
	c.orgID = session.orgID
	c.jti = session.jti
	c.expires = session.expiresAt
	if err := c.runtime.register(c); err != nil {
		c.failAndClose("Too many connections", 0, false)
		return
	}
	c.runtime.limiter.clearBackoff(c.ctx, c.ip)
	c.lastPong.Store(time.Now().UnixNano())

	if err := c.writeEvent("notification:connected", struct {
		OrgID  string `json:"orgId"`
		UserID string `json:"userId"`
	}{OrgID: c.orgID, UserID: c.userID}); err != nil {
		return
	}

	pingDone := make(chan struct{})
	go c.pingLoop(pingDone)
	defer close(pingDone)
	go c.revalidating()

	c.readLoop()
}

func (c *connection) readConnect() (clientPacket, error) {
	ctx, cancel := context.WithTimeout(c.ctx, c.runtime.connectWait)
	defer cancel()
	for {
		messageType, data, err := c.ws.Read(ctx)
		if err != nil {
			return clientPacket{}, err
		}
		if messageType != websocket.MessageText {
			continue
		}
		packet, err := parseClientPacket(string(data))
		if err != nil {
			return clientPacket{}, err
		}
		switch packet.EngineType {
		case enginePing:
			if err := c.writeRaw(string(enginePong)); err != nil {
				return clientPacket{}, err
			}
			continue
		case enginePong:
			continue
		case engineClose:
			return clientPacket{}, errors.New("client closed engine.io")
		}
		if packet.EngineType == engineMessage && packet.SocketType == socketConnect {
			return packet, nil
		}
		// Events are not valid before the namespace CONNECT; the browser client
		// never sends them here. Ignore rather than interpreting them as auth.
	}
}

func (c *connection) readLoop() {
	for {
		messageType, data, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageText {
			continue
		}
		packet, err := parseClientPacket(string(data))
		if err != nil {
			return
		}
		switch packet.EngineType {
		case enginePing:
			if err := c.writeRaw(string(enginePong)); err != nil {
				return
			}
		case enginePong:
			c.lastPong.Store(time.Now().UnixNano())
		case engineClose:
			return
		case engineMessage:
			if packet.SocketType == socketDisconnect {
				return
			}
		}
	}
}

// pingLoop implements the Engine.IO v4 heartbeat. The server owns the ping and
// the client answers with a pong; a missed ping closes the socket so a dead
// browser cannot keep a notification slot forever.
func (c *connection) pingLoop(done <-chan struct{}) {
	ticker := time.NewTicker(c.runtime.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			last := time.Unix(0, c.lastPong.Load())
			if time.Since(last) > c.runtime.pingInterval+c.runtime.pingTimeout {
				c.shutdown(true)
				return
			}
			if err := c.writeRaw(string(enginePing)); err != nil {
				c.shutdown(false)
				return
			}
		}
	}
}

// revalidating is the long-lived-session guard: the JWT is verified at
// handshake time, but logout/blacklist/expiry must cut the live socket too.
// disconnect(true) sends the Socket.IO DISCONNECT packet and closes the
// underlying Engine.IO connection; fail-open on Redis errors mirrors NestJS.
func (c *connection) revalidating() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			if !c.expires.IsZero() && !time.Now().Before(c.expires) {
				c.shutdown(true)
				return
			}
			if c.jti == "" {
				continue
			}
			revoked, err := c.runtime.auth.blacklist.Revoked(c.ctx, c.jti)
			if err != nil {
				continue
			}
			if revoked {
				c.shutdown(true)
				return
			}
		}
	}
}

func (c *connection) writeEvent(event string, payload any) error {
	packet, err := encodeEvent(Namespace, event, payload)
	if err != nil {
		return err
	}
	return c.writeRaw(packet)
}

func (c *connection) writeRaw(packet string) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, []byte(packet))
}

func (c *connection) failAndClose(message string, retryAfterMS int64, recordFailure bool) {
	_ = c.writeEvent("notification:error", rateLimitPayload(message, retryAfterMS))
	if recordFailure {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		c.runtime.limiter.recordFailure(ctx, c.ip)
		cancel()
	}
	c.shutdown(true)
}

// shutdown is idempotent. sendDisconnect controls whether the browser sees a
// Socket.IO DISCONNECT before the transport closes (disconnect(true)).
func (c *connection) shutdown(sendDisconnect bool) {
	c.closeOnce.Do(func() {
		if sendDisconnect {
			_ = c.writeRaw(encodeDisconnect(Namespace))
		}
		c.runtime.unregister(c)
		c.cancel()
		_ = c.ws.Close(websocket.StatusNormalClosure, "disconnected")
	})
}

func shouldRecordFailedAuth(err error) bool {
	var typed *authError
	if !errors.As(err, &typed) {
		return true
	}
	switch typed.message {
	case "Rate limit exceeded", "Too many failed attempts",
		"Too many connections", "Too many connection attempts":
		return false
	default:
		return true
	}
}

package graphqlsubscriptions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	protocolName      = "graphql-transport-ws"
	legacyAckTimeout  = 5 * time.Second
	legacyDialTimeout = 5 * time.Second
)

// legacyOperation is one operation forwarded to the lazy NestJS graphql-ws
// upstream connection. The upstream id is unique per connection and mapped
// back to the client's original id; generation is checked by the connection so
// a late message cannot pollute a reused client id.
type legacyOperation struct {
	upstreamID   string
	downstreamID string
	generation   uint64
}

type legacyHandlers struct {
	onMessage func(*legacyOperation, string, json.RawMessage)
	onFailure func(*legacyOperation)
}

// legacyUpstream is one lazily created upstream graphql-transport-ws
// connection per downstream client. It is created only when the first
// operation that cannot run locally needs forwarding.
type legacyUpstream struct {
	conn         *websocket.Conn
	handlers     legacyHandlers
	writeMu      sync.Mutex
	mu           sync.Mutex
	acked        chan struct{}
	ackOnce      sync.Once
	closed       chan struct{}
	closeOnce    sync.Once
	pending      map[string]*legacyOperation
	byDownstream map[string]*legacyOperation
	nextID       int
	isClosed     bool
}

func dialLegacy(ctx context.Context, legacyURL string, initPayload json.RawMessage, handlers legacyHandlers) (*legacyUpstream, error) {
	target, err := legacyWebSocketURL(legacyURL)
	if err != nil {
		return nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, legacyDialTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{
		Subprotocols: []string{protocolName},
	})
	if err != nil {
		return nil, err
	}
	if conn.Subprotocol() != protocolName {
		_ = conn.Close(websocket.StatusPolicyViolation, "graphql-transport-ws is not supported")
		return nil, fmt.Errorf("legacy upstream did not negotiate %s", protocolName)
	}
	upstream := &legacyUpstream{
		conn:         conn,
		handlers:     handlers,
		acked:        make(chan struct{}),
		closed:       make(chan struct{}),
		pending:      map[string]*legacyOperation{},
		byDownstream: map[string]*legacyOperation{},
	}
	if err := upstream.write(legacyMessage("connection_init", "", initPayload)); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "connection_init write failed")
		return nil, err
	}
	go upstream.readLoop()
	return upstream, nil
}

// legacyWebSocketURL derives ws/wss /graphql solely from LEGACY_API_URL.
func legacyWebSocketURL(legacyURL string) (string, error) {
	parsed, err := url.Parse(legacyURL)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported legacy API URL scheme %q", parsed.Scheme)
	}
	parsed.Path = "/graphql"
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func (u *legacyUpstream) readLoop() {
	for {
		_, data, err := u.conn.Read(context.Background())
		if err != nil {
			u.failAll()
			return
		}
		var message struct {
			Type    string          `json:"type"`
			ID      string          `json:"id"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(data, &message) != nil {
			continue
		}
		switch message.Type {
		case "connection_ack":
			u.ackOnce.Do(func() { close(u.acked) })
		case "ping":
			_ = u.write(legacyMessage("pong", "", message.Payload))
		case "pong":
			// No client heartbeat is required by the protocol.
		case "next", "error", "complete":
			u.mu.Lock()
			op := u.pending[message.ID]
			if op != nil && (message.Type == "complete" || message.Type == "error") {
				delete(u.pending, message.ID)
				delete(u.byDownstream, op.downstreamID)
			}
			u.mu.Unlock()
			if op != nil {
				u.handlers.onMessage(op, message.Type, message.Payload)
			}
		}
	}
}

func (u *legacyUpstream) waitReady(ctx context.Context) error {
	waitCtx, cancel := context.WithTimeout(ctx, legacyAckTimeout)
	defer cancel()
	select {
	case <-u.acked:
		return nil
	case <-u.closed:
		return fmt.Errorf("legacy upstream closed before connection_ack")
	case <-waitCtx.Done():
		return waitCtx.Err()
	}
}

// subscribe forwards the complete original operation payload. The payload is
// never rebuilt from parsed fields, so query, operationName, variables and
// extensions reach NestJS exactly once.
func (u *legacyUpstream) subscribe(ctx context.Context, downstreamID string, generation uint64, payload json.RawMessage) (*legacyOperation, error) {
	if err := u.waitReady(ctx); err != nil {
		return nil, err
	}
	u.mu.Lock()
	if u.isClosed {
		u.mu.Unlock()
		return nil, fmt.Errorf("legacy upstream is closed")
	}
	u.nextID++
	op := &legacyOperation{
		upstreamID:   fmt.Sprintf("go-legacy-%d", u.nextID),
		downstreamID: downstreamID,
		generation:   generation,
	}
	u.pending[op.upstreamID] = op
	u.byDownstream[downstreamID] = op
	u.mu.Unlock()
	if err := u.write(legacyMessage("subscribe", op.upstreamID, payload)); err != nil {
		u.forget(op)
		return nil, err
	}
	return op, nil
}

func (u *legacyUpstream) complete(downstreamID string) {
	u.mu.Lock()
	op := u.byDownstream[downstreamID]
	if op != nil {
		delete(u.byDownstream, downstreamID)
		delete(u.pending, op.upstreamID)
	}
	u.mu.Unlock()
	if op != nil {
		_ = u.write(legacyMessage("complete", op.upstreamID, nil))
	}
}

func (u *legacyUpstream) forget(op *legacyOperation) {
	u.mu.Lock()
	delete(u.pending, op.upstreamID)
	if current := u.byDownstream[op.downstreamID]; current == op {
		delete(u.byDownstream, op.downstreamID)
	}
	u.mu.Unlock()
}

func (u *legacyUpstream) failAll() {
	u.closeOnce.Do(func() { close(u.closed) })
	u.mu.Lock()
	u.isClosed = true
	ops := make([]*legacyOperation, 0, len(u.pending))
	for _, op := range u.pending {
		ops = append(ops, op)
	}
	u.pending = map[string]*legacyOperation{}
	u.byDownstream = map[string]*legacyOperation{}
	u.mu.Unlock()
	for _, op := range ops {
		u.handlers.onFailure(op)
	}
}

func (u *legacyUpstream) write(message []byte) error {
	u.writeMu.Lock()
	defer u.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(context.Background(), legacyAckTimeout)
	defer cancel()
	return u.conn.Write(writeCtx, websocket.MessageText, message)
}

func (u *legacyUpstream) close() {
	u.closeOnce.Do(func() { close(u.closed) })
	_ = u.conn.Close(websocket.StatusGoingAway, "client connection closed")
}

// legacyMessage builds the JSON protocol envelope. Only the envelope is a
// generic map; the operation payload is forwarded as raw JSON.
func legacyMessage(messageType, id string, payload json.RawMessage) []byte {
	message := map[string]any{"type": messageType}
	if id != "" {
		message["id"] = id
	}
	if len(payload) > 0 {
		message["payload"] = payload
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return []byte(`{"type":"complete"}`)
	}
	return encoded
}

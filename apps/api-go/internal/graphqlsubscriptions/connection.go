package graphqlsubscriptions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// graphql-transport-ws close codes from graphql-ws 5.13.1. The whole
// connection closes for protocol violations; operation-level resolver and
// guard failures use next(result) followed by complete instead.
const (
	closeBadRequest   websocket.StatusCode = 4400
	closeUnauthorized websocket.StatusCode = 4401
	closeInitTimeout  websocket.StatusCode = 4408
	closeDuplicateID  websocket.StatusCode = 4409
	closeTooManyInit  websocket.StatusCode = 4429
)

type operationKind int

const (
	operationLocal operationKind = iota
	operationLegacy
)

type closeRequest struct {
	code   websocket.StatusCode
	reason string
}

type operation struct {
	id         string
	generation uint64
	kind       operationKind
	cancel     context.CancelFunc
	plan       exec.SubscriptionPlan
	payload    json.RawMessage
}

type clientMessage struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload"`
}

type serverMessage struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type subscribePayload struct {
	Query         *string         `json:"query"`
	OperationName *string         `json:"operationName"`
	Variables     json.RawMessage `json:"variables"`
	Extensions    json.RawMessage `json:"extensions"`
}

// connection is one downstream graphql-transport-ws client. All writes go
// through a single writer goroutine so next/error/complete/pong order is one
// serialized stream.
type connection struct {
	runtime     *Runtime
	ws          *websocket.Conn
	ctx         context.Context
	cancel      context.CancelFunc
	traceID     string
	remoteAddr  string
	initPayload json.RawMessage

	mu           sync.Mutex
	ops          map[string]*operation
	generation   uint64
	initReceived bool
	acked        bool
	closing      bool

	out        chan []byte
	closeReq   chan closeRequest
	closeOnce  sync.Once
	writerDone chan struct{}

	legacyMu sync.Mutex
	legacy   *legacyUpstream
}

func newConnection(runtime *Runtime, ws *websocket.Conn, ctx context.Context, cancel context.CancelFunc, request *http.Request) *connection {
	remote := strings.TrimSpace(request.RemoteAddr)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	return &connection{
		runtime:    runtime,
		ws:         ws,
		ctx:        ctx,
		cancel:     cancel,
		traceID:    httpx.TraceIDFromContext(request.Context()),
		remoteAddr: remote,
		ops:        map[string]*operation{},
		out:        make(chan []byte, 64),
		closeReq:   make(chan closeRequest, 1),
		writerDone: make(chan struct{}),
	}
}

func (c *connection) serve() {
	defer c.cleanup()
	c.ws.SetReadLimit(c.runtime.options.MaxMessageBytes)
	go c.writeLoop()
	initTimer := time.AfterFunc(c.runtime.options.InitTimeout, func() {
		c.mu.Lock()
		initialized := c.initReceived
		c.mu.Unlock()
		if !initialized {
			c.closeWith(closeInitTimeout, "Connection initialisation timeout")
		}
	})
	defer initTimer.Stop()
	for {
		if c.isClosing() {
			return
		}
		_, data, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		if !c.handleMessage(data) {
			return
		}
	}
}

func (c *connection) writeLoop() {
	defer close(c.writerDone)
	for {
		select {
		case request := <-c.closeReq:
			// Send the protocol close frame before cancelling the read context:
			// cancelling first can abort the socket without the close code.
			_ = c.ws.Close(request.code, request.reason)
			c.cancel()
			return
		case data := <-c.out:
			if err := c.ws.Write(c.ctx, websocket.MessageText, data); err != nil {
				c.cancel()
				return
			}
		case <-c.ctx.Done():
			select {
			case request := <-c.closeReq:
				_ = c.ws.Close(request.code, request.reason)
			default:
				_ = c.ws.Close(websocket.StatusNormalClosure, "")
			}
			return
		}
	}
}

func (c *connection) cleanup() {
	c.mu.Lock()
	closing := c.closing
	c.mu.Unlock()
	if !closing {
		// The peer closed or the read failed without a protocol close request;
		// no specific close code needs to be delivered.
		c.cancel()
	}
	c.mu.Lock()
	c.closing = true
	ops := make([]*operation, 0, len(c.ops))
	for _, op := range c.ops {
		ops = append(ops, op)
	}
	c.ops = map[string]*operation{}
	c.mu.Unlock()
	for _, op := range ops {
		op.cancel()
	}
	c.legacyMu.Lock()
	upstream := c.legacy
	c.legacy = nil
	c.legacyMu.Unlock()
	if upstream != nil {
		upstream.close()
	}
	select {
	case <-c.writerDone:
	case <-time.After(2 * time.Second):
		c.forceClose()
		select {
		case <-c.writerDone:
		case <-time.After(time.Second):
		}
	}
	c.cancel()
}

func (c *connection) handleMessage(data []byte) bool {
	if c.isClosing() {
		return false
	}
	var message clientMessage
	if len(data) == 0 || json.Unmarshal(data, &message) != nil || message.Type == "" {
		c.closeWith(closeBadRequest, "Bad Request")
		return false
	}
	switch message.Type {
	case "connection_init":
		c.mu.Lock()
		if c.initReceived {
			c.mu.Unlock()
			c.closeWith(closeTooManyInit, "Too many initialisation requests")
			return false
		}
		c.initReceived = true
		c.initPayload = message.Payload
		c.acked = true
		c.mu.Unlock()
		return c.sendServer(serverMessage{Type: "connection_ack"})
	case "ping":
		c.sendServer(serverMessage{Type: "pong", Payload: message.Payload})
		return true
	case "pong":
		return true
	case "subscribe":
		if !c.isAcked() {
			c.closeWith(closeUnauthorized, "Unauthorized")
			return false
		}
		c.handleSubscribe(message)
		return true
	case "complete":
		c.completeOperation(message.ID)
		return true
	default:
		c.closeWith(closeBadRequest, "Bad Request")
		return false
	}
}

func (c *connection) handleSubscribe(message clientMessage) {
	if message.ID == "" {
		c.closeWith(closeBadRequest, "Bad Request")
		return
	}
	if c.operationExists(message.ID) {
		c.closeWith(closeDuplicateID, fmt.Sprintf("Subscriber for %s already exists", message.ID))
		return
	}
	var payload subscribePayload
	if len(message.Payload) == 0 || json.Unmarshal(message.Payload, &payload) != nil {
		c.closeWith(closeBadRequest, "Bad Request")
		return
	}
	query := ""
	if payload.Query != nil {
		query = *payload.Query
	}
	var variables map[string]any
	var invalidVariables bool
	trimmedVariables := bytes.TrimSpace(payload.Variables)
	if len(trimmedVariables) > 0 && !bytes.Equal(trimmedVariables, []byte("null")) {
		if json.Unmarshal(trimmedVariables, &variables) != nil {
			// A non-object variables value is left for NestJS to reject with
			// its exact GraphQL error; ownership is decided on the payload as
			// a whole.
			invalidVariables = true
		}
	}
	if invalidVariables {
		c.startLegacyOperation(message.ID, message.Payload)
		return
	}
	plan := c.runtime.engine.PlanSubscription(query, payload.OperationName, variables)
	switch plan.Kind {
	case exec.KindLegacy:
		c.startLegacyOperation(message.ID, message.Payload)
	case exec.KindProtocol:
		c.sendServer(serverMessage{Type: "next", ID: message.ID, Payload: plan.Result.Body})
		c.sendServer(serverMessage{Type: "complete", ID: message.ID})
	case exec.KindSubscriptionError:
		c.sendSubscriptionProtocolError(message.ID, plan.Result.Body)
	case exec.KindExecute:
		c.startLocalOperation(message.ID, plan)
	default:
		c.startLegacyOperation(message.ID, message.Payload)
	}
}

// sendSubscriptionProtocolError emits graphql-ws' operation-level error (a
// GraphQLError array). It terminates only this operation and never sends
// complete; resolver/guard failures use next+complete instead.
func (c *connection) sendSubscriptionProtocolError(id string, body json.RawMessage) {
	var payload struct {
		Errors json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(body, &payload) != nil || len(payload.Errors) == 0 || string(payload.Errors) == "null" {
		c.sendServer(serverMessage{Type: "error", ID: id, Payload: internalErrorArray()})
		return
	}
	c.sendServer(serverMessage{Type: "error", ID: id, Payload: payload.Errors})
}

func (c *connection) startLocalOperation(id string, plan exec.SubscriptionPlan) {
	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		cancel()
		return
	}
	c.generation++
	op := &operation{id: id, generation: c.generation, kind: operationLocal, cancel: cancel, plan: plan}
	c.ops[id] = op
	c.mu.Unlock()
	go c.runLocalOperation(ctx, op)
}

func (c *connection) runLocalOperation(ctx context.Context, op *operation) {
	if !c.operationCurrent(op) {
		return
	}
	execution, failure := c.runtime.engine.PrepareSubscription(ctx, op.plan, c.prepareRoot, c.traceID)
	if failure != nil {
		c.sendNextForOperation(op, failure.Body)
		c.finishOperation(op)
		return
	}
	events, err := c.runtime.engine.OpenSubscription(ctx, execution)
	if err != nil {
		c.sendNextForOperation(op, internalErrorPayload())
		c.finishOperation(op)
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				c.finishOperation(op)
				return
			}
			result := c.runtime.engine.ProjectSubscriptionEvent(execution, event)
			if !c.sendNextForOperation(op, result.Body) {
				return
			}
		}
	}
}

// prepareRoot is the per-subscribe rate limit, then authentication, exactly
// like the HTTP executor. Permission is checked by PrepareSubscription.
func (c *connection) prepareRoot(ctx context.Context, _, _ string) (contract.Identity, error) {
	budget := c.runtime.options.Limiter.BudgetFor(ctx)
	if !c.runtime.options.Limiter.Consume(ctx, c.remoteAddr, budget) {
		return contract.Identity{}, &contract.Failure{
			Message: "Too many GraphQL requests. Slow down.",
			Status:  http.StatusTooManyRequests,
		}
	}
	request := c.syntheticRequest().WithContext(ctx)
	identity, failure := c.runtime.options.Authenticator.Identify(request)
	if failure != nil {
		return contract.Identity{}, &contract.Failure{Message: failure.Message, Status: failure.Status}
	}
	return contract.Identity{
		UserID:      identity.UserID,
		OrgID:       identity.OrgID,
		Permissions: identity.PermissionSet(),
	}, nil
}

// syntheticRequest mirrors createSyntheticGqlRequest: the connection_init
// payload is a top-level header-like object, only string and string[] values
// are accepted, and the IP is the socket remote address. Client-provided
// x-forwarded-for or orgId never becomes the identity or the rate-limit IP.
func (c *connection) syntheticRequest() *http.Request {
	request := &http.Request{Header: http.Header{}, RemoteAddr: c.remoteAddr}
	var payload map[string]json.RawMessage
	if json.Unmarshal(c.initPayloadCopy(), &payload) != nil {
		return request
	}
	for key, raw := range payload {
		var single string
		if json.Unmarshal(raw, &single) == nil {
			request.Header.Set(key, single)
			continue
		}
		var list []string
		if json.Unmarshal(raw, &list) == nil {
			for _, value := range list {
				request.Header.Add(key, value)
			}
		}
	}
	return request
}

func (c *connection) startLegacyOperation(id string, payload json.RawMessage) {
	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		cancel()
		return
	}
	c.generation++
	op := &operation{id: id, generation: c.generation, kind: operationLegacy, cancel: cancel, payload: payload}
	c.ops[id] = op
	c.mu.Unlock()
	go func() {
		upstream, err := c.ensureLegacy(ctx)
		if err != nil {
			c.failLegacyLocalOperation(op)
			return
		}
		if !c.operationCurrent(op) {
			return
		}
		if _, err := upstream.subscribe(ctx, op.id, op.generation, payload); err != nil {
			c.failLegacyLocalOperation(op)
			return
		}
		if !c.operationCurrent(op) {
			upstream.complete(op.id)
		}
	}()
}

func (c *connection) ensureLegacy(ctx context.Context) (*legacyUpstream, error) {
	c.legacyMu.Lock()
	defer c.legacyMu.Unlock()
	if c.legacy != nil {
		select {
		case <-c.legacy.closed:
			c.legacy = nil
		default:
			return c.legacy, nil
		}
	}
	upstream, err := dialLegacy(ctx, c.runtime.options.LegacyURL, c.initPayloadCopy(), legacyHandlers{
		onMessage: c.handleLegacyMessage,
		onFailure: c.failLegacyOperation,
	})
	if err != nil {
		return nil, err
	}
	c.legacy = upstream
	return upstream, nil
}

func (c *connection) failLegacyLocalOperation(op *operation) {
	c.failLegacyOperation(&legacyOperation{downstreamID: op.id, generation: op.generation})
}

func (c *connection) handleLegacyMessage(op *legacyOperation, messageType string, payload json.RawMessage) {
	data, err := json.Marshal(serverMessage{Type: messageType, ID: op.downstreamID, Payload: payload})
	if err != nil {
		return
	}
	c.mu.Lock()
	current := c.ops[op.downstreamID]
	matches := current != nil && current.generation == op.generation && current.kind == operationLegacy
	if !matches {
		c.mu.Unlock()
		return
	}
	// Queue and remove under the same lock so a client complete followed by an
	// id reuse cannot receive this late upstream frame.
	queued := false
	select {
	case c.out <- data:
		queued = true
	default:
	}
	if messageType == "complete" || messageType == "error" {
		delete(c.ops, op.downstreamID)
	}
	c.mu.Unlock()
	if !queued {
		c.forceClose()
		return
	}
	if messageType == "complete" || messageType == "error" {
		current.cancel()
	}
}

// failLegacyOperation ends only the operations owned by the failed upstream
// connection with an error message; it never fabricates a successful result
// and never replays a mutation.
func (c *connection) failLegacyOperation(op *legacyOperation) {
	data, err := json.Marshal(serverMessage{Type: "error", ID: op.downstreamID, Payload: internalErrorPayload()})
	if err != nil {
		return
	}
	c.mu.Lock()
	current := c.ops[op.downstreamID]
	matches := current != nil && current.generation == op.generation && current.kind == operationLegacy
	if !matches {
		c.mu.Unlock()
		return
	}
	queued := false
	select {
	case c.out <- data:
		queued = true
	default:
	}
	delete(c.ops, op.downstreamID)
	c.mu.Unlock()
	if !queued {
		c.forceClose()
	}
	current.cancel()
}

func (c *connection) completeOperation(id string) {
	c.mu.Lock()
	op := c.ops[id]
	if op != nil {
		delete(c.ops, id)
	}
	c.mu.Unlock()
	if op == nil {
		return
	}
	op.cancel()
	if op.kind == operationLegacy {
		c.legacyMu.Lock()
		upstream := c.legacy
		c.legacyMu.Unlock()
		if upstream != nil {
			upstream.complete(id)
		}
	}
}

// finishOperation completes a local operation after its source ended. The
// complete frame is sent only if the client has not already cancelled and the
// id has not been reused.
func (c *connection) finishOperation(op *operation) {
	data, err := json.Marshal(serverMessage{Type: "complete", ID: op.id})
	if err != nil {
		return
	}
	c.mu.Lock()
	current := c.ops[op.id] == op
	queued := false
	if current {
		select {
		case c.out <- data:
			queued = true
		default:
		}
		delete(c.ops, op.id)
	}
	c.mu.Unlock()
	if !current {
		op.cancel()
		return
	}
	if !queued {
		c.forceClose()
	}
	op.cancel()
}

func (c *connection) sendNextForOperation(op *operation, payload json.RawMessage) bool {
	data, err := json.Marshal(serverMessage{Type: "next", ID: op.id, Payload: payload})
	if err != nil {
		return false
	}
	c.mu.Lock()
	if c.ops[op.id] != op {
		c.mu.Unlock()
		return false
	}
	select {
	case c.out <- data:
		c.mu.Unlock()
		return true
	default:
		c.mu.Unlock()
		c.forceClose()
		return false
	}
}

func (c *connection) sendServer(message serverMessage) bool {
	data, err := json.Marshal(message)
	if err != nil {
		return false
	}
	select {
	case c.out <- data:
		return true
	default:
		c.forceClose()
		return false
	}
}

func (c *connection) operationExists(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.ops[id]
	return ok
}

func (c *connection) operationCurrent(op *operation) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ops[op.id] == op
}

func (c *connection) initPayloadCopy() json.RawMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append(json.RawMessage{}, c.initPayload...)
}

func (c *connection) isAcked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.acked
}

func (c *connection) isClosing() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closing
}

func (c *connection) closeWith(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closing = true
		ops := make([]*operation, 0, len(c.ops))
		for _, op := range c.ops {
			ops = append(ops, op)
		}
		c.ops = map[string]*operation{}
		c.mu.Unlock()
		// Stop sources immediately, but leave the connection context alive so
		// the writer can deliver the close frame with the protocol code.
		for _, op := range ops {
			op.cancel()
		}
		select {
		case c.closeReq <- closeRequest{code: code, reason: reason}:
		default:
		}
	})
}

func (c *connection) shutdown(code websocket.StatusCode, reason string) {
	c.closeWith(code, reason)
}

func (c *connection) forceClose() {
	c.cancel()
	_ = c.ws.CloseNow()
}

func hasSubprotocol(values []string, want string) bool {
	for _, value := range values {
		for _, token := range strings.Split(value, ",") {
			if strings.TrimSpace(token) == want {
				return true
			}
		}
	}
	return false
}

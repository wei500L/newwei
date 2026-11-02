package graphqlsubscriptions

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
)

type fakeFeed struct {
	channel chan FeedEvent
}

type fakeSource struct {
	mu    sync.Mutex
	feeds map[string]map[string]map[*fakeFeed]struct{}
	order *[]string
}

func newFakeSource() *fakeSource {
	return &fakeSource{feeds: map[string]map[string]map[*fakeFeed]struct{}{}}
}

func (s *fakeSource) Subscribe(ctx context.Context, root, orgID string) (<-chan FeedEvent, error) {
	feed := &fakeFeed{channel: make(chan FeedEvent, 32)}
	s.mu.Lock()
	if s.feeds[root] == nil {
		s.feeds[root] = map[string]map[*fakeFeed]struct{}{}
	}
	if s.feeds[root][orgID] == nil {
		s.feeds[root][orgID] = map[*fakeFeed]struct{}{}
	}
	s.feeds[root][orgID][feed] = struct{}{}
	s.mu.Unlock()
	go func() {
		<-ctx.Done()
		s.mu.Lock()
		delete(s.feeds[root][orgID], feed)
		if len(s.feeds[root][orgID]) == 0 {
			delete(s.feeds[root], orgID)
		}
		s.mu.Unlock()
	}()
	return feed.channel, nil
}

func (s *fakeSource) push(root, orgID string, event FeedEvent) {
	s.mu.Lock()
	feeds := make([]*fakeFeed, 0)
	for feed := range s.feeds[root][orgID] {
		feeds = append(feeds, feed)
	}
	s.mu.Unlock()
	for _, feed := range feeds {
		select {
		case feed.channel <- event:
		default:
		}
	}
}

func (s *fakeSource) subscriberCount(root, orgID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.feeds[root][orgID])
}

func (s *fakeSource) waitForSubscribers(t *testing.T, root, orgID string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.subscriberCount(root, orgID) == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("subscribers(%s,%s) = %d, want %d", root, orgID, s.subscriberCount(root, orgID), want)
}

type fakeAuth struct {
	mu         sync.Mutex
	identities map[string]*authhttp.Identity
	order      *[]string
}

func (a *fakeAuth) Identify(request *http.Request) (*authhttp.Identity, *authhttp.AuthFailure) {
	a.mu.Lock()
	if a.order != nil {
		*a.order = append(*a.order, "identify")
	}
	a.mu.Unlock()
	token := strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
	identity := a.identities[token]
	if identity == nil {
		return nil, &authhttp.AuthFailure{Status: http.StatusUnauthorized, Message: "Unauthorized"}
	}
	return identity, nil
}

type fakeLimiter struct {
	mu      sync.Mutex
	allowed bool
	calls   int
	order   *[]string
}

func (l *fakeLimiter) BudgetFor(context.Context) policy.Budget {
	return policy.Budget{Limit: 10, WindowSeconds: 60}
}

func (l *fakeLimiter) Consume(context.Context, string, policy.Budget) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	if l.order != nil {
		*l.order = append(*l.order, "limit")
	}
	return l.allowed
}

func newTestRuntime(t *testing.T, source FeedSource, auth Identifier, limiter Limiter, initTimeout time.Duration) *Runtime {
	t.Helper()
	runtime, err := New(Options{
		Authenticator: auth,
		Limiter:       limiter,
		Source:        source,
		InitTimeout:   initTimeout,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := runtime.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runtime.Close(ctx); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	return runtime
}

func dialTestConnection(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	target := "ws" + strings.TrimPrefix(serverURL, "http") + "/graphql"
	conn, response, err := websocket.Dial(ctx, target, &websocket.DialOptions{
		Subprotocols: []string{protocolName},
	})
	if err != nil {
		t.Fatalf("websocket.Dial() error = %v", err)
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if conn.Subprotocol() != protocolName {
		t.Fatalf("negotiated subprotocol = %q, want %q", conn.Subprotocol(), protocolName)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

func sendClientMessage(t *testing.T, conn *websocket.Conn, message map[string]any) {
	t.Helper()
	data, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal client message: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write client message: %v", err)
	}
}

func readServerMessage(t *testing.T, conn *websocket.Conn) serverMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read server message: %v", err)
	}
	var message serverMessage
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("server message is not JSON: %v (%s)", err, data)
	}
	return message
}

func initConnection(t *testing.T, conn *websocket.Conn, token string) {
	t.Helper()
	sendClientMessage(t, conn, map[string]any{
		"type": "connection_init",
		"payload": map[string]any{
			"authorization": "Bearer " + token,
		},
	})
	message := readServerMessage(t, conn)
	if message.Type != "connection_ack" {
		t.Fatalf("first message = %q, want connection_ack", message.Type)
	}
}

func readCloseStatus(t *testing.T, conn *websocket.Conn) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := conn.Read(ctx)
	if err == nil {
		t.Fatal("expected the connection to close")
	}
	return websocket.CloseStatus(err)
}

func decodeNextPayload(t *testing.T, message serverMessage) map[string]any {
	t.Helper()
	if message.Type != "next" {
		t.Fatalf("message type = %q, want next (payload=%s)", message.Type, message.Payload)
	}
	var payload map[string]any
	if err := json.Unmarshal(message.Payload, &payload); err != nil {
		t.Fatalf("next payload is not JSON: %v (%s)", err, message.Payload)
	}
	return payload
}

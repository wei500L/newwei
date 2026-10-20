package graphqlsubscriptions

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

func TestRuntimeCloseClosesHijackedConnectionsAndIsIdempotent(t *testing.T) {
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime, err := New(Options{
		Authenticator: auth,
		Limiter:       &fakeLimiter{allowed: true},
		Source:        source,
		InitTimeout:   2 * time.Second,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := runtime.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "1",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)

	closeDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		closeDone <- runtime.Close(ctx)
	}()
	if status := readCloseStatus(t, conn); status != websocket.StatusGoingAway {
		t.Fatalf("close status = %v, want going away", status)
	}
	_ = conn.CloseNow()
	if err := <-closeDone; err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	source.waitForSubscribers(t, "alertEvents", "org-a", 0)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	target := "ws" + server.URL[len("http"):] + "/graphql"
	if _, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{Subprotocols: []string{protocolName}}); err == nil {
		t.Fatal("an upgrade after Close must be rejected")
	}
	if err := runtime.Close(ctx); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
}

func TestHandlesOnlyExactGraphqlTransportWSUpgrade(t *testing.T) {
	runtime := &Runtime{}
	cases := []struct {
		name    string
		method  string
		path    string
		upgrade string
		tokens  string
		want    bool
	}{
		{"legal", http.MethodGet, "/graphql", "websocket", "graphql-transport-ws", true},
		{"legal with another token", http.MethodGet, "/graphql", "WebSocket", "other, graphql-transport-ws", true},
		{"longer path", http.MethodGet, "/graphql/", "websocket", "graphql-transport-ws", false},
		{"socket io", http.MethodGet, "/socket.io/", "websocket", "graphql-transport-ws", false},
		{"post", http.MethodPost, "/graphql", "websocket", "graphql-transport-ws", false},
		{"other subprotocol", http.MethodGet, "/graphql", "websocket", "graphql-ws", false},
		{"no upgrade", http.MethodGet, "/graphql", "", "graphql-transport-ws", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			if test.upgrade != "" {
				request.Header.Set("Upgrade", test.upgrade)
			}
			if test.tokens != "" {
				request.Header.Set("Sec-WebSocket-Protocol", test.tokens)
			}
			if got := runtime.Handles(request); got != test.want {
				t.Fatalf("Handles() = %v, want %v", got, test.want)
			}
		})
	}
}

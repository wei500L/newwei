package graphqlsubscriptions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

const (
	protocolName           = "graphql-transport-ws"
	defaultInitTimeout     = 3 * time.Second
	defaultMaxMessageBytes = 16 << 20
	upstreamErrorPayload   = `{"errors":[{"message":"Internal server error","extensions":{"code":"INTERNAL_SERVER_ERROR","http":{"status":500}}}]}`
	upstreamErrorArray     = `[{"message":"Internal server error","extensions":{"code":"INTERNAL_SERVER_ERROR","http":{"status":500}}}]`
)

// Identifier is the existing authhttp chain. Identify never writes an HTTP
// response, so WS failures stay in the GraphQL envelope.
type Identifier interface {
	Identify(*http.Request) (*authhttp.Identity, *authhttp.AuthFailure)
}

// Limiter is the existing shared graphql: rate bucket.
type Limiter interface {
	BudgetFor(context.Context) policy.Budget
	Consume(context.Context, string, policy.Budget) bool
}

// Options wires the subscription executor. Source replaces the Redis bus and
// queue observer in tests; production leaves it nil and supplies Redis.
type Options struct {
	Authenticator   Identifier
	Limiter         Limiter
	Redis           *redis.Client
	RedisOptions    *redis.Options
	Queue           *QueueObserver
	Source          FeedSource
	InitTimeout     time.Duration
	MaxMessageBytes int64
}

// Runtime owns the subscription executor, all live WebSocket connections, the
// Redis pub/sub reader and the per-process queue observer.
type Runtime struct {
	options Options
	source  FeedSource
	bus     *Bus
	queue   *QueueObserver
	engine  *exec.Engine

	closing   atomic.Bool
	mu        sync.Mutex
	conns     map[*connection]struct{}
	wg        sync.WaitGroup
	closeOnce sync.Once
	closeErr  error
}

// New loads the exact SDL, registers only the four Subscription roots and the
// models they return, and prepares the event sources. It never assembles a
// Query/Mutation registry and never opens Mongo.
func New(options Options) (*Runtime, error) {
	if options.Authenticator == nil || options.Limiter == nil {
		return nil, fmt.Errorf("graphqlsubscriptions: authenticator and limiter are required")
	}
	if options.InitTimeout <= 0 {
		options.InitTimeout = defaultInitTimeout
	}
	if options.MaxMessageBytes <= 0 {
		options.MaxMessageBytes = defaultMaxMessageBytes
	}
	loaded, err := schema.Load()
	if err != nil {
		return nil, err
	}
	runtime := &Runtime{
		options: options,
		conns:   map[*connection]struct{}{},
	}
	if options.Source != nil {
		runtime.source = options.Source
	} else {
		if options.Redis == nil {
			return nil, fmt.Errorf("graphqlsubscriptions: Redis is required when no test source is supplied")
		}
		runtime.bus = NewBus(options.Redis)
		runtime.queue = options.Queue
		if runtime.queue == nil {
			if options.RedisOptions == nil {
				return nil, fmt.Errorf("graphqlsubscriptions: queue Redis options are required")
			}
			runtime.queue = NewRedisQueueObserver(options.RedisOptions, options.Redis)
		}
		runtime.source = &compositeSource{bus: runtime.bus, queue: runtime.queue}
	}

	registry := contract.NewRegistry()
	alerts.RegisterModels(registry)
	workspace.RegisterQueueEventModel(registry)
	registry.RegisterType("AnalysisResultModel", AnalysisResultModel{})
	registry.RegisterType("AssistantRunModel", AssistantRunModel{})
	for _, spec := range subscriptionRoots {
		spec := spec
		registry.RegisterSubscription(contract.Subscription{
			Root: contract.Root{Name: spec.name, Permission: spec.permission},
			Open: runtime.openFeed(spec.name),
		})
	}
	runtime.engine = exec.New(loaded, registry, 0, 0, nil)
	return runtime, nil
}

// Start launches the queue observer. The Redis pub/sub reader is started with
// the first local subscription, matching the NestJS bus, but the queue
// observer must observe from process start so active/progress can populate the
// shared job context before a terminal event arrives.
func (r *Runtime) Start(ctx context.Context) error {
	if r == nil || r.closing.Load() {
		return nil
	}
	if r.bus != nil {
		r.bus.Start(ctx)
	}
	if r.queue != nil {
		r.queue.Start(ctx)
	}
	return nil
}

// Handles reports whether this exact request is a graphql-transport-ws
// upgrade. Other upgrades (including other subprotocols) are not handled here
// and fall through to the read handler.
func (r *Runtime) Handles(request *http.Request) bool {
	if r == nil || request == nil {
		return false
	}
	if request.Method != http.MethodGet || request.URL.Path != "/graphql" {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") {
		return false
	}
	return hasSubprotocol(request.Header.Values("Sec-WebSocket-Protocol"), protocolName)
}

func (r *Runtime) openFeed(root string) func(contract.Context) (<-chan contract.SubscriptionEvent, error) {
	return func(ctx contract.Context) (<-chan contract.SubscriptionEvent, error) {
		feed, err := r.source.Subscribe(ctx.Ctx, root, ctx.Identity.OrgID)
		if err != nil {
			return nil, err
		}
		out := make(chan contract.SubscriptionEvent)
		go func() {
			defer close(out)
			for {
				select {
				case event, ok := <-feed:
					if !ok {
						return
					}
					converted := contract.SubscriptionEvent{Value: event.Value, Error: event.Error}
					select {
					case out <- converted:
					case <-ctx.Ctx.Done():
						return
					}
				case <-ctx.Ctx.Done():
					return
				}
			}
		}()
		return out, nil
	}
}

// ServeHTTP upgrades one exact /graphql request and serves the connection.
func (r *Runtime) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if !r.Handles(request) {
		http.Error(w, "not a graphql-transport-ws upgrade", http.StatusBadRequest)
		return
	}
	if r.closing.Load() {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	ws, err := websocket.Accept(w, request, &websocket.AcceptOptions{
		Subprotocols: []string{protocolName},
		// NestJS' GqlSubscriptionService passes the schema/context to
		// graphql-ws' useServer and does not apply the HTTP CORS policy to the
		// WebSocket upgrade. Mirroring that avoids rejecting existing
		// cross-origin clients with a new same-origin default.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	conn := newConnection(r, ws, ctx, cancel, request)
	r.mu.Lock()
	if r.closing.Load() {
		r.mu.Unlock()
		cancel()
		_ = ws.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	r.conns[conn] = struct{}{}
	r.wg.Add(1)
	r.mu.Unlock()
	conn.serve()
	r.mu.Lock()
	delete(r.conns, conn)
	r.mu.Unlock()
	r.wg.Done()
}

// Close stops new subscriptions, cancels every operation, closes all hijacked
// WebSocket connections, then stops the pub/sub reader
// and the queue observer. It is idempotent; the shared Redis/DB clients remain
// owned by main and are closed afterwards.
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		r.closing.Store(true)
		r.mu.Lock()
		connections := make([]*connection, 0, len(r.conns))
		for conn := range r.conns {
			connections = append(connections, conn)
		}
		r.mu.Unlock()
		for _, conn := range connections {
			conn.shutdown(websocket.StatusGoingAway, "server shutting down")
		}
		done := make(chan struct{})
		go func() {
			r.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-ctx.Done():
			r.mu.Lock()
			for conn := range r.conns {
				conn.forceClose()
			}
			r.mu.Unlock()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
			}
		}
		if r.bus != nil {
			if err := r.bus.Close(ctx); err != nil {
				r.closeErr = err
			}
		}
		if r.queue != nil {
			if err := r.queue.Close(ctx); err != nil && r.closeErr == nil {
				r.closeErr = err
			}
		}
	})
	return r.closeErr
}

func internalErrorPayload() json.RawMessage {
	return json.RawMessage(upstreamErrorPayload)
}

func internalErrorArray() json.RawMessage {
	return json.RawMessage(upstreamErrorArray)
}

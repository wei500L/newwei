package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/exceptioningest"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/exec"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// exceptionRecordTimeout bounds one best-effort insert, matching the legacy 404
// recorder: a slow or unreachable Mongo must not keep a goroutine alive.
const exceptionRecordTimeout = 5 * time.Second

// errNoMongoHandle reports a recorder built without a connection handle.
var errNoMongoHandle = errors.New("no Mongo connection handle")

// errNoMongoURI reports a recorder with no MONGO_URI configured.
var errNoMongoURI = errors.New("MONGO_URI is not configured")

// exceptionRecorder owns the process-wide exception-event recorder shared by the
// REST error exits (authhttp.SetExceptionRecorder) and the GraphQL executor
// (exec.Engine.SetErrorRecorder).
//
// It adapts those two typed seams onto the exceptioningest.Service the migrated
// exception endpoints and the Go-owned 404 paths already write through, so every
// Go-recorded event lands in the same exceptionevents collection with the same
// document shape that the existing admin read endpoints query.
//
// # Ownership
//
// Only Go-written responses are recorded here. Anything the gateway proxies to
// NestJS keeps NestJS's own filter and its own event, so a legacy or shadow
// response is never double-recorded. The Go-owned 404 paths keep their existing
// nestnotfound recorder (same shape, same message); they never reach authhttp, so
// this recorder does not see them.
//
// # Laziness
//
// The service is built on the first recorded event rather than at startup. The
// default configuration proxies everything to NestJS, so opening a second Mongo
// client at boot would change the process's resource use for a side channel that
// may never be used. Once opened, the connection is handed back to the shared
// *dashboardstats.Connection so the existing teardown closes it.
//
// # Best effort
//
// An insert runs in its own goroutine with a detached, bounded context. It never
// changes a response, never blocks one, and has no retry, queue or second store.
type exceptionRecorder struct {
	cfg        config.Config
	mongoConn  **dashboardstats.Connection
	redis      *redis.Client
	mu         sync.Mutex
	service    *exceptioningest.Service
	disabled   bool
	inflight   sync.WaitGroup
	now        func() time.Time
	traceIDFor func(*http.Request) string
}

// newExceptionRecorder builds the recorder. A nil connection handle yields nil so
// the caller installs nothing.
func newExceptionRecorder(cfg config.Config, mongoConn **dashboardstats.Connection, redisClient *redis.Client) *exceptionRecorder {
	if mongoConn == nil {
		return nil
	}
	return &exceptionRecorder{
		cfg:        cfg,
		mongoConn:  mongoConn,
		redis:      redisClient,
		now:        time.Now,
		traceIDFor: requestTraceID,
	}
}

// rest satisfies authhttp.ExceptionRecorder. statusCode and message are the values
// just written to the client; orgID/userID come from the verified identity the
// authentication chain published, never from the request body.
func (r *exceptionRecorder) rest(req *http.Request, statusCode int, orgID, userID, message string) {
	if r == nil || req == nil {
		return
	}
	event := exceptioningest.ExceptionEvent{
		Kind:       exceptioningest.KindHTTP,
		TraceID:    r.traceIDFor(req),
		Timestamp:  r.now().UTC(),
		StatusCode: intPointer(statusCode),
		Message:    message,
		Path:       req.URL.RequestURI(),
		Method:     req.Method,
		OrgID:      orgID,
		UserID:     userID,
		ErrorName:  authhttp.ExceptionNameForStatus(statusCode),
	}
	r.enqueue(req.Context(), event)
}

// graphql satisfies exec.ErrorRecorder. The event is recorded regardless of the
// HTTP status: a resolver failure that leaves `data` partially populated and the
// response at 200 is exactly the case the NestJS filter records through
// GqlArgumentsHost.
func (r *exceptionRecorder) graphql(failure exec.ResolverError) {
	if r == nil {
		return
	}
	event := exceptioningest.ExceptionEvent{
		Kind:          exceptioningest.KindGraphQL,
		TraceID:       failure.TraceID,
		Timestamp:     r.now().UTC(),
		StatusCode:    intPointer(failure.StatusCode),
		Message:       failure.Message,
		Operation:     failure.Operation,
		OperationName: failure.OperationName,
		OrgID:         failure.OrgID,
		UserID:        failure.UserID,
		ErrorName:     failure.ErrorName,
	}
	r.enqueue(context.Background(), event)
}

// enqueue hands one event to a bounded goroutine. The request context is detached
// so a client that disconnects right after receiving the error cannot cancel the
// insert.
func (r *exceptionRecorder) enqueue(ctx context.Context, event exceptioningest.ExceptionEvent) {
	service := r.sharedService()
	if service == nil {
		return
	}
	r.inflight.Add(1)
	go func() {
		defer r.inflight.Done()
		recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), exceptionRecordTimeout)
		defer cancel()
		service.RecordInternal(recordCtx, event)
	}()
}

// sharedService returns the service, opening the shared Mongo handle on first
// use. A configuration that cannot open one disables recording permanently and
// logs once, so a broken DSN cannot turn every error response into a dial attempt.
func (r *exceptionRecorder) sharedService() *exceptioningest.Service {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.service != nil || r.disabled {
		return r.service
	}
	if *r.mongoConn == nil {
		if r.cfg.MongoURI == "" {
			log.Printf("api-go: exception recording disabled: %v", errNoMongoURI)
			r.disabled = true
			return nil
		}
		conn, err := dashboardstats.Open(r.cfg.MongoURI)
		if err != nil {
			log.Printf("api-go: exception recording disabled: %v", err)
			r.disabled = true
			return nil
		}
		*r.mongoConn = conn
	}
	r.service = exceptioningest.NewService((*r.mongoConn).Database(), r.redis, exceptioningest.Config{
		UserRateLimit:          r.cfg.ObservabilityClientExceptionUserRateLimit,
		IPRateLimit:            r.cfg.ObservabilityClientExceptionIPRateLimit,
		RateLimitWindowSeconds: r.cfg.ObservabilityClientExceptionWindowSeconds,
		TrustProxy:             r.cfg.TrustProxy,
		InternalToken:          r.cfg.LiteLLMConfigInternalTokenRaw,
	})
	return r.service
}

// wait blocks until the outstanding inserts finish, the timeout expires, or ctx is
// cancelled. main calls it before the shared Mongo client closes.
func (r *exceptionRecorder) wait(ctx context.Context, timeout time.Duration) {
	if r == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		r.inflight.Wait()
		close(done)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-ctx.Done():
	case <-timer.C:
		log.Printf("api-go: exception recorder still had inserts after %s", timeout)
	}
}

// requestTraceID reads the trace id TraceMiddleware installed, falling back to the
// same derivation the error writers use when a handler runs without it (a direct
// handler test).
func requestTraceID(req *http.Request) string {
	if id := httpx.TraceIDFromContext(req.Context()); id != "" {
		return id
	}
	return httpx.EnsureTraceID(req.Header.Get("x-trace-id"))
}

// intPointer returns a pointer to value, for an event's optional statusCode.
func intPointer(value int) *int { return &value }

package realtimesocket

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
)

const (
	testSecret   = "realtime-socket-test-secret"
	testIssuer   = "realtime-socket-test-issuer"
	testAudience = "realtime-socket-test-audience"
	testTimeout  = 5 * time.Second
)

// fakeLimiter replaces the Redis sliding-window limiter in unit tests. All
// buckets are open by default and every call is recorded.
type fakeLimiter struct {
	mu sync.Mutex

	ipAllowed        bool
	ipRetryAfterMS   int64
	userAllowed      bool
	userRetryAfterMS int64
	backoff          time.Duration

	ipChecks         int
	userChecks       int
	recordedFailures []string
	clearedBackoffs  []string
}

func newTestVerifier() *authn.Verifier {
	return authn.NewVerifier(testSecret, testIssuer, testAudience)
}

func newFakeLimiter() *fakeLimiter {
	return &fakeLimiter{ipAllowed: true, userAllowed: true}
}

func (f *fakeLimiter) CheckIP(_ context.Context, _ string) (bool, int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ipChecks++
	return f.ipAllowed, f.ipRetryAfterMS
}

func (f *fakeLimiter) CheckUser(_ context.Context, _ string) (bool, int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.userChecks++
	return f.userAllowed, f.userRetryAfterMS
}

func (f *fakeLimiter) BackoffDelay(_ context.Context, _ string) time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.backoff
}

func (f *fakeLimiter) RecordFailure(_ context.Context, ip string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordedFailures = append(f.recordedFailures, ip)
}

func (f *fakeLimiter) ClearBackoff(_ context.Context, ip string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clearedBackoffs = append(f.clearedBackoffs, ip)
}

func (f *fakeLimiter) setIP(allowed bool, retryAfterMS int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ipAllowed = allowed
	f.ipRetryAfterMS = retryAfterMS
}

func (f *fakeLimiter) setUser(allowed bool, retryAfterMS int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.userAllowed = allowed
	f.userRetryAfterMS = retryAfterMS
}

func (f *fakeLimiter) setBackoff(delay time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.backoff = delay
}

func (f *fakeLimiter) failures() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.recordedFailures...)
}

// fakeBlacklist is the in-memory authn.Blacklist used by the tests.
type fakeBlacklist struct {
	mu      sync.Mutex
	revoked map[string]bool
	err     error
	calls   int
}

func newFakeBlacklist() *fakeBlacklist {
	return &fakeBlacklist{revoked: map[string]bool{}}
}

func (f *fakeBlacklist) Revoked(_ context.Context, jti string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return false, f.err
	}
	return f.revoked[jti], nil
}

func (f *fakeBlacklist) setRevoked(jti string, revoked bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked[jti] = revoked
}

func (f *fakeBlacklist) setError(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeBlacklist) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// fakeAuthzRepository is the in-memory authz.Repository used by the tests. It
// returns the configured permission set for any (userID, orgID) pair unless a
// rejection or infrastructure error is configured.
type fakeAuthzRepository struct {
	mu          sync.Mutex
	permissions map[string]bool
	rejection   error
	err         error
	calls       int
}

func newFakeAuthzRepository(permissions ...string) *fakeAuthzRepository {
	repository := &fakeAuthzRepository{permissions: map[string]bool{}}
	for _, permission := range permissions {
		repository.permissions[permission] = true
	}
	return repository
}

func (f *fakeAuthzRepository) Authorize(_ context.Context, userID, orgID string) (*authz.Authorization, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	if f.rejection != nil {
		return nil, f.rejection
	}
	permissions := make(map[string]bool, len(f.permissions))
	for name, granted := range f.permissions {
		permissions[name] = granted
	}
	return &authz.Authorization{UserID: userID, OrgID: orgID, Permissions: permissions}, nil
}

func (f *fakeAuthzRepository) setPermissions(permissions ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.permissions = map[string]bool{}
	for _, permission := range permissions {
		f.permissions[permission] = true
	}
}

func (f *fakeAuthzRepository) setRejection(message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rejection = &authz.Rejection{Message: message}
}

func (f *fakeAuthzRepository) setError(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeAuthzRepository) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// recordingClientEvents records the callbacks delivered to the ClientEvents
// sink.
type recordedClientEvent struct {
	namespace string
	identity  ClientIdentity
	event     string
	args      json.RawMessage
}

type recordedClientDisconnect struct {
	namespace string
	identity  ClientIdentity
}

type recordingClientEvents struct {
	mu          sync.Mutex
	events      []recordedClientEvent
	disconnects []recordedClientDisconnect
}

func (r *recordingClientEvents) HandleClientEvent(namespace string, identity ClientIdentity, event string, args json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, recordedClientEvent{
		namespace: namespace,
		identity:  identity,
		event:     event,
		args:      append(json.RawMessage(nil), args...),
	})
}

func (r *recordingClientEvents) HandleClientDisconnect(namespace string, identity ClientIdentity) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.disconnects = append(r.disconnects, recordedClientDisconnect{namespace: namespace, identity: identity})
}

func (r *recordingClientEvents) eventSnapshot() []recordedClientEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedClientEvent(nil), r.events...)
}

func (r *recordingClientEvents) eventCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func (r *recordingClientEvents) disconnectSnapshot() []recordedClientDisconnect {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedClientDisconnect(nil), r.disconnects...)
}

func (r *recordingClientEvents) disconnectCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.disconnects)
}

// testRuntime bundles a wired Runtime with its fake dependencies and the
// in-process HTTP server the browser dials.
type testRuntime struct {
	runtime      *Runtime
	httpServer   *httptest.Server
	limiter      *fakeLimiter
	blacklist    *fakeBlacklist
	repository   *fakeAuthzRepository
	clientEvents *recordingClientEvents
}

func newTestRuntime(t *testing.T, configure func(*Options)) *testRuntime {
	t.Helper()
	limiter := newFakeLimiter()
	blacklist := newFakeBlacklist()
	repository := newFakeAuthzRepository(
		permissionItemsRead,
		permissionCrawlRead,
		permissionCrawlWrite,
		permissionSettingsManage,
		permissionQueueManage,
	)
	clientEvents := &recordingClientEvents{}
	options := Options{
		Verifier:              newTestVerifier(),
		Blacklist:             blacklist,
		Authz:                 repository,
		CORS:                  cors.New(""),
		MaxConnectionsPerUser: defaultMaxConnectionsPerUser,
		MaxConnectionsPerIP:   defaultMaxConnectionsPerIP,
		RevalidateInterval:    time.Hour,
		ClientEvents:          clientEvents,
		limiter:               limiter,
	}
	if configure != nil {
		configure(&options)
	}
	runtime, err := New(options)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	httpServer := httptest.NewServer(http.HandlerFunc(runtime.ServeHTTP))
	harness := &testRuntime{
		runtime:      runtime,
		httpServer:   httpServer,
		limiter:      limiter,
		blacklist:    blacklist,
		repository:   repository,
		clientEvents: clientEvents,
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		if closeErr := runtime.Close(ctx); closeErr != nil {
			t.Errorf("Runtime.Close() error = %v", closeErr)
		}
		httpServer.Close()
	})
	return harness
}

// newUnitRuntime builds a Runtime without an HTTP server for the revalidation
// decision tests.
func newUnitRuntime(t *testing.T, configure func(*Options)) (*Runtime, *fakeLimiter, *fakeBlacklist, *fakeAuthzRepository) {
	t.Helper()
	limiter := newFakeLimiter()
	blacklist := newFakeBlacklist()
	repository := newFakeAuthzRepository(
		permissionItemsRead,
		permissionCrawlRead,
		permissionCrawlWrite,
		permissionSettingsManage,
		permissionQueueManage,
	)
	options := Options{
		Verifier:              newTestVerifier(),
		Blacklist:             blacklist,
		Authz:                 repository,
		CORS:                  cors.New(""),
		MaxConnectionsPerUser: defaultMaxConnectionsPerUser,
		MaxConnectionsPerIP:   defaultMaxConnectionsPerIP,
		RevalidateInterval:    time.Hour,
		limiter:               limiter,
	}
	if configure != nil {
		configure(&options)
	}
	runtime, err := New(options)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		if closeErr := runtime.Close(ctx); closeErr != nil {
			t.Errorf("Runtime.Close() error = %v", closeErr)
		}
	})
	return runtime, limiter, blacklist, repository
}

// dial opens one Engine.IO WebSocket against the in-process server.
func (h *testRuntime) dial(t *testing.T) *websocket.Conn {
	t.Helper()
	return h.dialWith(t, "", nil)
}

// dialWith opens one WebSocket with optional extra query parameters and
// handshake headers.
func (h *testRuntime) dialWith(t *testing.T, extraQuery string, headers http.Header) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	target := "ws" + strings.TrimPrefix(h.httpServer.URL, "http") + Path + "/?EIO=4&transport=websocket"
	if extraQuery != "" {
		target += "&" + extraQuery
	}
	conn, response, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatalf("websocket.Dial() error = %v", err)
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

func readOpen(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	frame := mustReadFrame(t, conn)
	if !strings.HasPrefix(frame, "0") {
		t.Fatalf("first frame = %q, want an engine.io open packet", frame)
	}
}

func readFrame(conn *websocket.Conn, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		return "", err
	}
	if messageType != websocket.MessageText {
		return "", fmt.Errorf("unexpected WebSocket message type %d", messageType)
	}
	return string(data), nil
}

func mustReadFrame(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	frame, err := readFrame(conn, testTimeout)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return frame
}

func mustWriteFrame(t *testing.T, conn *websocket.Conn, frame string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
		t.Fatalf("write frame %q: %v", frame, err)
	}
}

// beginConnect writes one namespace CONNECT and consumes its acknowledgement.
// It returns the namespace socket id. The <ns>:connected or <ns>:error event
// written by the handler is left in the browser queue for the caller.
func beginConnect(t *testing.T, conn *websocket.Conn, namespace, token string) string {
	t.Helper()
	frame := "40" + namespace + ","
	if token != "" {
		authPayload, err := json.Marshal(struct {
			Token string `json:"token"`
		}{Token: token})
		if err != nil {
			t.Fatalf("marshal CONNECT auth: %v", err)
		}
		frame += string(authPayload)
	}
	mustWriteFrame(t, conn, frame)
	prefix := "40" + namespace + ","
	for attempt := 0; attempt < 100; attempt++ {
		reply := mustReadFrame(t, conn)
		if reply == "2" {
			mustWriteFrame(t, conn, "3")
			continue
		}
		if !strings.HasPrefix(reply, prefix) {
			t.Fatalf("expected CONNECT ack for %s, got %q", namespace, reply)
		}
		var ack struct {
			SID string `json:"sid"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(reply, prefix)), &ack); err != nil {
			t.Fatalf("CONNECT ack for %s is not JSON: %v (%s)", namespace, err, reply)
		}
		if ack.SID == "" {
			t.Fatalf("CONNECT ack for %s is missing sid: %s", namespace, reply)
		}
		return ack.SID
	}
	t.Fatalf("no CONNECT ack for namespace %s", namespace)
	return ""
}

// receivedEvent is one decoded Socket.IO EVENT frame.
type receivedEvent struct {
	namespace string
	event     string
	payload   json.RawMessage
}

func parseEventFrame(t *testing.T, frame string) receivedEvent {
	t.Helper()
	if !strings.HasPrefix(frame, "42") {
		t.Fatalf("not a socket.io EVENT frame: %q", frame)
	}
	rest := frame[2:]
	namespace := "/"
	if strings.HasPrefix(rest, "/") {
		comma := strings.IndexByte(rest, ',')
		if comma < 0 {
			t.Fatalf("EVENT frame is missing the namespace separator: %q", frame)
		}
		namespace = rest[:comma]
		rest = rest[comma+1:]
	}
	var fields []json.RawMessage
	if err := json.Unmarshal([]byte(rest), &fields); err != nil {
		t.Fatalf("EVENT frame payload is not a JSON array: %v (%s)", err, frame)
	}
	if len(fields) == 0 {
		t.Fatalf("EVENT frame has no event name: %s", frame)
	}
	var event string
	if err := json.Unmarshal(fields[0], &event); err != nil {
		t.Fatalf("EVENT frame name is not a string: %v (%s)", err, frame)
	}
	var payload json.RawMessage
	if len(fields) > 1 {
		payload = append(json.RawMessage(nil), fields[1]...)
	}
	return receivedEvent{namespace: namespace, event: event, payload: payload}
}

func readEvent(t *testing.T, conn *websocket.Conn) receivedEvent {
	t.Helper()
	return parseEventFrame(t, mustReadFrame(t, conn))
}

// expectConnected asserts the next event is the <ns>:connected payload with the
// exact field order orgId -> userId.
func expectConnected(t *testing.T, conn *websocket.Conn, namespace, orgID, userID string) {
	t.Helper()
	spec := namespaceSpecs[namespace]
	event := readEvent(t, conn)
	if event.namespace != namespace {
		t.Fatalf("connected event namespace = %q, want %q", event.namespace, namespace)
	}
	if event.event != spec.connectedEvent {
		t.Fatalf("%s event = %q, want %q", namespace, event.event, spec.connectedEvent)
	}
	wantPayload := fmt.Sprintf(`{"orgId":%q,"userId":%q}`, orgID, userID)
	if string(event.payload) != wantPayload {
		t.Fatalf("%s connected payload = %s, want %s", namespace, event.payload, wantPayload)
	}
}

// connectBrowser performs a successful namespace handshake and consumes the
// <ns>:connected event.
func connectBrowser(t *testing.T, conn *websocket.Conn, namespace, token, orgID, userID string) string {
	t.Helper()
	sid := beginConnect(t, conn, namespace, token)
	expectConnected(t, conn, namespace, orgID, userID)
	return sid
}

// expectErrorEvent asserts the next event is the namespace error with the exact
// JSON payload.
func expectErrorEvent(t *testing.T, conn *websocket.Conn, namespace, wantPayload string) {
	t.Helper()
	spec := namespaceSpecs[namespace]
	event := readEvent(t, conn)
	if event.namespace != namespace {
		t.Fatalf("error event namespace = %q, want %q", event.namespace, namespace)
	}
	if event.event != spec.errorEvent {
		t.Fatalf("%s error event = %q, want %q", namespace, event.event, spec.errorEvent)
	}
	if string(event.payload) != wantPayload {
		t.Fatalf("%s error payload = %s, want %s", namespace, event.payload, wantPayload)
	}
}

// expectEvent asserts the next event is event in namespace and returns it.
func expectEvent(t *testing.T, conn *websocket.Conn, namespace, event string) receivedEvent {
	t.Helper()
	received := readEvent(t, conn)
	if received.namespace != namespace || received.event != event {
		t.Fatalf("event = %q on %q, want %q on %q", received.event, received.namespace, event, namespace)
	}
	return received
}

// expectFrame asserts the next raw frame.
func expectFrame(t *testing.T, conn *websocket.Conn, want string) {
	t.Helper()
	if frame := mustReadFrame(t, conn); frame != want {
		t.Fatalf("frame = %q, want %q", frame, want)
	}
}

// expectClosed asserts the transport is closed and unreadable.
func expectClosed(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if frame, err := readFrame(conn, 2*time.Second); err == nil {
		t.Fatalf("expected the connection to be closed, read frame %q", frame)
	}
}

func signToken(t *testing.T, userID, orgID, jti string, expiresAt time.Time) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":   userID,
		"orgId": orgID,
		"iss":   testIssuer,
		"aud":   testAudience,
	}
	if jti != "" {
		claims["jti"] = jti
	}
	if !expiresAt.IsZero() {
		claims["exp"] = expiresAt.Unix()
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign access token: %v", err)
	}
	return signed
}

func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

package telegramclient

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/crypto"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/tg"
)

const (
	// defaultDCID is GramJS DEFAULT_DC_ID. An empty StringSession connects to
	// DC 4 first (client/telegramClient.js: `this.session.dcId || 4`), so the
	// temporary login client mirrors that instead of gotd's default DC 2.
	defaultDCID = 4

	// gramJSAppVersion and gramJSLangCode are the fallbacks from GramJS
	// clientParamsDefault (client/telegramBaseClient.js); the empty strings for
	// deviceModel/systemVersion are filled from the runtime like
	// os.type()/os.release() there.
	gramJSAppVersion = "1.0"
	gramJSLangCode   = "en"

	// exportFreshnessAttempts/exportFreshnessInterval bound the ExportSession
	// wait for gotd to persist the live session. gotd signals client ready
	// (which is what Start waits for) just before it calls saveSession, and after
	// a DC migration the old storage entry still has the previous DC, so a short
	// poll is required to export the final session reliably.
	exportFreshnessAttempts = 100
	exportFreshnessInterval = 10 * time.Millisecond
)

// ErrClientClosed is returned by Start/Run after Close.
var ErrClientClosed = errors.New("telegramclient: client is closed")

// ErrAlreadyStarted is returned when a Client is started twice. Run may be
// called once per client; Start is idempotent and only waits for readiness.
var ErrAlreadyStarted = errors.New("telegramclient: client was already started")

// ErrNoSession is returned by ExportSession when no authorization key has been
// established yet (for example a fresh temporary client that did not connect).
var ErrNoSession = errors.New("telegramclient: no live session")

// Device is the client device fingerprint sent in initConnection. A zero field
// falls back to the GramJS default: deviceModel -> os.type(), systemVersion ->
// os.release(), appVersion -> "1.0", langCode -> "en".
type Device struct {
	Model         string
	SystemVersion string
	AppVersion    string
	LangCode      string
}

// Options configures a Client.
type Options struct {
	APIID   int
	APIHash string
	// Session is the imported GramJS session. The zero value means "no
	// authorization key": a fresh temporary client for the login flow.
	Session Session
	Device  Device
}

// telegramAPI is the narrow RPC surface the polling client needs. It is
// satisfied by *tg.Client, the production value, and by a fake in tests.
type telegramAPI interface {
	ContactsResolveUsername(ctx context.Context, request *tg.ContactsResolveUsernameRequest) (*tg.ContactsResolvedPeer, error)
	MessagesGetHistory(ctx context.Context, request *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error)
}

// authAPI is the narrow auth surface used by the login API. It is satisfied by
// *auth.Client and by a fake in tests.
type authAPI interface {
	SendCode(ctx context.Context, phone string, options auth.SendCodeOptions) (tg.AuthSentCodeClass, error)
	SignIn(ctx context.Context, phone, code, codeHash string) (*tg.AuthAuthorization, error)
	Password(ctx context.Context, password string) (*tg.AuthAuthorization, error)
}

// PollClient is the polling surface the signals worker depends on. *Client
// implements it; the worker and the Manager tests can substitute a fake.
type PollClient interface {
	// ResolveChannel resolves a channel handle to its id and access hash,
	// through the O1 Redis cache when available.
	ResolveChannel(ctx context.Context, handle string) (Peer, error)
	// FetchHistory returns up to limit messages newer than minID, newest first.
	FetchHistory(ctx context.Context, peer Peer, limit, minID int) ([]Message, error)
}

// Compile-time checks: the production gotd types must satisfy the narrow
// interfaces the client is built on.
var (
	_ telegramAPI     = (*tg.Client)(nil)
	_ authAPI         = (*auth.Client)(nil)
	_ PollClient      = (*Client)(nil)
	_ session.Storage = (*memoryStorage)(nil)
)

// Client is the gotd-backed MTProto client. It owns the session storage, the
// first-ready signal and the background Run lifecycle that gotd does not
// provide itself.
//
// One Client corresponds to one MTProto connection. Run blocks with a single
// connection that gotd reconnects internally; Start starts the same connection
// in a goroutine whose lifetime is bound to Close (not to the Start context) and
// returns when the first connection is ready. RPC calls through API() are safe
// for concurrent use: gotd multiplexes requests and waits for reconnection
// inside each call, so every call must carry a deadline.
type Client struct {
	tg      *telegram.Client
	api     telegramAPI
	auth    authAPI
	storage *memoryStorage

	peerCache peerCacheStore

	startMu   sync.Mutex
	started   bool
	closed    bool
	cancel    context.CancelFunc
	ready     chan struct{}
	done      chan struct{}
	readyOnce sync.Once
	closeOnce sync.Once
	runErrMu  sync.Mutex
	runErr    error

	handlesMu       sync.RWMutex
	handleByChannel map[int64]string
}

// New builds an unstarted client. A non-zero Session is validated and preloaded
// into the client storage, so the first Run resumes it instead of creating a new
// authorization key. New performs no network I/O.
func New(opts Options) (*Client, error) {
	if opts.APIID <= 0 {
		return nil, fmt.Errorf("telegramclient: APIID must be positive, got %d", opts.APIID)
	}
	if strings.TrimSpace(opts.APIHash) == "" {
		return nil, errors.New("telegramclient: APIHash is empty")
	}

	storage := &memoryStorage{}
	dc := defaultDCID
	if !opts.Session.IsZero() {
		if err := validateSession(opts.Session); err != nil {
			return nil, err
		}
		if err := storage.saveData(context.Background(), sessionDataFrom(opts.Session)); err != nil {
			return nil, fmt.Errorf("telegramclient: preload session storage: %w", err)
		}
		dc = opts.Session.DC
	}

	c := &Client{
		storage:         storage,
		ready:           make(chan struct{}),
		done:            make(chan struct{}),
		handleByChannel: make(map[int64]string),
	}
	c.tg = telegram.NewClient(opts.APIID, opts.APIHash, telegram.Options{
		SessionStorage: storage,
		DC:             dc,
		NoUpdates:      true,
		Device:         deviceConfig(opts.Device),
	})
	c.api = c.tg.API()
	c.auth = c.tg.Auth()
	return c, nil
}

// Run starts the client and blocks until the connection is closed (gotd
// reconnects internally, so this is a long-lived call). It returns nil when ctx
// is cancelled, the fatal connection error otherwise, and ErrClientClosed after
// Close.
func (c *Client) Run(ctx context.Context) error {
	runCtx, cancel, err := c.beginRun(ctx)
	if err != nil {
		return err
	}
	defer cancel()

	runErr := c.tg.Run(runCtx, c.runCallback())
	c.finishRun(runErr)
	return runErr
}

// Start starts Run in a goroutine and returns once the first connection is
// ready or ctx expires. The connection lifetime is bound to Close, not to ctx,
// so request-scoped callers can use a request context here. Start is
// idempotent: calling it again only waits for readiness.
func (c *Client) Start(ctx context.Context) error {
	c.startMu.Lock()
	if c.closed {
		c.startMu.Unlock()
		return ErrClientClosed
	}
	if !c.started {
		c.started = true
		runCtx, cancel := context.WithCancel(context.Background())
		c.cancel = cancel
		c.startMu.Unlock()
		go func() {
			runErr := c.tg.Run(runCtx, c.runCallback())
			c.finishRun(runErr)
		}()
	} else {
		c.startMu.Unlock()
	}

	select {
	case <-c.ready:
		return nil
	case <-c.done:
		if err := c.runError(); err != nil {
			return err
		}
		return ErrClientClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Ready is closed after the first successful connection. It is never closed if
// the client fails before connecting; select on it together with Start/done.
func (c *Client) Ready() <-chan struct{} {
	return c.ready
}

// Close stops the connection and waits for Run to return. It is idempotent.
func (c *Client) Close() {
	c.closeOnce.Do(func() {
		c.startMu.Lock()
		c.closed = true
		cancel := c.cancel
		started := c.started
		c.startMu.Unlock()

		if cancel != nil {
			cancel()
		}
		if started {
			<-c.done
		}
	})
}

// API returns the generated Telegram RPC client. It is safe for concurrent use
// from any goroutine; calls block while the client reconnects and should carry
// their own deadline.
func (c *Client) API() *tg.Client {
	return c.tg.API()
}

// ExportSession returns the live session (DC, host, port and authorization key)
// as stored by gotd. gotd re-saves the session after the initial key exchange
// and after a DC migration, so a login that jumped to the phone's home DC exports
// the final DC. gotd never stores the address, so it is derived from the server
// DC options (falling back to the static production list).
//
// gotd calls OnReady (the Run callback Start waits for) just before saveSession,
// and a migrated connection may still have the previous DC in storage; a started
// client therefore polls the storage briefly until the persisted DC matches the
// live client config. A client that was never started simply exports whatever
// session was preloaded from Options.Session.
func (c *Client) ExportSession() (Session, error) {
	data, err := c.liveSessionData()
	if err != nil {
		return Session{}, err
	}

	address, port, err := dcAddress(data)
	if err != nil {
		return Session{}, err
	}
	return Session{
		DC:      data.DC,
		Address: address,
		Port:    port,
		AuthKey: append([]byte(nil), data.AuthKey...),
	}, nil
}

// liveSessionData loads the session storage, waiting briefly for gotd to persist
// the live DC when the client is running (see ExportSession).
func (c *Client) liveSessionData() (*session.Data, error) {
	loader := &session.Loader{Storage: c.storage}
	attempts := 1
	if c.isStarted() {
		attempts = exportFreshnessAttempts
	}

	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		data, err := loader.Load(context.Background())
		if err == nil && data != nil && len(data.AuthKey) == AuthKeySize && len(data.AuthKeyID) == 8 && c.sessionFresh(data) {
			return data, nil
		}
		if err == nil {
			lastErr = errors.New("telegramclient: session is not persisted yet")
		} else {
			lastErr = err
		}
		if attempt+1 < attempts {
			time.Sleep(exportFreshnessInterval)
		}
	}
	if errors.Is(lastErr, session.ErrNotFound) {
		return nil, ErrNoSession
	}
	return nil, fmt.Errorf("telegramclient: export session: %w", lastErr)
}

// sessionFresh reports whether the persisted session belongs to the connection
// that is currently live. Before the first connection gotd has no ThisDC, and
// the preloaded session is by definition the one to export.
func (c *Client) sessionFresh(data *session.Data) bool {
	thisDC := c.tg.Config().ThisDC
	if thisDC == 0 {
		return true
	}
	return data.DC == thisDC
}

// isStarted reports whether Run/Start was called at least once.
func (c *Client) isStarted() bool {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	return c.started
}

// ExportStringSession returns the GramJS StringSession string of the live
// session.
func (c *Client) ExportStringSession() (string, error) {
	sessionData, err := c.ExportSession()
	if err != nil {
		return "", err
	}
	return EncodeStringSession(sessionData)
}

// setPeerCache installs the O1 peer cache. The Manager does this for the
// production clients; a nil cache disables caching (ResolveChannel still works,
// it just performs the RPC every time).
func (c *Client) setPeerCache(cache peerCacheStore) {
	c.peerCache = cache
}

// beginRun marks the client as started and returns the Run context.
func (c *Client) beginRun(parent context.Context) (context.Context, context.CancelFunc, error) {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	if c.closed {
		return nil, nil, ErrClientClosed
	}
	if c.started {
		return nil, nil, ErrAlreadyStarted
	}
	c.started = true
	runCtx, cancel := context.WithCancel(parent)
	c.cancel = cancel
	return runCtx, cancel, nil
}

// runCallback is handed to gotd Run: it fires once the connection is
// initialized (including for an unauthenticated temporary client) and records
// readiness, then blocks until the client shuts down.
func (c *Client) runCallback() func(context.Context) error {
	return func(ctx context.Context) error {
		c.readyOnce.Do(func() { close(c.ready) })
		<-ctx.Done()
		return ctx.Err()
	}
}

// finishRun records the Run result and closes done exactly once.
func (c *Client) finishRun(err error) {
	c.runErrMu.Lock()
	c.runErr = err
	c.runErrMu.Unlock()
	close(c.done)
}

func (c *Client) runError() error {
	c.runErrMu.Lock()
	defer c.runErrMu.Unlock()
	return c.runErr
}

// validateSession rejects a decoded session that cannot be connected with.
// DecodeStringSession mirrors GramJS decoding including its pathological ports;
// this is the stricter check used before dialing.
func validateSession(s Session) error {
	if s.DC < 1 || s.DC > 255 {
		return fmt.Errorf("telegramclient: session DC %d is invalid", s.DC)
	}
	if s.Address == "" {
		return errors.New("telegramclient: session address is empty")
	}
	if s.Port < 1 || s.Port > 65535 {
		return fmt.Errorf("telegramclient: session port %d is invalid", s.Port)
	}
	if len(s.AuthKey) != AuthKeySize {
		return fmt.Errorf("telegramclient: session auth key is %d bytes, want %d", len(s.AuthKey), AuthKeySize)
	}
	return nil
}

// sessionDataFrom converts a decoded GramJS session into gotd session.Data.
// AuthKeyID is recomputed from the key (sha1(key)[12:]) because gotd validates
// it on restore, and the salt is left at zero: the first bad_server_salt reply
// stores the real salt and saves the session again.
func sessionDataFrom(s Session) *session.Data {
	var key crypto.Key
	copy(key[:], s.AuthKey)
	withID := key.WithID()
	return &session.Data{
		DC:        s.DC,
		Addr:      fmt.Sprintf("%s:%d", s.Address, s.Port),
		AuthKey:   append([]byte(nil), withID.Value[:]...),
		AuthKeyID: append([]byte(nil), withID.ID[:]...),
		Salt:      0,
	}
}

// dcAddress derives host and port for the exported session. gotd never writes
// session.Data.Addr; GramJS instead takes the address from help.getConfig
// dcOptions and hard-codes port 443 (client/telegramClient.js getDC). The same
// rule is used here, with the static production DC list as a fallback.
func dcAddress(data *session.Data) (string, int, error) {
	if data.DC == 0 {
		return "", 0, fmt.Errorf("telegramclient: session has no DC")
	}
	for _, option := range data.Config.DCOptions {
		if option.ID == data.DC && !option.Ipv6 && !option.MediaOnly && !option.CDN && option.IPAddress != "" {
			return option.IPAddress, 443, nil
		}
	}
	for _, option := range dcs.Prod().Options {
		if option.ID == data.DC && !option.Ipv6 && !option.MediaOnly && option.IPAddress != "" {
			return option.IPAddress, 443, nil
		}
	}
	return "", 0, fmt.Errorf("telegramclient: no address for DC %d", data.DC)
}

// deviceConfig fills zero Device fields with the GramJS defaults. The empty
// model/system version fallbacks in GramJS are os.type()/os.release(); the Go
// process runs in the same container as the NestJS one, so runtime.GOOS mapped
// to Node's os.type() strings and the Linux kernel release are the closest
// deterministic equivalents.
func deviceConfig(device Device) telegram.DeviceConfig {
	model := strings.TrimSpace(device.Model)
	if model == "" {
		model = nodeOSType()
	}
	systemVersion := strings.TrimSpace(device.SystemVersion)
	if systemVersion == "" {
		systemVersion = osRelease()
	}
	appVersion := strings.TrimSpace(device.AppVersion)
	if appVersion == "" {
		appVersion = gramJSAppVersion
	}
	langCode := strings.TrimSpace(device.LangCode)
	if langCode == "" {
		langCode = gramJSLangCode
	}
	return telegram.DeviceConfig{
		DeviceModel:    model,
		SystemVersion:  systemVersion,
		AppVersion:     appVersion,
		SystemLangCode: gramJSLangCode,
		LangCode:       langCode,
	}
}

// nodeOSType mirrors Node's os.type() for the platforms the API runs on.
func nodeOSType() string {
	switch runtime.GOOS {
	case "linux":
		return "Linux"
	case "darwin":
		return "Darwin"
	case "windows":
		return "Windows_NT"
	default:
		return runtime.GOOS
	}
}

// osRelease mirrors Node's os.release() as closely as possible without
// platform-specific syscalls: on Linux the kernel release, otherwise GOOS.
func osRelease() string {
	if data, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if version := strings.TrimSpace(string(data)); version != "" {
			return version
		}
	}
	return runtime.GOOS
}

// memoryStorage is the session.Storage implementation gotd writes into. It
// keeps the raw Loader JSON in memory: gotd saves on every connection
// initialization and after DC migration, so ExportSession always sees the live
// session. The Manager never persists this data back into the settings row.
type memoryStorage struct {
	mu   sync.RWMutex
	data []byte
}

// LoadSession implements session.Storage.
func (s *memoryStorage) LoadSession(context.Context) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.data) == 0 {
		return nil, session.ErrNotFound
	}
	return append([]byte(nil), s.data...), nil
}

// StoreSession implements session.Storage. gotd calls it from the connection
// goroutine, hence the mutex.
func (s *memoryStorage) StoreSession(_ context.Context, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = append([]byte(nil), data...)
	return nil
}

// loadData reads the current session through session.Loader.
func (s *memoryStorage) loadData(ctx context.Context) (*session.Data, error) {
	return (&session.Loader{Storage: s}).Load(ctx)
}

// saveData writes a session through session.Loader.
func (s *memoryStorage) saveData(ctx context.Context, data *session.Data) error {
	return (&session.Loader{Storage: s}).Save(ctx, data)
}

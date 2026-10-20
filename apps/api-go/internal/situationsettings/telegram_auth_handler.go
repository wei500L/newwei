package situationsettings

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

// This file serves the two POST entries NestJS keeps in
// SituationMonitorSettingsController:
//
//	POST /api/system-settings/situation-monitor/telegram-auth/start
//	POST /api/system-settings/situation-monitor/telegram-auth/complete
//
// Both are @Post handlers in NestJS without @HttpCode, so a successful response
// is HTTP 201 Created (the same convention the other migrated POST handlers
// use, e.g. internal/gdeltsnapshot). The controller-level
// @Permissions("settings.manage") guard is applied through
// platformgovernance.Authenticator exactly like the settings handler.
//
// Known accepted deviations from NestJS (documented in the PR):
//   - readBodyOrFail caps the JSON body at 1MiB; NestJS accepts 10mb. The login
//     bodies are tiny (a phone number, a request id, a code, a password), so the
//     cap is unreachable for legitimate clients.
//   - Error bodies use r.URL.Path as `path` (the shared authhttp convention);
//     NestJS uses request.url, which also contains a query string. The login
//     routes are called without query parameters, so the bytes match on the
//     supported surface.

const (
	telegramAuthStartPath    = telegramAuthPath + "/start"
	telegramAuthCompletePath = telegramAuthPath + "/complete"
)

// TelegramAuthHandlerOptions collects the collaborators of the two login
// routes. Redis is the shared go-redis client (pending cache + the four
// rate-limit buckets); Settings is the same *Service the settings handler uses.
type TelegramAuthHandlerOptions struct {
	Auth     *platformgovernance.Authenticator
	Settings *Service
	Telegram TelegramAuthClientFactory
	Redis    *redis.Client

	// TrustProxy is TRUST_PROXY, used to resolve the client IP exactly like
	// NestJS resolveRequestIp (see apps/api/src/main.ts's app.set("trust proxy")
	// and common/request-ip.ts).
	TrustProxy string
	// RateLimitFailOpen is RATE_LIMIT_REDIS_FAIL_OPEN (default false =>
	// a Redis failure answers the same 429 as an exhausted quota).
	RateLimitFailOpen bool

	External  ExternalSnapshotProvider
	Quality   QualitySummaryProvider
	Scheduler TelegramScheduler
}

// telegramAuthAuthorizer is platformgovernance.Authenticator's Authorize
// subset; the interface keeps handler tests free of the JWT/MySQL chain.
type telegramAuthAuthorizer interface {
	Authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity
}

// TelegramAuthHandler serves the start/complete routes. Every other path or
// method is a 404 (the legacyproxy routing table never sends them here).
type TelegramAuthHandler struct {
	auth       telegramAuthAuthorizer
	settings   telegramAuthSettings
	service    *telegramAuthService
	external   ExternalSnapshotProvider
	quality    QualitySummaryProvider
	scheduler  TelegramScheduler
	trustProxy string
}

// NewTelegramAuthHandler wires the authenticator, the shared settings service,
// the MTProto client factory/adapters and the response extras.
func NewTelegramAuthHandler(options TelegramAuthHandlerOptions) *TelegramAuthHandler {
	handler := &TelegramAuthHandler{
		external:   options.External,
		quality:    options.Quality,
		scheduler:  options.Scheduler,
		trustProxy: options.TrustProxy,
	}
	if options.Auth != nil {
		handler.auth = options.Auth
	}
	if options.Settings != nil {
		handler.settings = options.Settings
	}
	handler.service = newTelegramAuthService(telegramAuthServiceOptions{
		Settings: handler.settings,
		Telegram: options.Telegram,
		Store:    newRedisTelegramAuthStore(options.Redis),
		Limiter:  newRedisTelegramAuthRateLimiter(options.Redis, options.RateLimitFailOpen),
	})
	return handler
}

// ServeHTTP dispatches the two exact POST paths; everything else is the NestJS
// "Cannot METHOD /path" 404.
func (h *TelegramAuthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.settings == nil || h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch {
	case r.URL.Path == telegramAuthStartPath && r.Method == http.MethodPost:
		h.serveStart(w, r)
	case r.URL.Path == telegramAuthCompletePath && r.Method == http.MethodPost:
		h.serveComplete(w, r)
	default:
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
	}
}

func (h *TelegramAuthHandler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	return h.auth.Authorize(w, r, requiredPermission)
}

// serveStart mirrors startTelegramAuth: 201
// {requestId, isCodeViaApp, expiresAt}.
func (h *TelegramAuthHandler) serveStart(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseStartTelegramAuth(body)
	if err != nil {
		writeTelegramAuthServiceError(w, r, err)
		return
	}
	result, err := h.service.startAuth(r.Context(), identity.OrgID, identity.UserID, input, h.clientIP(r))
	if err != nil {
		writeTelegramAuthServiceError(w, r, err)
		return
	}
	payload, err := json.Marshal(result)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// @Post without @HttpCode => 201 Created.
	writeJSONBytes(w, http.StatusCreated, payload)
}

// serveComplete mirrors completeTelegramAuth: complete the login, write the
// credentials through updateSettings, hot-sync the Telegram schedule and return
// the same withExternalSnapshotStatus spread as the settings PUT.
func (h *TelegramAuthHandler) serveComplete(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseCompleteTelegramAuth(body)
	if err != nil {
		writeTelegramAuthServiceError(w, r, err)
		return
	}
	completed, err := h.service.completeAuth(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeTelegramAuthServiceError(w, r, err)
		return
	}

	// The controller calls updateSettings with
	//   {telegramApiId, telegramApiHash, telegramSession,
	//    telegramEnabled: body.enableTelegram}
	// and updateSettings' asBoolean(undefined|null, current) keeps the current
	// flag. NewTelegramAuthUpdate takes a bool, so pass the explicit value and
	// then restore the tri-state "missing" for an absent or null member; the
	// service merge (asBooleanInput) then keeps the stored value.
	enabled := false
	if input.EnableTelegram.state == presenceValue {
		enabled = input.EnableTelegram.value
	}
	update := NewTelegramAuthUpdate(completed.TelegramAPIID, completed.TelegramAPIHash, completed.TelegramSession, enabled)
	if input.EnableTelegram.state != presenceValue {
		update.TelegramEnabled = optionalBool{state: presenceMissing}
	}

	updated, err := h.settings.Update(r.Context(), identity.OrgID, identity.UserID, update)
	if err != nil {
		writeTelegramAuthServiceError(w, r, err)
		return
	}
	// syncTelegramScheduleBestEffort(updated.telegramEnabled,
	// updated.telegramPollIntervalMs): error only logged as a warning.
	h.syncTelegramSchedule(r.Context(), updated)
	// @Post without @HttpCode => 201 Created. WriteWithExtras writes 200 for the
	// settings routes it was extracted from, so only the success status is
	// upgraded here.
	WriteWithExtras(telegramAuthCreatedWriter{ResponseWriter: w}, r, identity.OrgID, updated, h.external, h.quality)
}

// syncTelegramSchedule mirrors Controller.syncTelegramScheduleBestEffort: a
// failure never fails the request.
func (h *TelegramAuthHandler) syncTelegramSchedule(ctx context.Context, settings PublicSettings) {
	if h.scheduler == nil {
		return
	}
	if err := h.scheduler.Sync(ctx, settings.TelegramEnabled, settings.TelegramPollIntervalMS); err != nil {
		log.Printf("situationsettings: failed to hot-sync telegram poll scheduler after telegram auth: %v", err)
	}
}

// clientIP mirrors resolveRequestIp through the shared TRUST_PROXY-aware helper
// (authlogin.ClientIP): without TRUST_PROXY the socket address wins and
// X-Forwarded-For is ignored; with a numeric TRUST_PROXY the n-th hop from the
// right is used (the same proxy-addr selection express applies to req.ip).
//
// Known accepted differences from NestJS resolveRequestIp (spec §10), relevant
// only to the ip rate-limit key:
//   - authlogin.ClientIP strips the IPv4-mapped "::ffff:" prefix; NestJS keeps
//     it, so a dual-stack socket could bucket into a different key string.
//   - TRUST_PROXY=0 means "trust no hop" in express but is read as hops=1 here,
//     and non-numeric values (loopback/true/CIDR lists) are treated as hops=1
//     instead of being interpreted as trust presets.
func (h *TelegramAuthHandler) clientIP(r *http.Request) string {
	if h == nil {
		return ""
	}
	ip := authlogin.ClientIP(r, h.trustProxy)
	if ip == nil {
		return ""
	}
	return *ip
}

// telegramAuthCreatedWriter upgrades the single 200 Created-status writer used
// by WriteWithExtras to 201; every error status written by WriteWithExtras
// passes through unchanged.
type telegramAuthCreatedWriter struct {
	http.ResponseWriter
}

func (w telegramAuthCreatedWriter) WriteHeader(statusCode int) {
	if statusCode == http.StatusOK {
		statusCode = http.StatusCreated
	}
	w.ResponseWriter.WriteHeader(statusCode)
}

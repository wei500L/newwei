package situationsettings

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

const (
	settingsPath       = "/api/system-settings/situation-monitor"
	telegramAuthPath   = settingsPath + "/telegram-auth"
	requiredPermission = "settings.manage"
	maxRequestBody     = 1 << 20
)

// ExternalSnapshotProvider is SituationMonitorExternalSnapshotService.getStatusSummary.
type ExternalSnapshotProvider interface {
	GetStatusSummary(ctx context.Context) (gdeltsnapshot.Summary, error)
}

// QualitySummaryProvider is SituationMonitorService.getQualitySummary. The
// concrete implementation reuses the 45 second insights core cache.
type QualitySummaryProvider interface {
	GetQualitySummary(ctx context.Context, orgID string) (*situationsignals.QualitySummary, error)
}

// TelegramScheduler is telegramsched.Scheduler.Sync.
type TelegramScheduler interface {
	Sync(ctx context.Context, enabled bool, intervalMS int) error
}

// EconomicScheduler is economicdata.Service.EnsureRepeatableJobs.
type EconomicScheduler interface {
	EnsureRepeatableJobs(ctx context.Context) error
}

// HandlerOptions collects the collaborators of the four routes.
type HandlerOptions struct {
	Auth     *platformgovernance.Authenticator
	Service  *Service
	External ExternalSnapshotProvider
	Quality  QualitySummaryProvider
	Telegram TelegramScheduler
	Economic EconomicScheduler
}

// Handler serves GET/PUT/DELETE /api/system-settings/situation-monitor and
// DELETE /api/system-settings/situation-monitor/telegram-auth.
type Handler struct {
	auth     *platformgovernance.Authenticator
	service  *Service
	external ExternalSnapshotProvider
	quality  QualitySummaryProvider
	telegram TelegramScheduler
	economic EconomicScheduler
}

// NewHandler wires the authenticator, settings service and response extras.
func NewHandler(options HandlerOptions) *Handler {
	return &Handler{
		auth:     options.Auth,
		service:  options.Service,
		external: options.External,
		quality:  options.Quality,
		telegram: options.Telegram,
		economic: options.Economic,
	}
}

// ServeHTTP dispatches one taken-over request. Methods and paths outside the
// four entries are a 404; the routing table never sends them here.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch {
	case r.URL.Path == settingsPath && r.Method == http.MethodGet:
		h.serveGet(w, r)
	case r.URL.Path == settingsPath && r.Method == http.MethodPut:
		h.servePut(w, r)
	case r.URL.Path == settingsPath && r.Method == http.MethodDelete:
		h.serveReset(w, r)
	case r.URL.Path == telegramAuthPath && r.Method == http.MethodDelete:
		h.serveClearTelegramAuth(w, r)
	default:
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
	}
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	return h.auth.Authorize(w, r, requiredPermission)
}

func (h *Handler) serveGet(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	settings, err := h.service.GetPublicSettings(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	h.writeWithExtras(w, r, identity.OrgID, settings)
}

func (h *Handler) servePut(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseUpdateSettings(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	settings, err := h.service.Update(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	h.syncSchedules(r.Context(), settings)
	h.writeWithExtras(w, r, identity.OrgID, settings)
}

func (h *Handler) serveReset(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	settings, err := h.service.Reset(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	h.syncSchedules(r.Context(), settings)
	if !settings.HasTelegramSession {
		h.service.ClearTelegramStateEverywhere(r.Context())
	}
	h.writeWithExtras(w, r, identity.OrgID, settings)
}

func (h *Handler) serveClearTelegramAuth(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	settings, err := h.service.ClearTelegramConfiguration(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// clearTelegramAuth only hot-syncs the Telegram schedule in the NestJS
	// controller; economic data is untouched.
	h.syncTelegramSchedule(r.Context(), settings)
	h.service.ClearTelegramStateEverywhere(r.Context())
	h.writeWithExtras(w, r, identity.OrgID, settings)
}

// syncSchedules mirrors syncTelegramScheduleBestEffort +
// syncEconomicDataScheduleBestEffort: both run on PUT and reset, even when the
// fields did not change, and any error is only a warning.
func (h *Handler) syncSchedules(ctx context.Context, settings PublicSettings) {
	h.syncTelegramSchedule(ctx, settings)
	h.syncEconomicSchedule(ctx)
}

func (h *Handler) syncTelegramSchedule(ctx context.Context, settings PublicSettings) {
	if h.telegram == nil {
		return
	}
	if err := h.telegram.Sync(ctx, settings.TelegramEnabled, settings.TelegramPollIntervalMS); err != nil {
		log.Printf("situationsettings: failed to hot-sync telegram poll scheduler: %v", err)
	}
}

func (h *Handler) syncEconomicSchedule(ctx context.Context) {
	if h.economic == nil {
		return
	}
	if err := h.economic.EnsureRepeatableJobs(ctx); err != nil {
		log.Printf("situationsettings: failed to hot-sync economic data repeatable jobs: %v", err)
	}
}

// writeWithExtras computes externalSnapshotStatus and qualitySummary in
// parallel (O2) and writes the controller's spread shape.
func (h *Handler) writeWithExtras(w http.ResponseWriter, r *http.Request, orgID string, settings PublicSettings) {
	type externalResult struct {
		value gdeltsnapshot.Summary
		err   error
	}
	type qualityResult struct {
		value *situationsignals.QualitySummary
		err   error
	}
	externalCh := make(chan externalResult, 1)
	qualityCh := make(chan qualityResult, 1)

	go func() {
		if h.external == nil {
			externalCh <- externalResult{err: errNoExternalSnapshotProvider}
			return
		}
		summary, err := h.external.GetStatusSummary(r.Context())
		externalCh <- externalResult{value: summary, err: err}
	}()
	go func() {
		if h.quality == nil {
			qualityCh <- qualityResult{}
			return
		}
		summary, err := h.quality.GetQualitySummary(r.Context(), orgID)
		qualityCh <- qualityResult{value: summary, err: err}
	}()

	external := <-externalCh
	quality := <-qualityCh
	if external.err != nil {
		writeServiceError(w, r, external.err)
		return
	}
	if quality.err != nil {
		log.Printf("situationsettings: failed to build situation monitor quality summary for settings response: %v", quality.err)
		quality.value = nil
	}

	externalJSON, err := json.Marshal(external.value)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	var qualityJSON json.RawMessage
	if quality.value != nil {
		qualityJSON, err = json.Marshal(quality.value)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
	}
	response := settingsResponse{
		PublicSettings:         settings,
		ExternalSnapshotStatus: externalJSON,
		QualitySummary:         qualityJSON,
	}
	payload, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONBytes(w, http.StatusOK, payload)
}

var errNoExternalSnapshotProvider = &httpError{status: http.StatusInternalServerError, message: "External snapshot status is not configured"}

// readBodyOrFail mirrors the NestJS body parser for the PUT: an absent body is
// an empty object (the DTO then reports the required field), malformed JSON is
// the body-parser 400.
func readBodyOrFail(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil {
		return []byte("{}"), true
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil {
		authhttp.WriteBadRequest(w, r, "Invalid request body")
		return nil, false
	}
	if int64(len(body)) > maxRequestBody {
		authhttp.WritePayloadTooLarge(w, r)
		return nil, false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return []byte("{}"), true
	}
	if !json.Valid(trimmed) {
		authhttp.WriteBadRequest(w, r, "Unexpected token in JSON body")
		return nil, false
	}
	return trimmed, true
}

// writeJSONBytes renders a body without HTML escaping, matching JSON.stringify.
func writeJSONBytes(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

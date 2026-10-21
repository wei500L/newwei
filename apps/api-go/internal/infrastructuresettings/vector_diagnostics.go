package infrastructuresettings

// This file adds the Go takeover of GET
// /api/system-settings/vector-service/diagnostics (ownership audit C-5). The
// NestJS route reports the vector client counters of the NestJS process that
// served the request; the Go route reports the same named model from the
// api-go process, using the process-wide vectorclient.Health shared by the
// search and upsert clients plus the same effective-settings read path as
// GET /api/system-settings/vector-service.
//
// Multi-instance semantics: every api-go instance reports its own process
// state. With several replicas the answer depends on the replica that served
// the request, exactly like the NestJS route reported the NestJS replica that
// served it. A load-balanced probe that needs every replica's state must query
// each instance directly (or move to the /api/metrics surface). During a mixed
// rollout only the vector calls executed by this api-go process are counted;
// traffic still handled by NestJS is not visible here (the NestJS route keeps
// reporting it).

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// pathVectorServiceDiagnostics is the exact route this handler serves. It is
// registered under its own API_GO_VECTOR_DIAGNOSTICS_MODE switch, independently
// of the seven configuration routes.
const pathVectorServiceDiagnostics = "/api/system-settings/vector-service/diagnostics"

// vectorServiceRuntimeDiagnostics is the exact NestJS
// VectorServiceRuntimeDiagnostics contract (apps/api/src/modules/vector/
// vector-client.service.ts). The field order is the NestJS object-literal order
// and therefore the JSON key order; do not reorder.
//
// Times are JavaScript Date.prototype.toISOString equivalents (UTC, millisecond
// precision, trailing Z). baseUrl, unavailableUntil, lastOperation,
// lastFailureAt, lastErrorName and lastErrorMessage are JSON null when unset,
// exactly like the `| null` members of the NestJS interface.
type vectorServiceRuntimeDiagnostics struct {
	SnapshotAt             string  `json:"snapshotAt"`
	Source                 string  `json:"source"`
	Enabled                bool    `json:"enabled"`
	Configured             bool    `json:"configured"`
	FallbackToMongo        bool    `json:"fallbackToMongo"`
	BaseURL                *string `json:"baseUrl"`
	TimeoutMs              int     `json:"timeoutMs"`
	MaxRetries             int     `json:"maxRetries"`
	HasToken               bool    `json:"hasToken"`
	TokenSource            string  `json:"tokenSource"`
	TemporarilyUnavailable bool    `json:"temporarilyUnavailable"`
	UnavailableUntil       *string `json:"unavailableUntil"`
	ConsecutiveFailures    int     `json:"consecutiveFailures"`
	LastOperation          *string `json:"lastOperation"`
	LastFailureAt          *string `json:"lastFailureAt"`
	LastErrorName          *string `json:"lastErrorName"`
	LastErrorMessage       *string `json:"lastErrorMessage"`
}

// encodeJSON renders the diagnostics payload.
func (d vectorServiceRuntimeDiagnostics) encodeJSON() ([]byte, error) { return json.Marshal(d) }

// VectorDiagnosticsHandler serves the single exact route. It performs the
// shared authentication (login + settings.manage, no platform-admin second
// gate, exactly like the NestJS @Permissions("settings.manage") decorator on
// getDiagnostics), reads the public settings and the effective configuration
// through the same Service, and renders the current process's vector client
// state.
type VectorDiagnosticsHandler struct {
	auth   *Authenticator
	svc    *Service
	health *vectorclient.Health
}

// NewVectorDiagnosticsHandler wires the shared authenticator, settings service
// and process-wide vector circuit state. A nil health is replaced by an empty
// zero-value state so an unwired handler still answers with the "no failure
// recorded" model instead of panicking.
func NewVectorDiagnosticsHandler(service *Service, auth *Authenticator, health *vectorclient.Health) *VectorDiagnosticsHandler {
	if health == nil {
		health = &vectorclient.Health{}
	}
	return &VectorDiagnosticsHandler{auth: auth, svc: service, health: health}
}

// ServeHTTP handles the exact GET route. Any other method or path is a 404; the
// routing table only ever sends the exact GET here, and the 404 runs before the
// authentication chain exactly like an Express route that does not match (the
// NestJS controller declares @Get only).
func (h *VectorDiagnosticsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if r.URL.Path != pathVectorServiceDiagnostics || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if h.auth.authorize(w, r) == nil {
		return
	}
	view, err := h.svc.readVectorDiagnosticsConfig(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	now := time.Now()
	writeResponse(w, r, http.StatusOK, buildVectorServiceRuntimeDiagnostics(view, h.health.Snapshot(now)))
}

// vectorDiagnosticsConfig is the read model the diagnostics route needs: the
// public model returned by GET /api/system-settings/vector-service plus the
// resolved effective configuration. It deliberately stays unexported; the route
// is the only consumer and the package keeps its internal structs private.
type vectorDiagnosticsConfig struct {
	public    vectorPublicSettings
	effective vectorEffectiveConfig
}

// readVectorDiagnosticsConfig reads the stored vector_service row once and resolves
// both the public model and the effective configuration from it, reusing
// getVectorPublicSettings' helpers instead of duplicating cache, normalization
// and token-decryption logic. The NestJS getDiagnostics issues getPublicSettings
// and getEffectiveConfig in parallel; reading the row once is equivalent for a
// global singleton setting and cannot report a torn snapshot.
func (s *Service) readVectorDiagnosticsConfig(ctx context.Context) (vectorDiagnosticsConfig, error) {
	if s == nil || s.db == nil {
		return vectorDiagnosticsConfig{}, errNoDatabase
	}
	stored, err := s.loadVectorSettings(ctx)
	if err != nil {
		return vectorDiagnosticsConfig{}, err
	}
	return vectorDiagnosticsConfig{
		public:    s.vectorPublic(stored),
		effective: s.resolveVectorEffective(stored),
	}, nil
}

// buildVectorServiceRuntimeDiagnostics renders the NestJS object literal. The
// ordered struct literal is what fixes the JSON key order.
func buildVectorServiceRuntimeDiagnostics(view vectorDiagnosticsConfig, snapshot vectorclient.HealthSnapshot) vectorServiceRuntimeDiagnostics {
	response := vectorServiceRuntimeDiagnostics{
		SnapshotAt:             nestTimestamp(snapshot.Now),
		Source:                 view.public.Source,
		Enabled:                view.public.Enabled,
		Configured:             view.public.BaseURL != nil && view.effective.Token != "",
		FallbackToMongo:        view.public.FallbackToMongo,
		BaseURL:                view.public.BaseURL,
		TimeoutMs:              view.public.TimeoutMs,
		MaxRetries:             view.public.MaxRetries,
		HasToken:               view.public.HasToken,
		TokenSource:            view.public.TokenSource,
		TemporarilyUnavailable: snapshot.TemporarilyUnavailable,
		ConsecutiveFailures:    snapshot.ConsecutiveFailures,
		LastOperation:          diagnosticsOptionalString(string(snapshot.LastOperation)),
		LastErrorName:          diagnosticsOptionalString(snapshot.LastErrorName),
		LastErrorMessage:       diagnosticsOptionalString(snapshot.LastErrorMessage),
	}
	if snapshot.TemporarilyUnavailable {
		response.UnavailableUntil = diagnosticsTimestamp(snapshot.UnavailableUntil)
	}
	if !snapshot.LastFailureAt.IsZero() {
		response.LastFailureAt = diagnosticsTimestamp(snapshot.LastFailureAt)
	}
	return response
}

// diagnosticsOptionalString maps the empty string to JSON null.
func diagnosticsOptionalString(value string) *string {
	if value == "" {
		return nil
	}
	text := value
	return &text
}

// diagnosticsTimestamp renders one instant in the NestJS toISOString shape.
func diagnosticsTimestamp(value time.Time) *string {
	text := nestTimestamp(value)
	return &text
}

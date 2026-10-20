package newssourcescheduler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// This file serves the four operations routes. Only the exact POST paths are
// owned; every other method and path returns NotFound so the gateway keeps
// proxying it to NestJS. The permission is crawl.write for all four, and the
// organization isolation is enforced by the service (404 "News source not
// found").

const (
	newsSourcePathPrefix = "/api/admin/news-sources/"
	permissionCrawlWrite = "crawl.write"
)

// machineAuthenticator is the existing machine-token path the news-sources CRUD
// already uses. The four POSTs accept machine tokens in NestJS (the global JWT
// guard validates mtk_ tokens), so the Go handler keeps that caller class.
type machineAuthenticator interface {
	AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error)
}

// Handler serves the four POST routes.
type Handler struct {
	auth    *authhttp.Authenticator
	svc     *Service
	machine machineAuthenticator
}

// NewHandler builds the handler.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// UseMachineAuthentication enables mtk_ bearer tokens on the four routes.
func (h *Handler) UseMachineAuthentication(authenticator machineAuthenticator) *Handler {
	h.machine = authenticator
	return h
}

// ServeHTTP dispatches the four routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	sourceID, action, ok := parseNewsSourceOpsPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	ctx := r.Context()
	switch action {
	case "dispatch":
		outcome, locked, err := h.svc.DispatchNow(ctx, identity.OrgID, sourceID, identity.UserID)
		if err != nil {
			writeStatusError(w, r, err)
			return
		}
		if !locked {
			authhttp.WriteHTTPException(w, r, http.StatusConflict, "News source is already being dispatched")
			return
		}
		writeJSON(w, http.StatusCreated, outcome)
	case "cancel-queued":
		outcome, err := h.svc.CancelQueued(ctx, identity.OrgID, sourceID, identity.UserID)
		if err != nil {
			writeStatusError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, outcome)
	case "clear-inflight":
		outcome, err := h.svc.ClearInFlight(ctx, identity.OrgID, sourceID)
		if err != nil {
			writeStatusError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, outcome)
	case "retry-latest":
		outcome, err := h.svc.RetryLatest(ctx, identity, sourceID, h.clientIP(r))
		if err != nil {
			writeStatusError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, outcome)
	default:
		http.NotFound(w, r)
	}
}

// parseNewsSourceOpsPath accepts exactly /api/admin/news-sources/:id/<action>.
func parseNewsSourceOpsPath(path string) (string, string, bool) {
	if !strings.HasPrefix(path, newsSourcePathPrefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, newsSourcePathPrefix)
	if rest == "" || strings.HasSuffix(rest, "/") {
		return "", "", false
	}
	segments := strings.Split(rest, "/")
	if len(segments) != 2 || segments[0] == "" {
		return "", "", false
	}
	switch segments[1] {
	case "dispatch", "cancel-queued", "clear-inflight", "retry-latest":
		return segments[0], segments[1], true
	default:
		return "", "", false
	}
}

// authorize runs the shared authentication chain and enforces crawl.write.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	var identity *authhttp.Identity
	if raw := rawBearer(r); strings.HasPrefix(raw, "mtk_") && h.machine != nil {
		resolved, err := h.machine.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			if status, message, ok := newssources.HTTPStatus(err); ok {
				authhttp.WriteHTTPException(w, r, status, message)
				return nil
			}
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = resolved
	} else {
		if h.auth == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(permissionCrawlWrite) {
		authhttp.WriteForbidden(w, r, []string{permissionCrawlWrite})
		return nil
	}
	return identity
}

// rawBearer extracts the Authorization bearer token.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("authorization")
	if header == "" {
		header = r.Header.Get("Authorization")
	}
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// clientIP mirrors resolveRequestIp through the shared TRUST_PROXY-aware helper.
func (h *Handler) clientIP(r *http.Request) *string {
	if h == nil {
		return nil
	}
	return authlogin.ClientIP(r, h.svc.trustProxy)
}

// writeJSON writes one JSON body with the NestJS content type.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

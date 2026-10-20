package economicdata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

type adminClient struct {
	baseURL string
	token   string
	client  *http.Client
}

func newAdminClient(env Env) *adminClient {
	base := strings.TrimRight(strings.TrimSpace(env.AkshareBaseURL), "/")
	return &adminClient{baseURL: base, token: strings.TrimSpace(env.AkshareAdminToken), client: &http.Client{Timeout: 20 * time.Second}}
}

// AdminHandler serves the three settings.manage AkShare gateway routes.
type AdminHandler struct {
	auth  *authhttp.Authenticator
	admin *adminClient
	svc   *Service
}

// NewAdminHandler wires the HTTP contract.
func NewAdminHandler(auth *authhttp.Authenticator, service *Service) *AdminHandler {
	return &AdminHandler{auth: auth, admin: service.admin, svc: service}
}

func (h *AdminHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	if !identity.HasPermission("settings.manage") {
		authhttp.WriteForbidden(w, r, []string{"settings.manage"})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/admin/akshare/version":
		h.serveVersion(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/api/admin/akshare/status":
		h.serveStatus(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/api/admin/akshare/upgrade":
		h.serveUpgrade(w, r, identity)
	default:
		http.NotFound(w, r)
	}
}

type akshareVersionResponse struct {
	AkshareVersion string `json:"akshareVersion"`
	PythonVersion  string `json:"pythonVersion"`
}

type upgradeStatusResponse struct {
	InProgress         bool    `json:"inProgress"`
	Stage              string  `json:"stage"`
	RequestID          *string `json:"requestId"`
	RequestedAt        *string `json:"requestedAt"`
	StartedAt          *string `json:"startedAt"`
	FinishedAt         *string `json:"finishedAt"`
	RestartScheduledAt *string `json:"restartScheduledAt"`
	BeforeVersion      *string `json:"beforeVersion"`
	AfterVersion       *string `json:"afterVersion"`
	Error              *string `json:"error"`
	PipStdout          *string `json:"pipStdout"`
	PipStderr          *string `json:"pipStderr"`
	PID                *int    `json:"pid,omitempty"`
	UpgradeEnabled     *bool   `json:"upgradeEnabled,omitempty"`
	DisabledReason     *string `json:"disabledReason,omitempty"`
}

type upgradeAccepted struct {
	Status        string `json:"status"`
	RequestID     string `json:"requestId"`
	BeforeVersion string `json:"beforeVersion"`
}

func disabledStatus(reason string) upgradeStatusResponse {
	enabled := false
	return upgradeStatusResponse{
		InProgress:     false,
		Stage:          "idle",
		UpgradeEnabled: &enabled,
		DisabledReason: &reason,
	}
}

func (h *AdminHandler) serveVersion(w http.ResponseWriter, r *http.Request) {
	status, body, err := h.admin.request(r.Context(), http.MethodGet, "/version", nil, 10*time.Second)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if status == http.StatusNotFound {
		writeJSON(w, http.StatusOK, akshareVersionResponse{AkshareVersion: "unknown", PythonVersion: "unknown"})
		return
	}
	if status < 200 || status >= 300 {
		writeUpstreamError(w, r, status, body)
		return
	}
	var version akshareVersionResponse
	if err := json.Unmarshal(body, &version); err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSON(w, http.StatusOK, version)
}

// version reads a successful /version payload. Non-2xx and transport failures
// are reported as not-ok; the upgrade path then keeps "unknown" as before.
func (h *AdminHandler) version(ctx context.Context) (akshareVersionResponse, bool) {
	status, body, err := h.admin.request(ctx, http.MethodGet, "/version", nil, 10*time.Second)
	if err != nil || status < 200 || status >= 300 {
		return akshareVersionResponse{}, false
	}
	var version akshareVersionResponse
	if err := json.Unmarshal(body, &version); err != nil {
		return akshareVersionResponse{}, false
	}
	return version, true
}

func (h *AdminHandler) serveStatus(w http.ResponseWriter, r *http.Request) {
	if h.admin.token == "" {
		writeJSON(w, http.StatusOK, disabledStatus("AKSHARE_ADMIN_TOKEN is not configured; akshare gateway upgrade status is disabled"))
		return
	}
	status, body, err := h.admin.request(r.Context(), http.MethodGet, "/admin/status", map[string]string{"x-akshare-admin-token": h.admin.token}, 10*time.Second)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if status == http.StatusNotFound {
		writeJSON(w, http.StatusOK, disabledStatus("Akshare gateway does not expose admin endpoints; rebuild the gateway image to enable upgrades"))
		return
	}
	if status < 200 || status >= 300 {
		writeUpstreamError(w, r, status, body)
		return
	}
	writeRawJSON(w, status, body)
}

func (h *AdminHandler) serveUpgrade(w http.ResponseWriter, r *http.Request, identity *authhttp.Identity) {
	if err := h.svc.EnforceAkshareUpgradeLimit(r.Context(), identity.OrgID); err != nil {
		if rateErr, ok := err.(*RateLimitError); ok {
			authhttp.WriteHTTPException(w, r, http.StatusTooManyRequests, rateErr.Message)
			return
		}
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if h.admin.token == "" {
		authhttp.WriteHTTPException(w, r, http.StatusServiceUnavailable, "AKSHARE_ADMIN_TOKEN is not configured; akshare gateway upgrade is disabled")
		return
	}
	beforeVersion := "unknown"
	if version, ok := h.version(r.Context()); ok && version.AkshareVersion != "" {
		beforeVersion = version.AkshareVersion
	}
	headers := map[string]string{"x-akshare-admin-token": h.admin.token, "content-type": "application/json"}
	status, body, err := h.admin.request(r.Context(), http.MethodPost, "/admin/upgrade", headers, 15*time.Second)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if status < 200 || status >= 300 {
		writeUpstreamError(w, r, status, body)
		return
	}
	var accepted upgradeAccepted
	if err := json.Unmarshal(body, &accepted); err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	accepted.BeforeVersion = beforeVersion
	log.Printf("economicdata: akshare upgrade requested requestId=%s before=%s", accepted.RequestID, beforeVersion)
	metadata := upgradeRequestedMetadata{
		RequestID:      accepted.RequestID,
		BeforeVersion:  beforeVersion,
		GatewayBaseURL: h.admin.baseURL,
	}
	h.svc.writeAuditLogBestEffort(r.Context(), identity.OrgID, identity.UserID, "akshare_gateway", "upgrade_requested", metadata, requestIP(r))
	go h.watchUpgrade(identity.OrgID, identity.UserID, accepted.RequestID, beforeVersion)
	writeJSON(w, http.StatusCreated, accepted)
}

func (h *AdminHandler) watchUpgrade(orgID, actorID, requestID, beforeVersion string) {
	startedAt := time.Now()
	deadline := startedAt.Add(15 * time.Minute)
	sawRequestID := false
	for time.Now().Before(deadline) {
		status, ok := h.upgradeStatus()
		if !ok || status.RequestID == nil || *status.RequestID != requestID {
			if sawRequestID {
				if version, versionOK := h.version(context.Background()); versionOK && version.AkshareVersion != "" && version.AkshareVersion != beforeVersion {
					afterVersion := version.AkshareVersion
					metadata := upgradeSucceededMetadata{
						RequestID:     requestID,
						BeforeVersion: beforeVersion,
						AfterVersion:  &afterVersion,
						DurationMs:    time.Since(startedAt).Milliseconds(),
						Note:          "Observed version change after gateway restart; upgrade status state was reset",
					}
					h.auditWithTimeout(orgID, actorID, "upgrade_succeeded", metadata)
					return
				}
			}
			time.Sleep(2 * time.Second)
			continue
		}
		sawRequestID = true
		switch status.Stage {
		case "failed":
			errorText := ""
			if status.Error != nil {
				errorText = *status.Error
			}
			metadata := upgradeFailedMetadata{
				RequestID:     requestID,
				BeforeVersion: beforeVersion,
				Error:         errorText,
				DurationMs:    time.Since(startedAt).Milliseconds(),
				PipStdout:     truncateLongText(status.PipStdout),
				PipStderr:     truncateLongText(status.PipStderr),
			}
			h.auditWithTimeout(orgID, actorID, "upgrade_failed", metadata)
			return
		case "restarting":
			afterVersion := ""
			if status.AfterVersion != nil {
				afterVersion = *status.AfterVersion
			}
			var afterVersionPointer *string
			if afterVersion != "" {
				afterVersionPointer = &afterVersion
			}
			metadata := upgradeSucceededMetadata{
				RequestID:     requestID,
				BeforeVersion: beforeVersion,
				AfterVersion:  afterVersionPointer,
				DurationMs:    time.Since(startedAt).Milliseconds(),
				PipStdout:     truncateLongText(status.PipStdout),
				PipStderr:     truncateLongText(status.PipStderr),
			}
			h.auditWithTimeout(orgID, actorID, "upgrade_succeeded", metadata)
			return
		}
		time.Sleep(2 * time.Second)
	}
	log.Printf("economicdata: timed out waiting for akshare upgrade completion requestId=%s", requestID)
}

func (h *AdminHandler) upgradeStatus() (upgradeStatusResponse, bool) {
	if h.admin.token == "" {
		return upgradeStatusResponse{}, false
	}
	status, body, err := h.admin.request(context.Background(), http.MethodGet, "/admin/status", map[string]string{"x-akshare-admin-token": h.admin.token}, 10*time.Second)
	if err != nil || status < 200 || status >= 300 {
		return upgradeStatusResponse{}, false
	}
	var decoded upgradeStatusResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return upgradeStatusResponse{}, false
	}
	return decoded, true
}

func (h *AdminHandler) auditWithTimeout(orgID, actorID, action string, metadata any) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h.svc.writeAuditLogBestEffort(ctx, orgID, actorID, "akshare_gateway", action, metadata, nil)
}

func (a *adminClient) request(ctx context.Context, method, path string, headers map[string]string, timeout time.Duration) (int, []byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var body io.Reader
	if method == http.MethodPost {
		body = bytes.NewReader([]byte("{}"))
	}
	request, err := http.NewRequestWithContext(requestCtx, method, a.baseURL+path, body)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("accept", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, raw, nil
}

func writeUpstreamError(w http.ResponseWriter, r *http.Request, status int, body []byte) {
	if json.Valid(body) && len(body) > 0 {
		writeRawJSON(w, status, body)
		return
	}
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = "Akshare gateway request failed"
	}
	authhttp.WriteHTTPException(w, r, status, message)
}

func writeRawJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	writeRawJSON(w, status, body)
}

func truncateLongText(value *string) string {
	if value == nil {
		return ""
	}
	runes := []rune(*value)
	if len(runes) <= 4000 {
		return *value
	}
	return string(runes[:4000]) + fmt.Sprintf("…(truncated, %d chars)", len(runes))
}

func requestIP(r *http.Request) *string {
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		value := strings.TrimSpace(strings.Split(forwarded, ",")[0])
		if value != "" {
			return &value
		}
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	host = strings.TrimPrefix(host, "::ffff:")
	if host == "" {
		return nil
	}
	return &host
}

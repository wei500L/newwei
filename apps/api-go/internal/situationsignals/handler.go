package situationsignals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// messagePrefix mirrors apps/api/src/main.ts json({limit:"10mb"}).
const maxJSONBodyBytes = 10 << 20

// bodyKind classifies the raw body the way Express body-parser does.
type bodyKind int

const (
	// bodyAbsent means the request carried no JSON body; body-parser turns that
	// into `{}` for a DTO-validated route.
	bodyAbsent bodyKind = iota
	// bodyOK means the body decoded as JSON.
	bodyOK
	// bodyInvalidJSON means the body was not valid JSON.
	bodyInvalidJSON
	// bodyTooLarge means the body exceeded the configured limit.
	bodyTooLarge
)

// Handler serves the seven situation monitor signal routes. The identity used by
// every route comes only from the authentication chain.
type Handler struct {
	auth    *Authenticator
	service *Service
}

// NewHandler wires the handler.
func NewHandler(auth *Authenticator, service *Service) *Handler {
	return &Handler{auth: auth, service: service}
}

// ServeHTTP dispatches the seven exact routes (plus the one-segment refresh-run
// lookup). The gateway only routes matching method/path pairs here, so the
// default branch is a safety net that keeps unrelated paths out.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == catalogPath && r.Method == http.MethodGet:
		h.serveCatalog(w, r)
	case r.URL.Path == feedbackPath && r.Method == http.MethodPost:
		h.serveFeedback(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, refreshRunsPrefix):
		refreshID, ok := oneSegment(r.URL.Path, refreshRunsPrefix)
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.serveRefreshRun(w, r, refreshID)
	case r.URL.Path == telegramFeedPath && r.Method == http.MethodGet:
		h.serveTelegramFeed(w, r)
	case r.URL.Path == orefAlertsPath && r.Method == http.MethodGet:
		h.serveOrefAlerts(w, r)
	case r.URL.Path == orefHistoryPath && r.Method == http.MethodGet:
		h.serveOrefHistory(w, r)
	case r.URL.Path == liveHLSProxyPath && r.Method == http.MethodGet:
		h.serveLiveHLSProxyConfig(w, r)
	default:
		http.NotFound(w, r)
	}
}

// oneSegment returns the single non-empty path segment after prefix.
func oneSegment(path, prefix string) (string, bool) {
	tail := strings.TrimPrefix(path, prefix)
	if tail == "" || strings.Contains(tail, "/") {
		return "", false
	}
	return tail, true
}

// serveCatalog implements GET /catalog.
func (h *Handler) serveCatalog(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.service.catalog(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveFeedback implements POST /feedback.
//
// The body is read before authorization because Express parses the body in
// middleware: a malformed body is answered with 400 even when the request is
// unauthenticated. Everything else follows the NestJS order — authentication
// (401), permission (403), DTO validation (400).
func (h *Handler) serveFeedback(w http.ResponseWriter, r *http.Request) {
	body, kind := readJSONBody(r)
	switch kind {
	case bodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return
	case bodyInvalidJSON:
		authhttp.WriteBadRequest(w, r, invalidJSONMessage(body))
		return
	case bodyAbsent:
		body = []byte("{}")
	}

	identity := h.auth.authorize(w, r, requiredWritePerm)
	if identity == nil {
		return
	}
	input, err := validateFeedbackBody(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if err := h.service.recordFeedback(r.Context(), identity.OrgID, identity.UserID, input); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, feedbackResponse{OK: true})
}

// serveRefreshRun implements GET /refresh-runs/:refreshId.
func (h *Handler) serveRefreshRun(w http.ResponseWriter, r *http.Request, refreshID string) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.service.getRefreshRun(r.Context(), identity.OrgID, refreshID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveTelegramFeed implements GET /telegram-feed.
//
// The route has no query DTO: unknown parameters are ignored and the two
// filters only apply when the value is a single string.
func (h *Handler) serveTelegramFeed(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	query := r.URL.Query()
	limit := monitorDefaultLimit
	if parsed, ok := parsePositiveIntQuery(query["limit"], 1, monitorLimit); ok {
		limit = parsed
	}
	topic, _ := singleQueryString(query["topic"])
	channel, _ := singleQueryString(query["channel"])
	payload, err := h.service.getTelegramFeed(r.Context(), identity.OrgID, identity.UserID, limit, topic, channel)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveOrefAlerts implements GET /oref-alerts.
func (h *Handler) serveOrefAlerts(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.service.getOrefAlerts(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveOrefHistory implements GET /oref-history.
func (h *Handler) serveOrefHistory(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.service.getOrefHistory(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveLiveHLSProxyConfig implements GET /live-hls-proxy-config.
func (h *Handler) serveLiveHLSProxyConfig(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	raw, ok := singleQueryString(r.URL.Query()["channel"])
	normalized := ""
	if ok {
		normalized = strings.ToLower(strings.TrimSpace(raw))
	}
	if normalized == "" || !isLiveHLSProxyChannel(normalized) {
		writeJSON(w, http.StatusOK, unconfiguredLiveHLSProxy(normalized))
		return
	}
	payload, err := h.service.liveHLSProxyConfig(r.Context(), normalized)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// isLiveHLSProxyChannel mirrors isSituationMonitorLiveHlsProxyChannel.
func isLiveHLSProxyChannel(value string) bool {
	for _, channel := range liveHLSProxyChannels {
		if channel == value {
			return true
		}
	}
	return false
}

// singleQueryString reports the value of a query parameter only when it carries
// exactly one string. A repeated parameter arrives as a slice (Express's default
// query parser produces an array too) and is ignored.
func singleQueryString(values []string) (string, bool) {
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

// parsePositiveIntQuery mirrors controller.parsePositiveInt for the string
// branch that query parameters take: trim, Number(), floor, then a bounds check
// that rejects out-of-range and non-finite values.
func parsePositiveIntQuery(values []string, min, max int) (int, bool) {
	raw, ok := singleQueryString(values)
	if !ok {
		return 0, false
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	parsed, ok := parseJSNumberString(trimmed)
	if !ok {
		return 0, false
	}
	// Compare in float space before narrowing: a value such as 1e300 would
	// overflow an int conversion, and the bounds check rejects it anyway.
	floored := jsFloor(parsed)
	if floored < float64(min) || floored > float64(max) {
		return 0, false
	}
	return int(floored), true
}

// readJSONBody reads a JSON body with the same classification body-parser uses.
func readJSONBody(r *http.Request) ([]byte, bodyKind) {
	if r.Body == nil || !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		// body-parser turns an empty body into {} rather than failing.
		return nil, bodyAbsent
	}
	if !json.Valid(trimmed) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

// isJSONContentType reports whether the header selects the JSON body parser.
func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return media == "application/json"
}

// invalidJSONMessage mirrors the body-parser SyntaxError message shape used by
// the sibling Go domains.
func invalidJSONMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if bytes.Equal(trimmed, []byte("{")) {
		return "Expected property name or '}' in JSON at position 1"
	}
	if len(body) == 0 {
		return "Unexpected end of JSON input"
	}
	token := body[0]
	snippet := body
	ellipsis := ""
	if len(snippet) > 10 {
		snippet = snippet[:10]
		ellipsis = "..."
	}
	return "Unexpected token '" + string(token) + "', \"" + string(snippet) + "\"" + ellipsis + " is not valid JSON"
}

// writeJSON writes a JSON response the way Express res.json does.
func writeJSON(w http.ResponseWriter, status int, payload encodedResponse) {
	encoded, err := payload.encodeJSON()
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// catalog implements GET /catalog.
func (s *Service) catalog(ctx context.Context, orgID string) (catalogResponse, error) {
	if s.db == nil {
		return catalogResponse{}, errNoDatabase
	}
	var activeSourceCount int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM NewsSource WHERE orgId = ? AND isActive = 1", orgID,
	).Scan(&activeSourceCount); err != nil {
		return catalogResponse{}, err
	}
	telegram, orefConfigured, err := s.settings.refreshReadiness(ctx)
	if err != nil {
		return catalogResponse{}, err
	}
	telegramRefreshable := telegram.Enabled && telegram.HasAPIID && telegram.HasHash && telegram.HasSess
	orefRefreshable := s.settings.orefEnabled() && orefConfigured

	narratives := make([]catalogNarrative, 0, len(narrativePatterns))
	for _, entry := range narrativePatterns {
		narratives = append(narratives, catalogNarrative{
			ID:       entry.id,
			Name:     formatIDTitle(entry.id),
			Category: entry.category,
			Severity: entry.severity,
		})
	}
	correlations := make([]catalogCorrelation, 0, len(correlationTopics))
	for _, entry := range correlationTopics {
		correlations = append(correlations, catalogCorrelation{
			ID:       entry.id,
			Name:     formatIDTitle(entry.id),
			Category: entry.category,
		})
	}
	return catalogResponse{
		Narratives:   narratives,
		Correlations: correlations,
		RefreshReadiness: catalogRefreshReadiness{
			ActiveSourceCount: activeSourceCount,
			BackendRefreshTargets: catalogBackendRefreshTargets{
				Crawl:    activeSourceCount > 0,
				Telegram: telegramRefreshable,
				Oref:     orefRefreshable,
				Any:      activeSourceCount > 0 || telegramRefreshable || orefRefreshable,
			},
		},
	}, nil
}

// liveHLSProxyConfig implements GET /live-hls-proxy-config.
func (s *Service) liveHLSProxyConfig(ctx context.Context, channel string) (liveHLSProxyConfig, error) {
	return s.settings.liveHLSProxyChannelConfig(ctx, channel)
}

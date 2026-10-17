package newsnowclusteringops

import (
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// itemsReadPermission guards the personalized ordering and opinion index
	// endpoints.
	itemsReadPermission = "items.read"
	// settingsManagePermission guards the clustering administration endpoints.
	settingsManagePermission = "settings.manage"

	// newsAggregatorMetadataPath is GET /api/news-aggregator/metadata.
	newsAggregatorMetadataPath = "/api/news-aggregator/metadata"
	// newsAggregatorResolvePath is GET /api/news-aggregator/resolve.
	newsAggregatorResolvePath = "/api/news-aggregator/resolve"
	// newsAggregatorSourcesOrderPath is POST /api/news-aggregator/sources/order.
	newsAggregatorSourcesOrderPath = "/api/news-aggregator/sources/order"
	// newsAggregatorOpinionIndexPath is GET
	// /api/news-aggregator/domestic-opinion-index.
	newsAggregatorOpinionIndexPath = "/api/news-aggregator/domestic-opinion-index"

	// clusteringBasePath is the prefix of the news-event clustering admin
	// endpoints.
	clusteringBasePath = "/api/system-settings/news-events/clustering"
	// clusteringReadinessPath is GET .../clustering/readiness.
	clusteringReadinessPath = clusteringBasePath + "/readiness"
	// clusteringOverviewPath is GET .../clustering/overview.
	clusteringOverviewPath = clusteringBasePath + "/overview"
	// clusteringFailuresPath is GET .../clustering/failures.
	clusteringFailuresPath = clusteringBasePath + "/failures"
	// clusteringFailureActionsPrefix is
	// .../clustering/failures/<groupId>/.
	clusteringFailureActionsPrefix = clusteringFailuresPath + "/"

	// vectorBackfillAction is the <groupId>/vector-backfill suffix.
	vectorBackfillAction = "vector-backfill"
	// ignoreAction is the <groupId>/ignore suffix.
	ignoreAction = "ignore"

	// invalidStoredSettingsCode is the NestJS ConflictException code.
	invalidStoredSettingsCode = "NEWSNOW_PERSONALIZATION_SETTINGS_INVALID"
	// invalidStoredSettingsMessage is the NestJS ConflictException message.
	invalidStoredSettingsMessage = "Stored NewsNow personalization settings are invalid."
	// invalidStoredSettingsDetail is the NestJS ConflictException detail.
	invalidStoredSettingsDetail = "Expected valid values for cacheTtlMs/maxCacheEntries/throttleWindowMs/maxRequestsPerWindowPerUser/affinitySourceWeight/behaviorSourceWeight/focusSourceBonus/staleTtlStrategy/staleTtlMultiplier/staleTtlFixedMs."
)

// Handler serves the nine migrated endpoints. It is registered on the gateway
// under legacyproxy.NewsnowClusteringOpsKey and is reached only when the mode
// switch is go; the route table guarantees that unmatched methods and paths
// never arrive here.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler builds the HTTP entry point. auth is used for human JWTs; machine
// tokens are validated through the service database handle.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the nine exact routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	path := r.URL.Path
	method := r.Method
	switch {
	case path == newsAggregatorMetadataPath && method == http.MethodGet:
		h.serveMetadata(w, r)
		return
	case path == newsAggregatorResolvePath && method == http.MethodGet:
		h.serveResolve(w, r)
		return
	case path == newsAggregatorSourcesOrderPath && method == http.MethodPost:
		h.serveSourcesOrder(w, r)
		return
	case path == newsAggregatorOpinionIndexPath && method == http.MethodGet:
		h.serveDomesticOpinionIndex(w, r)
		return
	case path == clusteringReadinessPath && method == http.MethodGet:
		h.serveClusteringReadiness(w, r)
		return
	case path == clusteringOverviewPath && method == http.MethodGet:
		h.serveClusteringOverview(w, r)
		return
	case path == clusteringFailuresPath && method == http.MethodGet:
		h.serveClusteringFailures(w, r)
		return
	}
	if method == http.MethodPost && strings.HasPrefix(path, clusteringFailureActionsPrefix) {
		rest := path[len(clusteringFailureActionsPrefix):]
		if groupID, action, ok := splitFailureAction(rest); ok {
			switch action {
			case vectorBackfillAction:
				h.serveVectorBackfill(w, r, groupID)
				return
			case ignoreAction:
				h.serveIgnoreFailure(w, r, groupID)
				return
			}
		}
	}
	http.NotFound(w, r)
}

// splitFailureAction parses "<groupId>/<action>" and URL-decodes the group id
// the way Express decodes @Param.
func splitFailureAction(rest string) (string, string, bool) {
	index := strings.LastIndex(rest, "/")
	if index <= 0 || index == len(rest)-1 {
		return "", "", false
	}
	decoded, err := url.PathUnescape(rest[:index])
	if err != nil {
		decoded = rest[:index]
	}
	if decoded == "" || strings.Contains(decoded, "/") {
		return "", "", false
	}
	return decoded, rest[index+1:], true
}

// serveMetadata answers GET /api/news-aggregator/metadata. The endpoint is
// public and its payload is fully deterministic.
func (h *Handler) serveMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.svc.metadata())
}

// serveResolve answers GET /api/news-aggregator/resolve. The endpoint is public.
func (h *Handler) serveResolve(w http.ResponseWriter, r *http.Request) {
	normalizedURL, err := validateHTTPURL(querySingle(r.URL.Query(), "url"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.resolve(r.Context(), normalizedURL)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// personalizedOrderRequest is the raw POST /api/news-aggregator/sources/order
// body. Absent members stay nil; present members keep their raw JSON so the
// "must be an array" and "must be an object" rules can be applied.
type personalizedOrderRequest struct {
	Column   *string         `json:"column"`
	Sources  json.RawMessage `json:"sources"`
	Settings json.RawMessage `json:"settings"`
}

// serveSourcesOrder answers POST /api/news-aggregator/sources/order.
func (h *Handler) serveSourcesOrder(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, itemsReadPermission)
	if identity == nil {
		return
	}
	var body personalizedOrderRequest
	if r.Body != nil {
		// A malformed or empty body is treated as an empty object, which then
		// fails the "column is required" rule exactly like the NestJS handler
		// receiving no JSON body.
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	columnKey, err := validateColumnKey(derefString(body.Column))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	sourceIDs, err := decodeSourceIDs(body.Sources)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	settingsOverride, err := decodeSettingsOverride(body.Settings)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	payload, err := h.svc.orderSources(r.Context(), identity.OrgID, identity.UserID, PersonalizationRequest{
		ColumnKey:        columnKey,
		SourceIDs:        sourceIDs,
		SettingsOverride: settingsOverride,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

// serveDomesticOpinionIndex answers GET /api/news-aggregator/domestic-opinion-index.
func (h *Handler) serveDomesticOpinionIndex(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, itemsReadPermission)
	if identity == nil {
		return
	}
	hours, err := parseOptionalPositiveInt(queryOption(r.URL.Query(), "hours"), "hours", 1, maxOpinionIndexHours)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	effective := defaultOpinionIndexHours
	if hours != nil {
		effective = *hours
	}
	response, err := h.svc.domesticOpinionIndex(r.Context(), identity.OrgID, effective)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// serveClusteringReadiness answers GET .../clustering/readiness.
func (h *Handler) serveClusteringReadiness(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, settingsManagePermission) == nil {
		return
	}
	response, err := h.svc.readiness(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// serveClusteringOverview answers GET .../clustering/overview.
func (h *Handler) serveClusteringOverview(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, settingsManagePermission)
	if identity == nil {
		return
	}
	response, err := h.svc.clusteringOverview(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// serveClusteringFailures answers GET .../clustering/failures.
func (h *Handler) serveClusteringFailures(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, settingsManagePermission)
	if identity == nil {
		return
	}
	status, err := decodeFailureStatus(queryOption(r.URL.Query(), "status"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// The NestJS controller ignores a non-numeric limit and the service clamps
	// the numeric value into 1..200.
	effective := clusteringFailureDefaultListLimit
	if requested := decodeFailureLimit(queryOption(r.URL.Query(), "limit")); requested != nil {
		effective = *requested
	}
	if effective < 1 {
		effective = 1
	}
	if effective > clusteringFailureMaxListLimit {
		effective = clusteringFailureMaxListLimit
	}
	response, err := h.svc.clusteringFailures(r.Context(), identity.OrgID, status, effective)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// serveVectorBackfill answers POST .../clustering/failures/:groupId/vector-backfill.
func (h *Handler) serveVectorBackfill(w http.ResponseWriter, r *http.Request, groupID string) {
	identity := h.authorize(w, r, settingsManagePermission)
	if identity == nil {
		return
	}
	response, err := h.svc.vectorBackfillClusteringFailure(r.Context(), identity.OrgID, identity.UserID, groupID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

// serveIgnoreFailure answers POST .../clustering/failures/:groupId/ignore.
func (h *Handler) serveIgnoreFailure(w http.ResponseWriter, r *http.Request, groupID string) {
	identity := h.authorize(w, r, settingsManagePermission)
	if identity == nil {
		return
	}
	response, err := h.svc.ignoreClusteringFailure(r.Context(), identity.OrgID, identity.UserID, groupID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

// authorize resolves the caller identity and asserts the required permission.
// Machine tokens (mtk_) bypass the JWT verifier, which rejects them by design,
// and are validated against the MachineAccessToken table instead.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
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
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// decodeSourceIDs applies the controller's normalizeSourceIds rules.
func decodeSourceIDs(raw json.RawMessage) ([]string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return []string{}, nil
	}
	if !strings.HasPrefix(trimmed, "[") {
		return nil, newHTTPError(400, "sources must be an array of source ids")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, newHTTPError(400, "sources must be an array of source ids")
	}
	out := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		var value string
		if err := json.Unmarshal(entry, &value); err != nil {
			continue
		}
		sourceID := strings.TrimSpace(value)
		if sourceID == "" || !isSourceID(sourceID) {
			continue
		}
		if _, ok := seen[sourceID]; ok {
			continue
		}
		seen[sourceID] = struct{}{}
		out = append(out, sourceID)
		if len(out) >= maxPersonalizedOrderSources {
			break
		}
	}
	return out, nil
}

// decodeSettingsOverride validates that the `settings` member is a JSON object
// and returns its raw bytes. An absent member yields nil; `null` is rejected
// exactly like the NestJS isRecord check.
func decodeSettingsOverride(raw json.RawMessage) ([]byte, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, nil
	}
	if !strings.HasPrefix(trimmed, "{") {
		return nil, newHTTPError(400, "settings must be an object")
	}
	// Unmarshalling into an empty struct succeeds only for a JSON object.
	var probe struct{}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, newHTTPError(400, "settings must be an object")
	}
	return []byte(trimmed), nil
}

// decodeFailureLimit mirrors the controller's `Number(limitRaw)` conversion: a
// falsy or non-finite value disables the option, and a non-integer value is
// truncated.
func decodeFailureLimit(raw *string) *int {
	if raw == nil || *raw == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*raw)
	value := 0.0
	if trimmed != "" {
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		value = parsed
	}
	truncated := int(math.Trunc(value))
	return &truncated
}

// decodeFailureStatus applies the controller's status whitelist. Any other
// value disables the filter.
func decodeFailureStatus(raw *string) (*ClusteringFailureStatus, error) {
	if raw == nil {
		return nil, nil
	}
	switch ClusteringFailureStatus(strings.TrimSpace(*raw)) {
	case ClusteringFailureStatusPending:
		status := ClusteringFailureStatusPending
		return &status, nil
	case ClusteringFailureStatusProcessing:
		status := ClusteringFailureStatusProcessing
		return &status, nil
	case ClusteringFailureStatusResolved:
		status := ClusteringFailureStatusResolved
		return &status, nil
	case ClusteringFailureStatusIgnored:
		status := ClusteringFailureStatusIgnored
		return &status, nil
	default:
		return nil, nil
	}
}

// conflictBody is the NestJS ConflictException payload shape.
type conflictBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code"`
	Detail     string `json:"detail"`
}

// writeServiceError maps a typed service failure onto the NestJS error shape.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if status, message, ok := httpStatusOf(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	if errors.Is(err, ErrRateLimited) {
		authhttp.WriteHTTPException(w, r, http.StatusTooManyRequests, ErrRateLimited.Error())
		return
	}
	if errors.Is(err, ErrInvalidStoredSettings) {
		encoded, marshalErr := json.Marshal(conflictBody{
			StatusCode: http.StatusConflict,
			Message:    invalidStoredSettingsMessage,
			Error:      "Conflict",
			Code:       invalidStoredSettingsCode,
			Detail:     invalidStoredSettingsDetail,
		})
		if marshalErr != nil {
			authhttp.WriteInternalFailure(w, r)
			return
		}
		w.Header().Set("content-type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write(encoded)
		return
	}
	log.Printf("newsnow clustering ops: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// jsonPayload is the sealed set of response bodies this handler writes. Using a
// type-parameter union keeps writeJSON strongly typed instead of falling back to
// an untyped parameter.
type jsonPayload interface {
	metadataResponse | ResolveResponse | PersonalizedOrderPayload | DomesticOpinionIndexResponse |
		ClusteringFailureOverview | []ClusteringFailureSummary | ClusteringFailureSummary |
		VectorBackfillResult | ReadinessResponse
}

// writeJSON writes a success payload the way Express res.json does.
func writeJSON[T jsonPayload](w http.ResponseWriter, status int, payload T) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("newsnow clustering ops: response encode failed: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// rawBearer extracts the bearer token without rejecting machine tokens.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// querySingle returns the first value of a query parameter.
func querySingle(values url.Values, key string) string {
	entries, ok := values[key]
	if !ok || len(entries) == 0 {
		return ""
	}
	return entries[0]
}

// queryOption returns a pointer to a present query parameter, or nil.
func queryOption(values url.Values, key string) *string {
	entries, ok := values[key]
	if !ok || len(entries) == 0 {
		return nil
	}
	value := entries[0]
	return &value
}

// derefString returns the empty string for a nil pointer.
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

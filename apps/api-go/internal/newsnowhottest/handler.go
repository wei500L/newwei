package newsnowhottest

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// HTTP entries. Both routes require items.read. The analysis route additionally
// auto-imports eligible signals when the caller holds items.write, because the
// NestJS controller passes `allowAutoBridge: user.permissions.includes("items.write")`.
const (
	// HottestAnalysisPath is GET /api/news-aggregator/hottest-analysis.
	HottestAnalysisPath = "/api/news-aggregator/hottest-analysis"
	// RecommendedPath is GET /api/news-aggregator/recommended.
	RecommendedPath = "/api/news-aggregator/recommended"
	// ItemsReadPermission guards both entries.
	ItemsReadPermission = "items.read"
	// ItemsWritePermission enables the analysis auto-bridge.
	ItemsWritePermission = "items.write"
)

var errInvalidMachineToken = errors.New("newsnowhottest: invalid machine token")

// Handler serves the two routes. It is registered on the gateway under
// legacyproxy.NewsnowHottestKey and is reached only when the mode switch is go.
type Handler struct {
	auth    *authhttp.Authenticator
	db      *sql.DB
	service *Service
}

// NewHandler builds the HTTP entry point.
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, service *Service) *Handler {
	return &Handler{auth: auth, db: db, service: service}
}

// ServeHTTP dispatches the two exact routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case HottestAnalysisPath:
		h.serveHottestAnalysis(w, r)
	case RecommendedPath:
		h.serveRecommended(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveHottestAnalysis answers GET /api/news-aggregator/hottest-analysis.
func (h *Handler) serveHottestAnalysis(w http.ResponseWriter, r *http.Request) {
	latestRaw, latestOK := singleQueryValue(r, "latest")
	if !latestOK {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, "latest must be a boolean string")
		return
	}
	latest, err := parseBooleanFlag(latestRaw)
	if err != nil {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, err.Error())
		return
	}
	identity := h.authorize(w, r, ItemsReadPermission)
	if identity == nil {
		return
	}
	response, err := h.service.GetHottestAnalysis(r.Context(), analysisInput{
		OrgID:           identity.OrgID,
		UserID:          identity.UserID,
		ForceRefresh:    latest,
		AllowAutoBridge: identity.HasPermission(ItemsWritePermission),
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// serveRecommended answers GET /api/news-aggregator/recommended.
func (h *Handler) serveRecommended(w http.ResponseWriter, r *http.Request) {
	latestRaw, latestOK := singleQueryValue(r, "latest")
	if !latestOK {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, "latest must be a boolean string")
		return
	}
	latest, err := parseBooleanFlag(latestRaw)
	if err != nil {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, err.Error())
		return
	}
	limitRaw, limitOK := singleQueryValue(r, "limit")
	if !limitOK {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, "limit must be an integer string")
		return
	}
	limit, err := parseOptionalPositiveInt(limitRaw, "limit", 1, 100)
	if err != nil {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, err.Error())
		return
	}
	identity := h.authorize(w, r, ItemsReadPermission)
	if identity == nil {
		return
	}
	response, err := h.service.GetRecommendedFeed(r.Context(), RecommendedInput{
		OrgID:        identity.OrgID,
		UserID:       identity.UserID,
		Limit:        limit,
		ForceRefresh: latest,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// authorize resolves the caller identity and asserts the required permission.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.authenticateMachine(r.Context(), raw)
		if err != nil {
			if errors.Is(err, errInvalidMachineToken) {
				authhttp.WriteUnauthorized(w, r, "Invalid machine token")
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
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// authenticateMachine mirrors MachineTokenService.validate: SHA-256 of the raw
// token looked up against MachineAccessToken.tokenHash joined to Org.isActive.
func (h *Handler) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if h.db == nil {
		return nil, errServiceNotConfigured
	}
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var rawPermissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := h.db.QueryRowContext(ctx, `
SELECT token.id, token.orgId, token.permissions, token.expiresAt, token.revokedAt, org.isActive
FROM MachineAccessToken token
JOIN Org org ON org.id = token.orgId
WHERE token.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &rawPermissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errInvalidMachineToken
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, errInvalidMachineToken
	}
	// lastUsedAt is best effort, exactly like the NestJS refresh.
	_, _ = h.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`,
		time.Now().UTC().Truncate(time.Millisecond), id)
	var permissions []string
	if len(rawPermissions) > 0 {
		if err := json.Unmarshal(rawPermissions, &permissions); err != nil {
			permissions = nil
		}
	}
	return authhttp.NewIdentity("machine:"+id, orgID, permissions), nil
}

// rawBearer extracts the raw Authorization token.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// singleQueryValue returns the first query value. A repeated parameter is an
// array in Express, which the NestJS typeof checks reject; false reports that.
func singleQueryValue(r *http.Request, key string) (string, bool) {
	values, exists := r.URL.Query()[key]
	if !exists || len(values) == 0 {
		return "", true
	}
	if len(values) > 1 {
		return "", false
	}
	return values[0], true
}

// parseBooleanFlag ports parseBooleanFlag. An empty value is false.
func parseBooleanFlag(value string) (bool, error) {
	if value == "" {
		return false, nil
	}
	normalized := toLowerCase(jsTrim(value))
	switch normalized {
	case "true", "1", "yes", "y", "on":
		return true, nil
	case "false", "0", "no", "n", "off":
		return false, nil
	}
	return false, errors.New("latest must be one of true/false, 1/0, yes/no, y/n, on/off")
}

// parseOptionalPositiveInt ports parseOptionalPositiveInt with the JavaScript
// Number.parseInt(value, 10) prefix semantics: a leading sign and leading digits
// are parsed, trailing text is ignored.
func parseOptionalPositiveInt(value, fieldName string, min, max int) (*int, error) {
	if value == "" {
		return nil, nil
	}
	parsed, ok := jsParseInt(value)
	if !ok || parsed < int64(min) || parsed > int64(max) {
		return nil, errors.New(fieldName + " must be an integer between " +
			strconv.Itoa(min) + " and " + strconv.Itoa(max))
	}
	result := int(parsed)
	return &result, nil
}

// jsParseInt mirrors Number.parseInt(value, 10) for the finite integer domain.
func jsParseInt(value string) (int64, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return 0, false
	}
	index := 0
	sign := int64(1)
	if trimmed[index] == '+' || trimmed[index] == '-' {
		if trimmed[index] == '-' {
			sign = -1
		}
		index++
	}
	start := index
	var result int64
	for index < len(trimmed) && trimmed[index] >= '0' && trimmed[index] <= '9' {
		digit := int64(trimmed[index] - '0')
		if result > (math.MaxInt64-digit)/10 {
			return 0, false
		}
		result = result*10 + digit
		index++
	}
	if index == start {
		return 0, false
	}
	return sign * result, true
}

// writeJSON writes the response with the same encoder rules as the cache
// documents: no HTML escaping, numbers in their shortest decimal form.
func writeJSON(w http.ResponseWriter, status int, body any) {
	encoded, err := marshalJSON(body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"statusCode":500,"message":"Internal server error"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// writeServiceError maps a service failure to the NestJS exception shape.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errServiceNotConfigured) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

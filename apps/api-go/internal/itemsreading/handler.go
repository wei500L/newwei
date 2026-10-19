package itemsreading

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// ReadPermission is the single permission every migrated entry requires.
const ReadPermission = "items.read"

// PathList is the exact GET /api/items route. PathItemPrefix is the prefix of
// the one-segment GET /api/items/:id route.
const (
	PathList       = "/api/items"
	PathItemPrefix = "/api/items/"
)

// Handler serves the two migrated REST routes. Authentication, permission
// derivation and the error envelopes mirror the NestJS controller contract; the
// organization always comes from the authenticated identity.
type Handler struct {
	auth *authhttp.Authenticator
	db   *sql.DB
	svc  *Service
}

// NewHandler wires the REST handler.
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, svc *Service) *Handler {
	return &Handler{auth: auth, db: db, svc: svc}
}

// ServeHTTP dispatches the two exact shapes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if r.URL.Path == PathList {
		h.serveList(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, PathItemPrefix) {
		identifier := strings.TrimPrefix(r.URL.Path, PathItemPrefix)
		if identifier == "" || strings.Contains(identifier, "/") {
			http.NotFound(w, r)
			return
		}
		h.serveDetail(w, r, identifier)
		return
	}
	http.NotFound(w, r)
}

// authorize resolves the caller identity and enforces items.read. The order is
// 401 -> 403, matching the NestJS guard chain (guards run before pipes).
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
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
	if !identity.HasPermission(ReadPermission) {
		authhttp.WriteForbidden(w, r, []string{ReadPermission})
		return nil
	}
	return identity
}

// authenticateMachine ports the shared MachineAccessToken lookup: SHA-256 hash
// of the token, Org.isActive, revocation and expiry checks, permission list
// from the token row only, and lastUsedAt bookkeeping.
func (h *Handler) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if h.db == nil {
		return nil, errors.New("mysql is not configured")
	}
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := h.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errInvalidMachineToken
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, errInvalidMachineToken
	}
	_, _ = h.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`,
		time.Now().UTC().Truncate(time.Millisecond), id)
	return authhttp.NewIdentity("machine:"+id, orgID, decodePermissionList(permissions)), nil
}

// errInvalidMachineToken marks a machine-token rejection.
var errInvalidMachineToken = errors.New("Invalid machine token")

// decodePermissionList parses the JSON string array stored on the token row.
func decodePermissionList(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var permissions []string
	if err := json.Unmarshal(raw, &permissions); err != nil {
		return nil
	}
	return permissions
}

// rawBearer extracts the bearer token.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
}

// serveList handles GET /api/items.
func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query, validationErrors := parseListQuery(r)
	if len(validationErrors) > 0 {
		writeValidationError(w, r, validationErrors)
		return
	}
	result, err := h.svc.List(r.Context(), identity.OrgID, query)
	if err != nil {
		h.writeServiceError(w, r, err, true)
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBytes(w, http.StatusOK, encoded)
}

// serveDetail handles GET /api/items/:id.
func (h *Handler) serveDetail(w http.ResponseWriter, r *http.Request, itemID string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	detail, err := h.svc.Detail(r.Context(), identity.OrgID, itemID)
	if err != nil {
		h.writeServiceError(w, r, err, false)
		return
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBytes(w, http.StatusOK, encoded)
}

// sortStrings orders the validation failure messages deterministically.
func sortStrings(values []string) {
	sort.Strings(values)
}

// parseListQuery validates the ListItemsDto contract: only page, pageSize,
// search and orderBy are accepted, each at most once, page/pageSize must be
// number strings, and orderBy must be one of the two whitelisted values.
func parseListQuery(r *http.Request) (ListQuery, []string) {
	query := ListQuery{}
	failures := make([]string, 0, 2)
	values := r.URL.Query()
	allowed := map[string]bool{"page": true, "pageSize": true, "search": true, "orderBy": true}
	for key, list := range values {
		if !allowed[key] {
			failures = append(failures, "property "+key+" should not exist")
			continue
		}
		if len(list) > 1 {
			failures = append(failures, key+" must be a number string")
			continue
		}
		value := list[0]
		switch key {
		case "page":
			if !isNumericString(value) {
				failures = append(failures, "page must be a number string")
				continue
			}
			query.Page = value
		case "pageSize":
			if !isNumericString(value) {
				failures = append(failures, "pageSize must be a number string")
				continue
			}
			query.PageSize = value
		case "search":
			query.Search = value
		case "orderBy":
			if value != string(ItemsOrderByCreatedDesc) && value != string(ItemsOrderByPublishedDesc) {
				failures = append(failures, "orderBy must be one of the following values: CREATED_DESC, PUBLISHED_DESC")
				continue
			}
			query.OrderBy = value
		}
	}
	if len(failures) > 0 {
		sortStrings(failures)
	}
	return query, failures
}

// writeServiceError maps service failures onto the REST contract.
func (h *Handler) writeServiceError(w http.ResponseWriter, r *http.Request, err error, list bool) {
	switch {
	case errors.Is(err, ErrItemNotFound):
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Item not found")
	case errors.Is(err, ErrPaginationOffsetTooLarge):
		// BadRequestException thrown from the service: the message is a plain
		// string, unlike a ValidationPipe failure whose message is an array.
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, ErrPaginationOffsetTooLarge.Error())
	case errors.Is(err, ErrInvalidQueryParameter):
		writeValidationError(w, r, []string{"Invalid query parameter"})
	default:
		var vectorError *ItemVectorUnavailableError
		if errors.As(err, &vectorError) {
			writeCodedServiceUnavailable(w, r, "VECTOR_SEARCH_UNAVAILABLE", vectorError.Message)
			return
		}
		_ = list
		// Server-side diagnostics only; the client keeps the generic 500 body.
		log.Printf("api-go: itemsreading REST failure: %v", err)
		authhttp.WriteInternalFailure(w, r)
	}
}

// writeValidationError writes the ValidationPipe envelope, whose message is an
// array of constraint failures.
func writeValidationError(w http.ResponseWriter, r *http.Request, messages []string) {
	body := validationErrorBody{
		StatusCode: http.StatusBadRequest,
		Message:    messages,
		Error:      "Bad Request",
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       r.URL.Path,
		Timestamp:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBytes(w, http.StatusBadRequest, encoded)
}

// validationErrorBody is the ValidationPipe failure envelope.
type validationErrorBody struct {
	StatusCode int      `json:"statusCode"`
	Message    []string `json:"message"`
	Error      string   `json:"error"`
	TraceID    string   `json:"traceId"`
	Path       string   `json:"path"`
	Timestamp  string   `json:"timestamp"`
}

// codedServiceUnavailableBody is the ServiceUnavailableException envelope with
// the vector-search code.
type codedServiceUnavailableBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// writeCodedServiceUnavailable writes the 503 vector envelope.
func writeCodedServiceUnavailable(w http.ResponseWriter, r *http.Request, code, message string) {
	body := codedServiceUnavailableBody{
		StatusCode: http.StatusServiceUnavailable,
		Message:    message,
		Error:      "Service Unavailable",
		Code:       code,
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       r.URL.Path,
		Timestamp:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBytes(w, http.StatusServiceUnavailable, encoded)
}

// writeJSONBytes writes an already encoded JSON response body byte-for-byte.
func writeJSONBytes(w http.ResponseWriter, status int, encoded []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// AuthenticateMachineToken exposes the machine-token lookup used by the items
// reading GET routes to the items ingest POST. It performs the same SHA-256
// hash, Org.isActive/revocation/expiry checks, lastUsedAt best-effort update
// and returns the DB-derived permissions and machine:<id> identity.
func AuthenticateMachineToken(ctx context.Context, db *sql.DB, token string) (*authhttp.Identity, error) {
	handler := &Handler{db: db}
	return handler.authenticateMachine(ctx, token)
}

// ErrInvalidMachineToken is the exported rejection sentinel.
var ErrInvalidMachineToken = errInvalidMachineToken

// ExtractBearerToken returns the raw bearer value with the shared syntax.
func ExtractBearerToken(r *http.Request) string { return rawBearer(r) }

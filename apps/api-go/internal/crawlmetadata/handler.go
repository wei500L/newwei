package crawlmetadata

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// MetadataPath is the exact POST path served by the Go takeover. The same path
// keeps falling back to NestJS for every other method (GET /api/crawl-tasks/
// metadata is matched by the existing GET /api/crawl-tasks/:id rule).
const MetadataPath = "/api/crawl-tasks/metadata"

const permissionCrawlRead = "crawl.read"

// maxRequestBodyBytes matches the Express json body limit (10mb).
const maxRequestBodyBytes = 10 << 20

// Handler serves POST /api/crawl-tasks/metadata under go takeover. The identity
// comes only from the authentication chain; no body or query parameter can
// select the tenant.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler builds a handler around the shared authenticator and service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the one migrated route.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != MetadataPath || r.Method != http.MethodPost {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	h.serveExtract(w, r)
}

func (h *Handler) serveExtract(w http.ResponseWriter, r *http.Request) {
	// Authorization runs before DTO validation and before any business work.
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	input, err := validateRequest(r.Context(), body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	results, err := h.svc.Extract(r.Context(), input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// Express' default 201 for a POST handler.
	writeJSON(w, r, http.StatusCreated, restResponse{
		OrgID:   identity.OrgID,
		Total:   len(results),
		Results: toRESTResults(results),
	})
}

// authorize runs the shared authentication chain and enforces crawl.read:
//   - missing Authorization / non-Bearer -> 401;
//   - mtk_ machine token -> AuthenticateMachine (SHA-256 tokenHash lookup);
//   - other token -> authhttp.Authenticate (JWT verify, Redis blacklist and
//     MySQL membership/permission re-derivation);
//   - permission missing -> 403.
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
		resolved, err := h.svc.authenticateMachine(r.Context(), raw)
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

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// readJSONBody mirrors Express json() for this route: a request that is not
// application/json (or has no body) reaches the DTO as an empty object, an
// empty body is an empty object, an over-limit body is 413 and a malformed body
// is 400. Reading stops at the same 10mb limit the Nest process uses.
func readJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil || !jsonContentType(r.Header.Get("Content-Type")) {
		return []byte("{}"), true
	}
	limited := http.MaxBytesReader(nil, r.Body, maxRequestBodyBytes)
	defer func() { _ = limited.Close() }()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			authhttp.WritePayloadTooLarge(w, r)
			return nil, false
		}
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, "Unexpected end of JSON input")
		return nil, false
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return []byte("{}"), true
	}
	if !json.Valid(data) {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, invalidJSONMessage)
		return nil, false
	}
	return data, true
}

// jsonContentType reports an application/json content type, ignoring
// parameters and surrounding whitespace.
func jsonContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
}

// restResponse is the controller return shape {orgId,total,results}: orgId
// comes only from the authenticated identity and total is the final
// results.length.
type restResponse struct {
	OrgID   string       `json:"orgId"`
	Total   int          `json:"total"`
	Results []restResult `json:"results"`
}

// restResult mirrors CrawlMetadataResult field order. Optional fields are
// omitted when the source would leave them undefined; the three list fields are
// always emitted, empty when nothing was collected.
type restResult struct {
	URL            string     `json:"url"`
	Status         string     `json:"status"`
	HTTPStatus     *int       `json:"httpStatus,omitempty"`
	FetchedAt      *jsISO8601 `json:"fetchedAt,omitempty"`
	Title          *string    `json:"title,omitempty"`
	Description    *string    `json:"description,omitempty"`
	Keywords       *[]string  `json:"keywords,omitempty"`
	Author         *string    `json:"author,omitempty"`
	MetaTags       []Tag      `json:"metaTags"`
	OpenGraph      []Tag      `json:"openGraph"`
	JSONLd         []string   `json:"jsonLd"`
	RelevanceScore *float64   `json:"relevanceScore,omitempty"`
	Error          *string    `json:"error,omitempty"`
}

// jsISO8601 serializes a timestamp like JavaScript's Date.toISOString().
type jsISO8601 struct {
	Value time.Time
}

func (t jsISO8601) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.Value.UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

func toRESTResults(results []Result) []restResult {
	out := make([]restResult, 0, len(results))
	for _, result := range results {
		item := restResult{
			URL:            result.URL,
			Status:         result.Status,
			HTTPStatus:     result.HTTPStatus,
			Title:          result.Title,
			Description:    result.Description,
			Keywords:       result.Keywords,
			Author:         result.Author,
			MetaTags:       ensureTags(result.MetaTags),
			OpenGraph:      ensureTags(result.OpenGraph),
			JSONLd:         ensureStrings(result.JSONLd),
			RelevanceScore: result.RelevanceScore,
			Error:          result.Error,
		}
		if result.FetchedAt != nil {
			item.FetchedAt = &jsISO8601{Value: *result.FetchedAt}
		}
		out = append(out, item)
	}
	return out
}

func ensureTags(tags []Tag) []Tag {
	if tags == nil {
		return []Tag{}
	}
	return tags
}

func ensureStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// writeJSON writes a JSON body without a trailing newline, matching Express
// res.json byte shape.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload any) {
	body, err := marshalJSCompact(payload)
	if err != nil {
		log.Printf("crawl metadata: failed to marshal response: %v", err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// statusError is a typed HTTP failure whose message is emitted verbatim, like
// an HttpException message.
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatusError(status int, message string) error {
	return &statusError{status: status, message: message}
}

// errDatabase marks a MySQL failure so the handler can answer 503, matching the
// NestJS Prisma connection error mapping.
var errDatabase = errors.New("crawl metadata: mysql failure")

// writeServiceError maps a service error onto the shared authhttp shapes.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	var input *InputError
	if errors.As(err, &input) {
		authhttp.WriteHTTPException(w, r, http.StatusBadRequest, input.Message)
		return
	}
	var typed *statusError
	if errors.As(err, &typed) {
		authhttp.WriteHTTPException(w, r, typed.status, typed.message)
		return
	}
	if errors.Is(err, errDatabase) {
		log.Printf("crawl metadata: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("crawl metadata: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

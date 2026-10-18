package analysisexport

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

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// maxExportBodyBytes is the NestJS body-parser JSON limit for the two routes.
const maxExportBodyBytes = 10 << 20

// AnalysisWritePermission is the single permission both export routes require.
// The source decorator adds no items.read / dashboards.read / settings.manage
// or platform-admin gate.
const AnalysisWritePermission = "analysis.write"

// Route names one of the two exports a handler serves. The routing layer binds
// one handler instance per exact path, so the handler never has to re-dispatch
// on the request path.
type Route string

const (
	// RouteItems is POST /api/analysis/exports/items.
	RouteItems Route = "items"
	// RouteEvents is POST /api/analysis/exports/events.
	RouteEvents Route = "events"
)

// itemsFilename and eventsFilename are the exact Content-Disposition names.
const (
	itemsFilename  = "analysis-items-export.csv"
	eventsFilename = "analysis-events-export.csv"
)

// Handler serves one of the two CSV exports. It authenticates with the
// machine-token capable accountsecurity chain (human JWT plus the shared Redis
// revocation list and MySQL membership re-derivation, and the mtk_ machine
// path), enforces analysis.write, validates the optional DTO and then runs the
// export.
type Handler struct {
	auth  *accountsecurity.Authenticator
	svc   *Service
	route Route
}

// NewHandler wires one export route.
func NewHandler(auth *accountsecurity.Authenticator, svc *Service, route Route) *Handler {
	return &Handler{auth: auth, svc: svc, route: route}
}

// ServeHTTP implements http.Handler. CORS preflight and the OPTIONS fallback
// are handled by the registration wrapper before this method runs.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, AnalysisWritePermission)
	if identity == nil {
		return
	}

	// The DTO is validated before any read so a 400 never touches the export
	// pipeline.
	raw, err := readExportBody(r)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	body, err := analysiscollab.ValidateBody(raw, analysiscollab.ExportQuerySpecs())
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	queryString := ""
	if body.Has("queryString") && !body.Null("queryString") {
		queryString = body.String("queryString")
	}

	switch h.route {
	case RouteItems:
		h.writeExport(w, r, itemsFilename, func(out io.Writer) error {
			return h.svc.ExportItemsCSV(r.Context(), identity.OrgID, identity.UserID, queryString, out)
		})
	case RouteEvents:
		h.writeExport(w, r, eventsFilename, func(out io.Writer) error {
			return h.svc.ExportEventsCSV(r.Context(), identity.OrgID, queryString, out)
		})
	default:
		authhttp.WriteInternalFailure(w, r)
	}
}

// writeExport runs one export into a response that commits the 201 status and
// the CSV headers on the first byte. The export service performs every query
// before its first write, so a rerank/vector/database failure still becomes the
// error projection and never a 201 with a partial CSV.
func (h *Handler) writeExport(w http.ResponseWriter, r *http.Request, filename string, export func(io.Writer) error) {
	response := &csvResponse{w: w, filename: filename}
	if err := export(response); err != nil {
		if response.started {
			// The status line is already committed; only diagnostics remain.
			log.Printf("api-go: analysis export failed after the CSV headers: %v", err)
			return
		}
		writeExportError(w, r, err)
	}
}

// csvResponse lazily writes the CSV headers on the first byte of the body.
type csvResponse struct {
	w        http.ResponseWriter
	filename string
	started  bool
}

// Write implements io.Writer.
func (c *csvResponse) Write(p []byte) (int, error) {
	if !c.started {
		c.w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		c.w.Header().Set("Content-Disposition", `attachment; filename="`+c.filename+`"`)
		c.w.WriteHeader(http.StatusCreated)
		c.started = true
	}
	return c.w.Write(p)
}

// WriteString avoids the byte-slice conversion of the CSV row writer.
func (c *csvResponse) WriteString(s string) (int, error) {
	if !c.started {
		c.w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		c.w.Header().Set("Content-Disposition", `attachment; filename="`+c.filename+`"`)
		c.w.WriteHeader(http.StatusCreated)
		c.started = true
	}
	return io.WriteString(c.w, s)
}

// readExportBody mirrors the body-parser JSON stage of the export routes.
//
// A non-JSON content type is skipped by body-parser, and a zero-length JSON
// body is parsed as {} (body-parser's special case), so both reach the DTO as
// "no body" and mean a no-filter export. A larger-than-limit or unreadable
// stream is reported so the handler can answer the generic failure.
func readExportBody(r *http.Request) ([]byte, error) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, nil
	}
	limited := http.MaxBytesReader(nil, r.Body, maxExportBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	return data, nil
}

// isJSONContentType matches the body-parser application/json test.
func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return mediaType == "application/json"
}

// codedServiceUnavailableBody is the ServiceUnavailableException envelope of
// the two typed upstream failures, in the GlobalExceptionFilter field order
// (statusCode, message, error, code, detail?, traceId, path, timestamp).
type codedServiceUnavailableBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code"`
	Detail     string `json:"detail,omitempty"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// writeExportError maps an export failure. The two typed external-boundary
// failures keep their NestJS status/code/detail; every other error is the
// generic 500 the items reading REST handler uses, with the driver text only in
// the server log.
func writeExportError(w http.ResponseWriter, r *http.Request, err error) {
	var rerank *itemsreading.RerankUnavailableError
	if errors.As(err, &rerank) {
		writeCodedServiceUnavailable(w, r, "RERANK_UNAVAILABLE", rerank.Error(), rerank.Detail)
		return
	}
	var vector *itemsreading.ItemVectorUnavailableError
	if errors.As(err, &vector) {
		message := vector.Message
		if message == "" {
			message = "Vector search unavailable"
		}
		writeCodedServiceUnavailable(w, r, "VECTOR_SEARCH_UNAVAILABLE", message, "")
		return
	}
	log.Printf("api-go: analysis export failure: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// writeCodedServiceUnavailable writes the 503 envelope. A blank detail is
// omitted so the JSON shape matches the source exception without a detail key.
func writeCodedServiceUnavailable(w http.ResponseWriter, r *http.Request, code, message, detail string) {
	body := codedServiceUnavailableBody{
		StatusCode: http.StatusServiceUnavailable,
		Message:    message,
		Error:      "Service Unavailable",
		Code:       code,
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       r.URL.Path,
		Timestamp:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if strings.TrimSpace(detail) != "" {
		body.Detail = detail
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write(encoded)
}

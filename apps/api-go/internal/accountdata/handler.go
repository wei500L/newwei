package accountdata

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// The two exact paths this unit owns. They are declared here (not imported
// from legacyproxy) so the handler has no dependency on the routing layer.
const (
	avatarPresignPath = "/api/auth/avatar/presigned-url"
	dataExportPath    = "/api/auth/data-export"
)

// Handler serves the two taken-over account-data routes. It performs the
// authentication, body decoding and DTO-shape validation; all persistence and
// signing lives in Service. The evaluation order matches NestJS: authentication
// (401) -> DTO shape (400) -> service rules.
type Handler struct {
	auth *accountsecurity.Authenticator
	svc  *Service
}

// NewHandler wires the accountsecurity authenticator and the data service.
func NewHandler(auth *accountsecurity.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one taken-over request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case avatarPresignPath:
		h.serveAvatarPresign(w, r)
	case dataExportPath:
		h.serveDataExport(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveAvatarPresign handles POST /api/auth/avatar/presigned-url.
func (h *Handler) serveAvatarPresign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "")
	if identity == nil {
		return
	}
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	contentType, contentLength, err := parseAvatarPresignRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.CreateAvatarUploadURL(r.Context(), identity.OrgID, identity.UserID, contentType, contentLength)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusCreated, response)
}

// serveDataExport handles GET /api/auth/data-export.
func (h *Handler) serveDataExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "")
	if identity == nil {
		return
	}
	h.svc.ServeDataExport(w, r, identity)
}

// writeJSON writes one JSON response with the Express content type. HTML
// characters are not escaped (Express res.json uses JSON.stringify), which
// matters for the presigned URL because its query string is joined by '&'.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, body any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// readBody reads a bounded body. Nest's JSON body parser answers 413 for an
// over-limit payload; the same shape is used here.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			authhttp.WritePayloadTooLarge(w, r)
			return nil, false
		}
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	}
	return body, true
}

// errInvalidBody mirrors the ValidationPipe answer for a body that is not a
// JSON object at all.
var errInvalidBody = &httpError{
	status:  http.StatusBadRequest,
	message: "an unknown value was passed to the validate function",
}

// avatarPresignRequest mirrors AvatarPresignRequestDto's declared members.
type avatarPresignRequest struct {
	ContentType   json.RawMessage
	ContentLength json.RawMessage
}

func (r *avatarPresignRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "contentType":
		r.ContentType = value
	case "contentLength":
		r.ContentLength = value
	default:
		return false
	}
	return true
}

// avatarContentTypeValues is the @IsIn allow-list of AvatarPresignRequestDto, in
// the decorator's own order.
var avatarContentTypeValues = []string{"image/jpeg", "image/png", "image/webp"}

// isAllowedAvatarContentType reports whether contentType is in that allow-list.
func isAllowedAvatarContentType(value string) bool {
	for _, allowed := range avatarContentTypeValues {
		if value == allowed {
			return true
		}
	}
	return false
}

// parseAvatarPresignRequest reproduces every decorator of
// AvatarPresignRequestDto, because the global ValidationPipe runs before the
// controller body: the object form, the whitelist, @IsString/@IsIn on
// contentType and @IsInt/@Min(1)/@Max(2MB) on contentLength. The accept-list and
// the range therefore answer the class-validator messages, not the
// StorageService ones (those are unreachable over HTTP for the same reason they
// are unreachable in NestJS; the service keeps them as a second line of
// defence).
//
// A property with several decorators reports them bottom-up, which is why
// contentType reports @IsIn before @IsString and contentLength reports @Max,
// @Min, @IsInt in that order.
func parseAvatarPresignRequest(body []byte) (string, float64, error) {
	request := avatarPresignRequest{}
	unknown, err := decodeObject(body, &request)
	if err != nil {
		return "", 0, err
	}
	problems := make([]string, 0, 5+len(unknown))
	for _, name := range unknown {
		problems = append(problems, "property "+name+" should not exist")
	}
	contentType, typeIsString := jsonString(request.ContentType)
	if !typeIsString || !isAllowedAvatarContentType(contentType) {
		problems = append(problems, "contentType must be one of the following values: "+
			strings.Join(avatarContentTypeValues, ", "))
	}
	if !typeIsString {
		problems = append(problems, "contentType must be a string")
	}
	contentLength, lengthIsNumber := jsonNumber(request.ContentLength)
	// NaN is unreachable from JSON, but @IsInt/@Min/@Max all treat it as a
	// number that fails, so it is handled explicitly instead of by comparison
	// (every comparison with NaN is false). An out-of-range literal stays
	// Infinity, exactly like JSON.parse.
	lengthIsNaN := lengthIsNumber && math.IsNaN(contentLength)
	lengthIsInfinite := lengthIsNumber && math.IsInf(contentLength, 0)
	if !lengthIsNumber || lengthIsNaN || contentLength > MaxAvatarBytes {
		problems = append(problems, "contentLength must not be greater than "+strconv.Itoa(MaxAvatarBytes))
	}
	if !lengthIsNumber || lengthIsNaN || contentLength < 1 {
		problems = append(problems, "contentLength must not be less than 1")
	}
	if !lengthIsNumber || lengthIsNaN || lengthIsInfinite || math.Trunc(contentLength) != contentLength {
		problems = append(problems, "contentLength must be an integer number")
	}
	if len(problems) > 0 {
		return "", 0, badRequest(strings.Join(problems, "; "))
	}
	return contentType, contentLength, nil
}

// decodeObject streams a JSON object and feeds each member to target. A JSON
// null body is an empty object, exactly like ValidationPipe.toEmptyIfNil.
func decodeObject(body []byte, target interface {
	setField(string, json.RawMessage) bool
}) ([]string, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, errInvalidBody
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return nil, errInvalidBody
	}
	var unknown []string
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errInvalidBody
		}
		name, ok := keyToken.(string)
		if !ok {
			return nil, errInvalidBody
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, errInvalidBody
		}
		if !target.setField(name, raw) {
			unknown = append(unknown, name)
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errInvalidBody
	}
	if decoder.More() {
		return nil, errInvalidBody
	}
	return unknown, nil
}

// jsonString decodes one raw token as a string; numbers are never coerced.
func jsonString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsonNumber parses one raw number token. An out-of-range literal becomes the
// infinite value JSON.parse produces, so the service can answer
// "Invalid avatar size" instead of a decode error.
func jsonNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return 0, false
	}
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		var numError *strconv.NumError
		if errors.As(err, &numError) && errors.Is(numError.Err, strconv.ErrRange) && math.IsInf(value, 0) {
			return value, true
		}
		return 0, false
	}
	return value, true
}

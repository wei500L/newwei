package itemsingest

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// Path is the exact REST create route. The Go handler never accepts a longer
// path or another method.
const Path = "/api/items"

// Handler serves POST /api/items.
type Handler struct {
	auth *authhttp.Authenticator
	db   *sql.DB
	svc  *Service
}

// NewHandler wires the REST handler.
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, svc *Service) *Handler {
	return &Handler{auth: auth, db: db, svc: svc}
}

// ServeHTTP dispatches the exact POST shape.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if r.URL.Path != Path || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	h.serveCreate(w, r)
}

// authorize ports JwtAuthGuard + PermissionsGuard("items.write"). The order is
// 401 before 403; a valid machine token without items.write is 403.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	raw := itemsreading.ExtractBearerToken(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if isMachineToken(raw) {
		resolved, err := itemsreading.AuthenticateMachineToken(r.Context(), h.db, raw)
		if err != nil {
			if errors.Is(err, itemsreading.ErrInvalidMachineToken) {
				authhttp.WriteUnauthorized(w, r, "Invalid machine token")
				return nil
			}
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = resolved
		// Publish the machine token's organization so a later failure in this request
		// (a missing permission, a validation error, a write error) is attributed to
		// it. The identity comes from the token row, never from the request.
		authhttp.SetVerifiedIdentity(r, identity)
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
	if !identity.HasPermission(WritePermission) {
		authhttp.WriteForbidden(w, r, []string{WritePermission})
		return nil
	}
	return identity
}

func isMachineToken(raw string) bool {
	return len(raw) >= 4 && raw[:4] == "mtk_"
}

func (h *Handler) serveCreate(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	input, messages, err := parseCreateBody(r)
	if err != nil {
		if errors.Is(err, errCreateBodyTooLarge) {
			writeCreateBodyTooLarge(w, r)
			return
		}
		writeValidationFailure(w, r, []string{err.Error()})
		return
	}
	if len(messages) > 0 {
		writeValidationFailure(w, r, messages)
		return
	}
	result, err := h.svc.Create(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeServiceFailure(w, r, err)
		return
	}
	response := createItemResponse{
		ID:          result.Meta.ID,
		OrgID:       result.Meta.OrgID,
		ExternalID:  result.Meta.ExternalID,
		Name:        result.Meta.Name,
		Status:      result.Meta.Status,
		MongoRef:    result.Meta.MongoRef,
		Version:     result.Meta.Version,
		PublishedAt: result.Meta.PublishedAt,
		SortAt:      result.Meta.SortAt,
		CreatedAt:   result.Meta.CreatedAt,
		UpdatedAt:   result.Meta.UpdatedAt,
		RawItemID:   result.RawItemID,
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(encoded)
}

// createItemResponse is the Prisma ItemMeta create result plus rawItemId. It is
// not the GraphQL ItemModel.
type createItemResponse struct {
	ID          string                `json:"id"`
	OrgID       string                `json:"orgId"`
	ExternalID  string                `json:"externalId"`
	Name        string                `json:"name"`
	Status      string                `json:"status"`
	MongoRef    string                `json:"mongoRef"`
	Version     int                   `json:"version"`
	PublishedAt *itemsreading.ISOTime `json:"publishedAt"`
	SortAt      itemsreading.ISOTime  `json:"sortAt"`
	CreatedAt   itemsreading.ISOTime  `json:"createdAt"`
	UpdatedAt   itemsreading.ISOTime  `json:"updatedAt"`
	RawItemID   string                `json:"rawItemId"`
}

// parseCreateBody validates CreateItemDto. It returns validation messages in
// property source order and the raw payload object for schema normalization.
//
// # Body size contract
//
// POST /api/items is served by the same NestJS process middleware as every other
// route: apps/api/src/main.ts:107-117 installs express.json({limit: "10mb"})
// before the router, so the parser accepts up to 10 * 1024 * 1024 bytes and the
// ItemsController.create body arrives fully parsed. This handler previously
// rejected anything above 1 MiB with 400 "Invalid JSON body", which refused
// legitimate create requests the NestJS route accepts.
//
// The two limits now match NestJS:
//
//   - a body of at most createBodyLimit bytes is parsed and validated normally;
//   - a larger body is answered with the shape NestJS produces for a body-parser
//     overflow (see writeCreateBodyTooLarge), never with "Invalid JSON body".
//
// A malformed body below the limit keeps its own 400, and a well-formed body with
// invalid fields keeps the ValidationPipe message list. The three outcomes are
// distinct because NestJS distinguishes them too.
func parseCreateBody(r *http.Request) (CreateItemInput, []string, error) {
	// The whole body is read before decoding, like body-parser's raw-body read:
	// the limit applies to the bytes received, so a body one byte over the ceiling
	// is refused even when the trailing bytes would not have changed the parsed
	// document.
	limited := http.MaxBytesReader(nil, r.Body, createBodyLimit)
	defer limited.Close()
	raw, err := io.ReadAll(limited)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return CreateItemInput{}, nil, errCreateBodyTooLarge
		}
		return CreateItemInput{}, nil, errInvalidJSONBody
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return CreateItemInput{}, nil, errInvalidJSONBody
	}
	if body == nil {
		return CreateItemInput{}, nil, errInvalidJSONBody
	}
	input := CreateItemInput{}
	messages := make([]string, 0, 4)
	externalID, exists := body["externalId"]
	if !exists {
		messages = append(messages, maxLengthMessage("externalId", 128), "externalId must be a string")
	} else if text, ok := decodeString(externalID); ok {
		input.ExternalID = text
		if len(text) > 128 {
			messages = append(messages, maxLengthMessage("externalId", 128))
		}
	} else {
		messages = append(messages, maxLengthMessage("externalId", 128), "externalId must be a string")
	}
	name, exists := body["name"]
	if !exists {
		messages = append(messages, maxLengthMessage("name", 255), "name must be a string")
	} else if text, ok := decodeString(name); ok {
		input.Name = text
		if len(text) > 255 {
			messages = append(messages, maxLengthMessage("name", 255))
		}
	} else {
		messages = append(messages, maxLengthMessage("name", 255), "name must be a string")
	}
	if rawPayload, exists := body["payload"]; exists {
		if kindOfRaw(rawPayload) == "object" {
			input.Payload = append([]byte(nil), bytes.TrimSpace(rawPayload)...)
		} else {
			messages = append(messages, "payload must be an object")
		}
	} else {
		messages = append(messages, "payload must be an object")
	}
	if rawStatus, exists := body["status"]; exists && kindOfRaw(rawStatus) != "null" {
		if text, ok := decodeString(rawStatus); ok {
			input.Status = &text
		} else {
			messages = append(messages, "status must be a string")
		}
	}
	unknown := make([]string, 0)
	for key := range body {
		switch key {
		case "externalId", "name", "payload", "status":
		default:
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	for _, key := range unknown {
		messages = append(messages, "property "+key+" should not exist")
	}
	return input, messages, nil
}

func decodeString(raw json.RawMessage) (string, bool) {
	if kindOfRaw(raw) != "string" {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func kindOfRaw(raw json.RawMessage) string {
	_, kind := jsonValueKind(raw)
	return kind
}

func maxLengthMessage(name string, max int) string {
	return name + " must be shorter than or equal to " + itoa(max) + " characters"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// writeValidationFailure writes the ValidationPipe message list and reports it.
//
// GlobalExceptionFilter joins a class-validator message array with "; " into one
// string before recording and serializing, but this route answers the array itself
// (writeError cannot express it). The event therefore carries the joined message so
// the stored text still matches what NestJS stores for the same rejection.
func writeValidationFailure(w http.ResponseWriter, r *http.Request, messages []string) {
	body := struct {
		StatusCode int      `json:"statusCode"`
		Message    []string `json:"message"`
		Error      string   `json:"error"`
		TraceID    string   `json:"traceId"`
		Path       string   `json:"path"`
		Timestamp  string   `json:"timestamp"`
	}{
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
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = w.Write(encoded)
	authhttp.RecordFailure(r, http.StatusBadRequest, strings.Join(messages, "; "))
}

func writeServiceFailure(w http.ResponseWriter, r *http.Request, err error) {
	if failure := AsFailure(err); failure != nil {
		authhttp.WriteHTTPException(w, r, failure.Status, failure.Message)
		return
	}
	log.Printf("api-go: items ingest REST failure: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// createBodyLimit is express.json({limit: "10mb"}) from apps/api/src/main.ts:111
// expressed in bytes. body-parser parses the string with the `bytes` package,
// where the "mb" suffix is 1024 * 1024, so the accepted ceiling is exactly
// 10 * 1024 * 1024 bytes and one byte more is refused.
const createBodyLimit = 10 << 20

// errCreateBodyTooLarge and errInvalidJSONBody are the two parse outcomes the
// caller distinguishes: an oversized body follows the body-parser overflow
// contract, a malformed one follows the SyntaxError -> BadRequestException
// mapping. Keeping them separate stops an overflow from being reported as a
// syntax error, which is what the previous single 400 did.
var (
	errCreateBodyTooLarge = errors.New("request entity too large")
	errInvalidJSONBody    = errors.New("Invalid JSON body")
)

// writeCreateBodyTooLarge writes the response NestJS produces for a body over the
// 10 MiB parser ceiling.
//
// body-parser raises an "entity.too.large" error with status 413, NestJS's
// RoutesResolver does not recognise it as an HttpException, and
// GlobalExceptionFilter therefore resolves a non-HttpException to 500 and (in
// production) masks the message as "Internal server error" with no error field.
// authhttp.WritePayloadTooLarge already encodes exactly that contract for the
// other migrated JSON routes, so this route reuses it instead of inventing a 413
// shape the NestJS route never returns.
func writeCreateBodyTooLarge(w http.ResponseWriter, r *http.Request) {
	authhttp.WritePayloadTooLarge(w, r)
}

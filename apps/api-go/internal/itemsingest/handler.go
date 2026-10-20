package itemsingest

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
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
func parseCreateBody(r *http.Request) (CreateItemInput, []string, error) {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	var body map[string]json.RawMessage
	if err := decoder.Decode(&body); err != nil {
		return CreateItemInput{}, nil, errors.New("Invalid JSON body")
	}
	if body == nil {
		return CreateItemInput{}, nil, errors.New("Invalid JSON body")
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
}

func writeServiceFailure(w http.ResponseWriter, r *http.Request, err error) {
	if failure := AsFailure(err); failure != nil {
		authhttp.WriteHTTPException(w, r, failure.Status, failure.Message)
		return
	}
	log.Printf("api-go: items ingest REST failure: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

package userdigest

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const (
	// PreferencePath 是偏好 GET/PUT。
	PreferencePath = "/api/user-digest/preference"
	// DeliveryPath 是投递日程 GET/PUT。
	DeliveryPath = "/api/user-digest/delivery"
	// DigestPath 只匹配摘要 GET。不能把 /preference 当成这条路由。
	DigestPath = "/api/user-digest"

	permissionItemsRead = "items.read"
)

// Handler 实现五个摘要路由。orgId / userId 只来自 authhttp.Identity。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler 装配鉴权、MySQL、Mongo、订阅和可选的 Elasticsearch。
// es 和 mdb 都可以是 nil：es 为 nil 时关键词走 Mongo；mdb 为 nil 时关键词/地理
// 分支仍会执行查询并按缺少 Mongo 连接失败，不会把该分支跳过。
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, mdb *mongo.Database, subs personalnews.SubscriptionAPI, es ItemSearcher) *Handler {
	var items *mongo.Collection
	if mdb != nil {
		items = mdb.Collection(processedItemsCollection)
	}
	return &Handler{
		auth: auth,
		svc: &Service{
			db:     db,
			items:  items,
			subs:   subs,
			search: es,
		},
	}
}

// ServeHTTP 分发精确路径。PUT /api/user-digest 没有对应的 Nest 路由，返回 404。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case PreferencePath, DeliveryPath:
		if r.Method != http.MethodGet && r.Method != http.MethodPut {
			http.NotFound(w, r)
			return
		}
	case DigestPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		w.Header().Set("Cache-Control", "no-store")
	}

	var body []byte
	if r.Method == http.MethodPut {
		var kind bodyKind
		body, kind = readBody(r)
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
	}
	if h == nil || h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	if !identity.HasPermission(permissionItemsRead) {
		authhttp.WriteForbidden(w, r, []string{permissionItemsRead})
		return
	}

	switch {
	case r.URL.Path == PreferencePath && r.Method == http.MethodGet:
		value, err := h.svc.GetPreference(r.Context(), identity.OrgID, identity.UserID)
		h.write(w, r, value, err)
	case r.URL.Path == PreferencePath && r.Method == http.MethodPut:
		patch, message := parsePreference(body)
		if message != "" {
			authhttp.WriteBadRequest(w, r, message)
			return
		}
		value, err := h.svc.UpdatePreference(r.Context(), identity.OrgID, identity.UserID, patch)
		h.write(w, r, value, err)
	case r.URL.Path == DeliveryPath && r.Method == http.MethodGet:
		value, err := h.svc.GetDelivery(r.Context(), identity.OrgID, identity.UserID)
		h.write(w, r, value, err)
	case r.URL.Path == DeliveryPath && r.Method == http.MethodPut:
		input, message := parseDelivery(body)
		if message != "" {
			authhttp.WriteBadRequest(w, r, message)
			return
		}
		value, err := h.svc.UpdateDelivery(r.Context(), identity.OrgID, identity.UserID, input)
		h.write(w, r, value, err)
	case r.URL.Path == DigestPath && r.Method == http.MethodGet:
		value, err := h.svc.GenerateDigest(r.Context(), identity.OrgID, identity.UserID)
		h.write(w, r, value, err)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) write(w http.ResponseWriter, r *http.Request, value any, err error) {
	if err != nil {
		h.writeErr(w, r, err)
		return
	}
	payload, err := marshalJSON(value)
	if err != nil {
		log.Printf("userdigest: encode response: %v", err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

func (h *Handler) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var status *statusError
	if errors.As(err, &status) {
		if status.status == http.StatusNotFound {
			writeNestError(w, r, http.StatusNotFound, status.message, "Not Found")
			return
		}
		authhttp.WriteBadRequest(w, r, status.message)
		return
	}
	if errors.Is(err, errMySQL) {
		log.Printf("userdigest: mysql: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if errors.Is(err, errMongo) {
		log.Printf("userdigest: mongo: %v", err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	log.Printf("userdigest: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

func writeNestError(w http.ResponseWriter, r *http.Request, status int, message, errorName string) {
	body := struct {
		StatusCode int    `json:"statusCode"`
		Message    string `json:"message"`
		Error      string `json:"error,omitempty"`
		TraceID    string `json:"traceId"`
		Path       string `json:"path"`
		Timestamp  string `json:"timestamp"`
	}{
		StatusCode: status,
		Message:    message,
		Error:      errorName,
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       r.URL.Path,
		Timestamp:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	payload, err := marshalJSON(body)
	if err != nil {
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

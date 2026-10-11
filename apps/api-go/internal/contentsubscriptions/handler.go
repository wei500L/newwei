package contentsubscriptions

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

const (
	ListPath            = "/api/user-content-subscriptions"
	BatchUpsertPath     = "/api/user-content-subscriptions/batch-upsert"
	BatchDeletePath     = "/api/user-content-subscriptions/batch-delete"
	CatalogPath         = "/api/user-content-subscriptions/catalog"
	RecommendationsPath = "/api/user-content-subscriptions/recommendations"
	LookupPath          = "/api/user-content-subscriptions/catalog/lookup"
	RelatedTopicsPath   = "/api/user-content-subscriptions/related-topics"
)

// Handler 实现用户内容订阅的 HTTP 面。orgId/userId 只来自鉴权身份。
type Handler struct {
	auth     *authhttp.Authenticator
	svc      *Service
	behavior personalnews.BehaviorAPI
}

func NewHandler(auth *authhttp.Authenticator, svc *Service, behavior personalnews.BehaviorAPI) *Handler {
	return &Handler{auth: auth, svc: svc, behavior: behavior}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case ListPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveList(w, r)
	case BatchUpsertPath:
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		h.serveBatch(w, r, true)
	case BatchDeletePath:
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		h.serveBatch(w, r, false)
	case CatalogPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveCatalog(w, r)
	case RecommendationsPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveRecommendations(w, r)
	case LookupPath:
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		h.serveLookup(w, r)
	case RelatedTopicsPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveRelated(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.listUserSubscriptions(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, payload, true)
}

func (h *Handler) serveBatch(w http.ResponseWriter, r *http.Request, upsert bool) {
	body, kind := readBody(r)
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
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	inputs, err := validateSubscriptionBody(body, "subscriptions", batchInputMax)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	var payload batchResponse
	if upsert {
		payload, err = h.svc.batchUpsertSubscriptions(r.Context(), identity.OrgID, identity.UserID, inputs)
	} else {
		payload, err = h.svc.batchDeleteSubscriptions(r.Context(), identity.OrgID, identity.UserID, inputs)
	}
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusCreated, payload, false)
}

func (h *Handler) serveCatalog(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query, err := validateCatalogQuery(r.URL.RawQuery)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.listCatalog(r.Context(), identity.OrgID, query)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeRawJSON(w, http.StatusOK, payload, true)
}

func (h *Handler) serveRecommendations(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	limit, err := validateLimitQuery(r.URL.RawQuery)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.listRecommendations(r.Context(), identity.OrgID, identity.UserID, boundedServiceLimit(limit, recommendationDefault), h.behavior)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeRawJSON(w, http.StatusOK, payload, true)
}

func (h *Handler) serveLookup(w http.ResponseWriter, r *http.Request) {
	body, kind := readBody(r)
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
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	inputs, err := validateSubscriptionBody(body, "entries", lookupInputMax)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.lookupCatalog(r.Context(), identity.OrgID, inputs)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeRawJSON(w, http.StatusCreated, payload, false)
}

func (h *Handler) serveRelated(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query, err := validateRelatedQuery(r.URL.RawQuery)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.listRelatedTopics(r.Context(), identity.OrgID, identity.UserID, query.Topic, boundedServiceLimit(query.Limit, relatedTopicDefault))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeRawJSON(w, http.StatusOK, payload, true)
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return nil
	}
	return identity
}

func writeInputError(w http.ResponseWriter, r *http.Request, err error) {
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	writeServiceError(w, r, err)
}

func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("content subscriptions: %v", err)
	if classifyError(err) == 503 {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload any, noStore bool) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if noStore {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

func writeRawJSON(w http.ResponseWriter, status int, payload []byte, noStore bool) {
	if noStore {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if payload == nil {
		payload = []byte("null")
	}
	_, _ = w.Write(payload)
}

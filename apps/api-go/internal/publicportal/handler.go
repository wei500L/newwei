package publicportal

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

const (
	cacheControl  = "public, max-age=60, s-maxage=60, stale-while-revalidate=300"
	channelPrefix = "/api/public-portal/channels/"
)

// Handler 只服务公开 GET。不进入 user-settings 的 JWT/RBAC 链。
type Handler struct {
	svc *Service
}

func NewHandler(store Store) *Handler {
	return &Handler{svc: NewService(store)}
}

func (h *Handler) ServeHome(w http.ResponseWriter, r *http.Request) {
	payload, err := h.svc.Home(r.Context())
	if err != nil {
		log.Printf("public portal home query failed")
		writeError(w, r, http.StatusInternalServerError, "Internal server error", "")
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) ServeChannel(w http.ResponseWriter, r *http.Request) {
	topic, ok := channelTopic(r.URL.Path)
	if !ok {
		writeError(w, r, http.StatusNotFound, "Channel not found", "Not Found")
		return
	}
	payload, err := h.svc.Channel(r.Context(), topic)
	if err != nil {
		log.Printf("public portal channel query failed")
		writeError(w, r, http.StatusInternalServerError, "Internal server error", "")
		return
	}
	if payload == nil {
		writeError(w, r, http.StatusNotFound, "Channel not found", "Not Found")
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// channelTopic 只接受 prefix 后的一个路径段。
func channelTopic(path string) (string, bool) {
	if !strings.HasPrefix(path, channelPrefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, channelPrefix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(rest)
	if err != nil {
		return rest, true
	}
	return decoded, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	encoded, err := json.Marshal(body)
	if err != nil {
		return
	}
	_, _ = w.Write(encoded)
}

type portalError struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error,omitempty"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

func writeError(w http.ResponseWriter, r *http.Request, status int, message, errorName string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	encoded, err := json.Marshal(portalError{
		StatusCode: status,
		Message:    message,
		Error:      errorName,
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       requestPath(r),
		Timestamp:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		return
	}
	_, _ = w.Write(encoded)
}

func requestPath(r *http.Request) string {
	if r.URL == nil {
		return ""
	}
	if r.URL.RawQuery != "" {
		return r.URL.Path + "?" + r.URL.RawQuery
	}
	return r.URL.Path
}

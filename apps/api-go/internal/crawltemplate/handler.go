package crawltemplate

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	basePath     = "/api/admin/crawl-templates"
	maxJSONBytes = 10 << 20
	permRead     = "crawl.read"
	permWrite    = "crawl.write"
)

// Handler 只服务开关为 go 时接管的采集模板编辑接口。身份只来自鉴权链。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 的路由顺序与注册的路由规则一致：先是精确路径的列表/创建，
// 再是恰好一段的 :id（只认 PATCH 与 DELETE）。GET /:id 详情、更长路径与
// 未列出的方法不在这里（路由层已回落 NestJS）。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == basePath && r.Method == http.MethodGet:
		h.serveList(w, r)
	case path == basePath && r.Method == http.MethodPost:
		h.serveCreate(w, r)
	default:
		if id, ok := singleSegment(path, basePath+"/"); ok {
			switch r.Method {
			case http.MethodPatch:
				h.serveUpdate(w, r, id)
			case http.MethodDelete:
				h.serveDelete(w, r, id)
			default:
				http.NotFound(w, r)
			}
			return
		}
		http.NotFound(w, r)
	}
}

// singleSegment 要求 prefix 之后恰好一个非空路径段。
func singleSegment(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := path[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	search, err := validateListQuery(r.URL.RawQuery)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.ListTemplates(r.Context(), identity.OrgID, search)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	fields, err := parseObjectBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	input, err := validateCreate(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.CreateTemplate(r.Context(), identity.OrgID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// NestJS 的 POST 默认成功码是 201（控制器没有 @HttpCode 覆盖）。
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveUpdate(w http.ResponseWriter, r *http.Request, id string) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	fields, err := parseObjectBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	input, err := validateUpdate(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.UpdateTemplate(r.Context(), identity.OrgID, id, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDelete(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	if err := h.svc.DeleteTemplate(r.Context(), identity.OrgID, id); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- 请求体与响应写出（与 crawlprofile/crawlworkflow 同一套契约） ----

func readJSON(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil || !jsonContent(r.Header.Get("Content-Type")) {
		return []byte("{}"), true
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			authhttp.WritePayloadTooLarge(w, r)
			return nil, false
		}
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return []byte("{}"), true
	}
	if !json.Valid(data) {
		authhttp.WriteBadRequest(w, r, invalidJSONMessage)
		return nil, false
	}
	return data, true
}

func jsonContent(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
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
	if errors.Is(err, errMirroredServerError) {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	var status *statusError
	if errors.As(err, &status) {
		authhttp.WriteHTTPException(w, r, status.status, status.message)
		return
	}
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	log.Printf("crawl templates: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

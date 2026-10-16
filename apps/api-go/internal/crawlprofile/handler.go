package crawlprofile

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
	basePath     = "/api/admin/crawl-frontier"
	profilesPath = basePath + "/profiles"
	maxJSONBytes = 10 << 20
	permRead     = "crawl.read"
	permWrite    = "crawl.write"
)

// Handler 只服务开关为 go 时接管的画像编辑接口。身份只来自鉴权链。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 的路由顺序与注册的路由规则一致：先精确路径 profiles、
// profiles/match、profiles/preview，再 :id 的 versions/rollback，
// 最后是恰好一段的 :id。runs、nodes、workflows、workflow-bridge、
// trial-run 不在这里（路由层已回落 NestJS）。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == profilesPath && r.Method == http.MethodGet:
		h.serveList(w, r)
	case path == profilesPath && r.Method == http.MethodPost:
		h.serveCreate(w, r)
	case path == profilesPath+"/match" && r.Method == http.MethodGet:
		h.serveMatch(w, r)
	case path == profilesPath+"/preview" && r.Method == http.MethodPost:
		h.servePreview(w, r)
	default:
		if id, version, ok := rollbackTarget(path); ok && r.Method == http.MethodPost {
			h.serveRollback(w, r, id, version)
			return
		}
		if id, ok := suffixTarget(path, profilesPath+"/", "/versions"); ok && r.Method == http.MethodGet {
			h.serveVersions(w, r, id)
			return
		}
		if id, ok := singleSegment(path, profilesPath+"/"); ok {
			switch r.Method {
			case http.MethodGet:
				h.serveDetail(w, r, id)
			case http.MethodPatch:
				h.serveUpdate(w, r, id)
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

// suffixTarget 解析 prefix + :id + suffix。
func suffixTarget(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	rest := strings.TrimSuffix(path[len(prefix):], suffix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// rollbackTarget 解析 prefix + :id + /rollback + :version，与路由规则的
// TailSegment 语义一致。
func rollbackTarget(path string) (string, string, bool) {
	const marker = "/rollback/"
	prefix := profilesPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := path[len(prefix):]
	idx := strings.LastIndex(rest, marker)
	if idx <= 0 {
		return "", "", false
	}
	version := rest[idx+len(marker):]
	if version == "" || strings.Contains(version, "/") {
		return "", "", false
	}
	id := rest[:idx]
	if id == "" || strings.Contains(id, "/") {
		return "", "", false
	}
	return id, version, true
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
	payload, err := h.svc.ListProfiles(r.Context(), identity.OrgID, search)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDetail(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetProfile(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveVersions(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.ListVersions(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveMatch(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	urlText, err := validateMatchQuery(r.URL.RawQuery)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.MatchProfileForURL(r.Context(), identity.OrgID, urlText)
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
	payload, err := h.svc.CreateProfile(r.Context(), identity.OrgID, identity.UserID, input)
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
	payload, err := h.svc.UpdateProfile(r.Context(), identity.OrgID, identity.UserID, id, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) servePreview(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	fields, err := parseObjectBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	input, err := validatePreview(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.PreviewProfileDraft(r.Context(), identity.OrgID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// Preview 的 @Post 没有 @HttpCode → 成功 201。
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveRollback(w http.ResponseWriter, r *http.Request, id, version string) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	parsedVersion, versionOK := jsParseInt(version)
	payload, err := h.svc.RollbackProfile(r.Context(), identity.OrgID, identity.UserID, id, parsedVersion, versionOK)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// NestJS 的 POST 默认成功码是 201。
	writeJSON(w, http.StatusCreated, payload)
}

// ---- 请求体与响应写出（与 crawlworkflow 同一套契约） ----

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
	log.Printf("crawl profiles: %v", err)
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

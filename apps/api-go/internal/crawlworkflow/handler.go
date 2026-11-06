package crawlworkflow

import (
	"errors"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	basePath      = "/api/admin/crawl-frontier"
	workflowsPath = basePath + "/workflows"
	maxJSONBytes  = 10 << 20
	permRead      = "crawl.read"
	permWrite     = "crawl.write"
)

// Handler serves the crawl-strategy workflow editing routes. Identity comes only
// from the auth chain.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches in the same order as the registered rules: the exact
// node-schemas/compare paths, then the :id draft, publish and versions shapes,
// then the one-segment :id. trial-run, replay, workflow-runs, profiles
// list/create/preview/rollback, runs and nodes are not owned here and fall through
// to the router's 404 contract.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == workflowsPath+"/node-schemas" && r.Method == http.MethodGet:
		h.serveNodeSchemas(w, r)
	case path == workflowsPath && r.Method == http.MethodGet:
		h.serveList(w, r)
	case path == workflowsPath && r.Method == http.MethodPost:
		h.serveCreate(w, r)
	case path == workflowsPath+"/compare" && r.Method == http.MethodPost:
		h.serveCompare(w, r)
	default:
		if id, action, ok := workflowAction(path); ok {
			switch {
			case action == "" && r.Method == http.MethodGet:
				h.serveDetail(w, r, id)
			case action == "draft" && r.Method == http.MethodPatch:
				h.serveUpdateDraft(w, r, id)
			case action == "publish" && r.Method == http.MethodPost:
				h.servePublish(w, r, id)
			case action == "versions" && r.Method == http.MethodGet:
				h.serveVersions(w, r, id)
			default:
				http.NotFound(w, r)
			}
			return
		}
		if id, ok := singleSegment(path, basePath+"/workflow-versions/"); ok && r.Method == http.MethodGet {
			h.serveVersion(w, r, id)
			return
		}
		if id, ok := bridgeTarget(path, basePath+"/profiles/"); ok && r.Method == http.MethodGet {
			h.serveProfileBridge(w, r, id)
			return
		}
		if id, ok := bridgeTarget(path, basePath+"/news-sources/"); ok && r.Method == http.MethodGet {
			h.serveNewsSourceBridge(w, r, id)
			return
		}
		http.NotFound(w, r)
	}
}

// workflowAction 解析 /workflows/:id 与 /workflows/:id/{draft,publish,versions}。
func workflowAction(path string) (string, string, bool) {
	prefix := workflowsPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := path[len(prefix):]
	if rest == "" {
		return "", "", false
	}
	if !strings.Contains(rest, "/") {
		return rest, "", true
	}
	for _, action := range []string{"draft", "publish", "versions"} {
		suffix := "/" + action
		if strings.HasSuffix(rest, suffix) {
			id := strings.TrimSuffix(rest, suffix)
			if id == "" || strings.Contains(id, "/") {
				return "", "", false
			}
			return id, action, true
		}
	}
	return "", "", false
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

// bridgeTarget 解析 prefix + :id + /workflow-bridge。
func bridgeTarget(path, prefix string) (string, bool) {
	const suffix = "/workflow-bridge"
	if !strings.HasSuffix(path, suffix) {
		return "", false
	}
	return singleSegment(strings.TrimSuffix(path, suffix), prefix)
}

func (h *Handler) serveNodeSchemas(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, permRead) == nil {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, CRAWL_STRATEGY_NODE_SCHEMAS)
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
	payload, err := h.svc.ListWorkflows(r.Context(), identity.OrgID, search)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDetail(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetWorkflow(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
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
	httpx.WriteJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveVersion(w http.ResponseWriter, r *http.Request, versionID string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetVersion(r.Context(), identity.OrgID, versionID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveCompare(w http.ResponseWriter, r *http.Request) {
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
	input, err := validateCompare(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.CompareVersions(r.Context(), identity.OrgID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// NestJS 的 POST 默认成功码是 201（compare 没有 @HttpCode 覆盖）。
	httpx.WriteJSON(w, http.StatusCreated, payload)
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
	input, err := validateCreateWorkflow(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.CreateWorkflow(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveUpdateDraft(w http.ResponseWriter, r *http.Request, id string) {
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
	input, err := validateUpdateDraft(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.UpdateDraft(r.Context(), identity.OrgID, identity.UserID, id, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

func (h *Handler) servePublish(w http.ResponseWriter, r *http.Request, id string) {
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
	input, err := validatePublish(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.PublishWorkflow(r.Context(), identity.OrgID, identity.UserID, id, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveProfileBridge(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	// seedUrl 是 @Query('seedUrl') 原始值（无 DTO 校验、不 trim）。
	payload, err := h.svc.ProfileBridge(r.Context(), identity.OrgID, id, r.URL.Query().Get("seedUrl"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveNewsSourceBridge(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.NewsSourceBridge(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

// ---- 请求体与响应写出（与 news-sources 同一套契约） ----

func readJSON(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil || !jsonContent(r.Header.Get("Content-Type")) {
		return []byte("{}"), true
	}
	data, err := httpx.ReadJSON(w, r, maxJSONBytes)
	switch {
	case err == nil:
		return data, true
	case errors.Is(err, httpx.ErrEmptyBody):
		return []byte("{}"), true
	case errors.Is(err, httpx.ErrBodyTooLarge):
		authhttp.WritePayloadTooLarge(w, r)
		return nil, false
	case errors.Is(err, httpx.ErrReadBody):
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	default:
		authhttp.WriteBadRequest(w, r, invalidJSONMessage)
		return nil, false
	}
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
	log.Printf("crawl workflows: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

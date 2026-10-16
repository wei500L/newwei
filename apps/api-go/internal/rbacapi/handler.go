package rbacapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	permissionsPath = "/api/rbac/permissions"
	rolesPath       = "/api/rbac/roles"
	assignPath      = "/api/rbac/assign"
	membersPath     = "/api/rbac/members"
	auditLogsPath   = "/api/rbac/audit-logs"
	maxJSONBytes    = 10 << 20

	permPermissionsRead = "permissions.read"
	permRolesRead       = "roles.read"
	permRolesWrite      = "roles.write"
	permUsersRead       = "users.read"
	// 审计记录暴露 actor、ip、metadata，必须是 settings.manage——不回退到
	// 分析师也持有的 roles.read。
	permSettingsManage = "settings.manage"
)

// Handler 只服务开关为 go 时接管的 RBAC 六条 HTTP。身份只来自鉴权链。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == permissionsPath && r.Method == http.MethodGet:
		h.servePermissions(w, r)
	case r.URL.Path == rolesPath && r.Method == http.MethodGet:
		h.serveRoles(w, r)
	case r.URL.Path == rolesPath && r.Method == http.MethodPost:
		h.serveCreateRole(w, r)
	case r.URL.Path == assignPath && r.Method == http.MethodPost:
		h.serveAssignRole(w, r)
	case r.URL.Path == membersPath && r.Method == http.MethodGet:
		h.serveMembers(w, r)
	case r.URL.Path == auditLogsPath && r.Method == http.MethodGet:
		h.serveAuditLogs(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) servePermissions(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permPermissionsRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.ListPermissions(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRoles(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRolesRead)
	if identity == nil {
		return
	}
	includeSystem := true
	if values, present := r.URL.Query()["includeSystem"]; present {
		// 字面量规则：只有正好是字符串 "true" 才是 true；false/FALSE/1/yes
		// 或其他值一律 false。
		includeSystem = len(values) > 0 && values[0] == "true"
	}
	payload, err := h.svc.ListRoles(r.Context(), identity.OrgID, includeSystem)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveCreateRole(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permRolesWrite)
	if identity == nil {
		return
	}
	name, description, permissions, err := parseCreateRoleBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.CreateRole(r.Context(), identity.OrgID, identity.UserID, identity.PermissionSet(), name, description, permissions)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveAssignRole(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permRolesWrite)
	if identity == nil {
		return
	}
	userID, roleID, err := parseAssignRoleBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.AssignRole(r.Context(), identity.OrgID, identity.UserID, identity.PermissionSet(), userID, roleID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveMembers(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permUsersRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.ListMembers(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveAuditLogs(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permSettingsManage)
	if identity == nil {
		return
	}
	payload, err := h.svc.AuditLogs(r.Context(), identity.OrgID, parseAuditLimit(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// parseAuditLimit 对齐控制器的 limit 算法：Number(query)；有限且大于 0 →
// Math.min(Math.trunc(n), 200)；否则 20。缺省/0/负数/非数字 → 20。
func parseAuditLimit(r *http.Request) int {
	values, present := r.URL.Query()["limit"]
	if !present || len(values) == 0 {
		return 20
	}
	parsed, ok := parseJSNumber(values[0])
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return 20
	}
	return int(math.Min(math.Trunc(parsed), 200))
}

func parseJSNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return math.NaN(), false
	}
	return parsed, true
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
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
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// ---- 请求体解析 ----

func parseCreateRoleBody(body []byte) (string, string, []string, error) {
	fields, err := parseObjectBody(body)
	if err != nil {
		return "", "", nil, err
	}
	rawName, hasName := fields["name"]
	if !hasName {
		return "", "", nil, &inputError{Message: "name must be a string"}
	}
	name, ok := jsString(rawName)
	if !ok {
		return "", "", nil, &inputError{Message: "name must be a string"}
	}
	if len([]rune(name)) > 64 {
		return "", "", nil, &inputError{Message: "name must be shorter than or equal to 64 characters"}
	}
	description := ""
	if rawDescription, hasDescription := fields["description"]; hasDescription && !isJSONNull(rawDescription) {
		parsed, ok := jsString(rawDescription)
		if !ok {
			return "", "", nil, &inputError{Message: "description must be a string"}
		}
		description = parsed
	}
	rawPermissions, hasPermissions := fields["permissions"]
	if !hasPermissions {
		return "", "", nil, &inputError{Message: "permissions must be an array"}
	}
	items, ok := decodeRawArray(rawPermissions)
	if !ok {
		return "", "", nil, &inputError{Message: "permissions must be an array"}
	}
	if len(items) == 0 {
		return "", "", nil, &inputError{Message: "permissions should not be empty"}
	}
	permissions := make([]string, 0, len(items))
	for _, item := range items {
		value, ok := jsString(item)
		if !ok {
			return "", "", nil, &inputError{Message: "each value in permissions must be a string"}
		}
		permissions = append(permissions, value)
	}
	return name, description, permissions, nil
}

func parseAssignRoleBody(body []byte) (string, string, error) {
	fields, err := parseObjectBody(body)
	if err != nil {
		return "", "", err
	}
	userID, err := requiredStringField(fields, "userId")
	if err != nil {
		return "", "", err
	}
	roleID, err := requiredStringField(fields, "roleId")
	if err != nil {
		return "", "", err
	}
	return userID, roleID, nil
}

func requiredStringField(fields map[string]json.RawMessage, name string) (string, error) {
	raw, ok := fields[name]
	if !ok {
		return "", &inputError{Message: name + " must be a string"}
	}
	value, ok := jsString(raw)
	if !ok {
		return "", &inputError{Message: name + " must be a string"}
	}
	return value, nil
}

func parseObjectBody(body []byte) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return nil, &inputError{Message: invalidJSONMessage}
	}
	return fields, nil
}

func jsString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

func decodeRawArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, false
	}
	return items, true
}

// ---- 请求体与响应写出（与 crawlprofile/newssources 同一套契约） ----

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

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
		authhttp.WriteBadRequest(w, r, invalidJSONMessage)
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
	log.Printf("rbac: %v", err)
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

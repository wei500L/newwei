package crawltemplate

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// authorize 与 newssources/crawlprofile/crawlworkflow 的 authorize 相同：
//   - 缺少 Authorization 或不是 Bearer → 401（文案与 authhttp.WriteUnauthorized 一致）；
//   - token 以 mtk_ 开头 → 本包的 AuthenticateMachine（不调用 authhttp.Authenticate，
//     因为它会拒绝 mtk_）；查不到/已撤销/已过期/组织停用 → 401 Invalid machine token；
//   - 其他 token → authhttp.Authenticate（membership 重推导；JWT 里的 permissions 不算）；
//   - 缺少方法要求的权限 → 403 authhttp.WriteForbidden。
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

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

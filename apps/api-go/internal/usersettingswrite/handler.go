// Package usersettingswrite 是六个 user-settings PUT 的 Go 写接管
// （Go-批3C）。只在 API_GO_USER_SETTINGS_WRITE_MODE=go 且读模式同为 go
// 时由路由表把精确路径的 PUT 送进来；默认 legacy 时这些 PUT 仍纯代理
// NestJS。
//
// 请求链与 NestJS 一致：body-parser（限额 / 非法 JSON）→ JWT 验签 →
// Redis blacklist → MySQL membership/RBAC → items.read → DTO 顶层校验
// → 固定 key upsert → 写后按既有 Query 重读并返回完整 envelope。
//
// Situation Monitor 的 monitors/layout/settings 各自独立 upsert，没有
// 事务。某一段失败时前面已成功的段会留下——与 NestJS Promise.all 一样，
// 不承诺三段原子提交。
package usersettingswrite

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
)

// Store 是写路径需要的数据访问：既有只读查询（写后重读）+ 固定 key upsert。
type Store interface {
	usersettings.Repository
	UpsertFixed(ctx context.Context, orgID, userID string, key usersettings.SettingKey, value []byte) error
}

// Handler 处理六个 PUT。鉴权链与六个 GET 是同一个 authhttp.Authenticator。
type Handler struct {
	auth *authhttp.Authenticator
	repo Store
}

// NewHandler 构造写 handler。
func NewHandler(auth *authhttp.Authenticator, repo Store) *Handler {
	return &Handler{auth: auth, repo: repo}
}

// ServeHTTP 处理一个精确路径上的 PUT。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.NotFound(w, r)
		return
	}

	// 解析器在 Guard 之前（Nest 中间件顺序）。超限与非法 JSON 不查库、
	// 不验签。
	body, kind := readBody(r)
	switch kind {
	case bodyTooLarge:
		writeParserError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		return
	case bodyInvalidJSON:
		writeParserError(w, http.StatusBadRequest, invalidJSONMessage(body))
		return
	case bodyAbsent:
		body = []byte("{}")
	}

	if h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	if !identity.HasPermission(usersettingsread.RequiredPermission) {
		authhttp.WriteForbidden(w, r, []string{usersettingsread.RequiredPermission})
		return
	}

	segments, err := Plan(r.URL.Path, body)
	var bad *inputError
	if errors.As(err, &bad) {
		authhttp.WriteBadRequest(w, r, bad.Message)
		return
	}
	if err != nil {
		log.Printf("user-settings write: plan failed: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}

	// 逐段 upsert，不包事务。orgId/userId 只来自身份。失败时已写入的
	// 段不会回滚（与 NestJS 独立 Promise.all 相同的部分成功边界）。
	for _, seg := range segments {
		if err := h.repo.UpsertFixed(r.Context(), identity.OrgID, identity.UserID, seg.Key, seg.Value); err != nil {
			log.Printf("user-settings write: upsert failed: %v", err)
			authhttp.WriteDatabaseFailure(w, r)
			return
		}
	}

	response, err := usersettingsread.Query(r.Context(), h.repo, r.URL.Path, identity.OrgID, identity.UserID)
	if errors.Is(err, usersettingsread.ErrUnknownPath) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("user-settings write: reread failed: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := json.Marshal(response)
	if err != nil {
		log.Printf("user-settings write: marshal response failed: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}

	// PUT 没有 @Header("Cache-Control")。content-type 与 Express res.json
	// 一致；正文不追加换行。状态码 200（Nest @Put 默认）。
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

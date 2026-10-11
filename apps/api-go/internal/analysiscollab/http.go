package analysiscollab

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const maxJSONBodyBytes = 10 << 20

// ErrNullConstraint 对齐 Prisma 拒绝把 null 写入非空布尔/枚举列。
// Nest 生产环境把这类校验错误收成 500，没有 error 字段。
var ErrNullConstraint = errors.New("analysis: null violates a required column")

// ErrPayloadTooLarge 对齐超过 json limit 后 Nest 生产环境的 500。
var ErrPayloadTooLarge = errors.New("payload too large")

// Principal 是鉴权通过并且具备所需权限的调用者。
type Principal struct {
	OrgID string
	Actor Actor
}

// Authenticate 先走既有鉴权链，再检查一个权限。失败时响应已经写完。
func Authenticate(w http.ResponseWriter, r *http.Request, auth *authhttp.Authenticator, permission string) (Principal, bool) {
	if auth == nil {
		authhttp.WriteInternalFailure(w, r)
		return Principal{}, false
	}
	identity := auth.Authenticate(w, r)
	if identity == nil {
		return Principal{}, false
	}
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return Principal{}, false
	}
	return Principal{OrgID: identity.OrgID, Actor: Actor{ID: identity.UserID, Has: identity.HasPermission}}, true
}

// ReadJSONBody 在鉴权之前读取 JSON。非 application/json 视为空对象。
// 非法 JSON 返回 400；超过 10MiB 返回 ErrPayloadTooLarge。
func ReadJSONBody(r *http.Request) ([]byte, error) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, nil
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, ErrPayloadTooLarge
		}
		return nil, BadRequest(invalidJSONMessage(data))
	}
	if len(bytes.TrimSpace(data)) == 0 || !json.Valid(bytes.TrimSpace(data)) {
		return nil, BadRequest(invalidJSONMessage(data))
	}
	return data, nil
}

func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return mediaType == "application/json"
}

func invalidJSONMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if bytes.Equal(trimmed, []byte("{")) {
		return "Expected property name or '}' in JSON at position 1"
	}
	if len(body) == 0 {
		return "Unexpected end of JSON input"
	}
	token := body[0]
	snippet := body
	ellipsis := ""
	if len(snippet) > 10 {
		snippet = snippet[:10]
		ellipsis = "..."
	}
	return fmt.Sprintf("Unexpected token '%c', \"%s\"%s is not valid JSON", token, string(snippet), ellipsis)
}

// WriteJSON 写成功响应。noStore 只用于带 @Header("Cache-Control", "no-store") 的 GET。
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, payload any, noStore bool) {
	data, err := Marshal(payload)
	if err != nil {
		log.Printf("analysis: marshal response: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	writeBytes(w, status, data, noStore)
}

// WriteNull 写 JSON null。GET 无讨论、PUT 空笔记且尚无 thread 都是 200。
func WriteNull(w http.ResponseWriter, noStore bool) {
	writeBytes(w, http.StatusOK, []byte("null"), noStore)
}

// WriteOK 是删除和归档的 {ok:true}。
func WriteOK(w http.ResponseWriter) {
	writeBytes(w, http.StatusOK, []byte(`{"ok":true}`), false)
}

func writeBytes(w http.ResponseWriter, status int, payload []byte, noStore bool) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	if noStore {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// WriteError 把业务错误写成 Nest 形状。其余错误按 MySQL 失败返回 503，不把驱动文本给客户端。
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var status *StatusError
	if errors.As(err, &status) {
		authhttp.WriteHTTPException(w, r, status.Status, status.Message)
		return
	}
	if errors.Is(err, ErrNullConstraint) {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if errors.Is(err, ErrPayloadTooLarge) {
		authhttp.WritePayloadTooLarge(w, r)
		return
	}
	log.Printf("analysis: request failed: %v", err)
	authhttp.WriteDatabaseFailure(w, r)
}

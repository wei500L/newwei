package usersettingswrite

import (
	"bytes"
	"encoding/json"
	"errors"
	"html"
	"io"
	"mime"
	"net/http"
	"strings"
)

// maxJSONBodyBytes 是 NestJS 实际生效的 JSON 体上限。
//
// apps/api/src/main.ts 在 bootstrap 里又挂了一个 json({limit:"10mb"})，
// 但 NestFactory.create 会先注册 platform-express 的默认 json 解析器
// （body-parser 默认 limit = 100kb）。默认解析器在前：超限直接 413，
// 后挂的 10mb 解析器看不到请求体。因此与真实 NestJS 对齐的边界是
// 100 KiB，不是 10 MiB。
const maxJSONBodyBytes = 100 * 1024

type bodyKind int

const (
	bodyAbsent bodyKind = iota
	bodyOK
	bodyInvalidJSON
	bodyTooLarge
)

// readBody 按 content-type 读取 JSON 体。非 application/json 视为无体
// （Nest body-parser 跳过，ValidationPipe 把 nil 收成空对象）。超限与
// 非法 JSON 在鉴权之前返回——与 Express 中间件先于 Guard 的顺序一致。
// 读取有硬上限，不会无界读入内存。
func readBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	if len(bytes.TrimSpace(data)) == 0 || !json.Valid(bytes.TrimSpace(data)) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return media == "application/json"
}

// writeParserError 复刻 Express finalhandler 在 NODE_ENV=production、
// err.expose=true、客户端未声明 Accept 时的 HTML 400/413（body-parser
// 错误不进入 GlobalExceptionFilter）。
func writeParserError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	body := "<!DOCTYPE html>\n" +
		"<html lang=\"en\">\n" +
		"<head>\n" +
		"<meta charset=\"utf-8\">\n" +
		"<title>Error</title>\n" +
		"</head>\n" +
		"<body>\n" +
		"<pre>" + html.EscapeString(message) + "</pre>\n" +
		"</body>\n" +
		"</html>\n"
	_, _ = w.Write([]byte(body))
}

// invalidJSONMessage 尽量对齐 Node 20 JSON.parse 对 smoke 使用的残缺
// 对象的文案。其他非法体返回同一类「位置 0」语法错误——真实栈 smoke
// 用 `{` 做对照；若 Nest 文案不同，以 Nest 响应为准再改这里。
func invalidJSONMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	switch string(trimmed) {
	case "{", "[":
		return "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
	case "":
		return "Unexpected end of JSON input"
	default:
		return "Unexpected token in JSON at position 0"
	}
}

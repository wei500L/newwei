package usersettingswrite

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
)

// maxJSONBodyBytes 对齐 apps/api/src/main.ts 的 json({limit:"10mb"})。
//
// 远端 smoke（run 36267117840）对 100KiB+1 的非 JSON 体得到的是
// JSON 解析 400，不是 413。因此不能把 body-parser 的 100kb 默认值
// 当成已经生效的限额；这里用 main.ts 写明的 10 MiB，并在读取时截断。
const maxJSONBodyBytes = 10 << 20

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

// invalidJSONMessage 对齐 Node 20 JSON.parse 经 Nest
// RoutesResolver.mapExternalException 变成 BadRequestException 后的
// message（smoke 1b 的响应字节长度反推，run 36267117840）：
//   - `{` → Expected property name or '}' in JSON at position 1
//   - 以其他字符开头 → Unexpected token '<c>', "<前 10 字符>"... is not valid JSON
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

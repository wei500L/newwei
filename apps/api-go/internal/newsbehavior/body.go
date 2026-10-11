package newsbehavior

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

// maxJSONBodyBytes 对齐 main.ts 的 json({ limit: "10mb" })。
// 超过限额时 Nest 生产环境走 GlobalExceptionFilter 的 500，不是 413。
const maxJSONBodyBytes = 10 << 20

type bodyKind int

const (
	bodyAbsent bodyKind = iota
	bodyOK
	bodyInvalidJSON
	bodyTooLarge
)

// readJSONBody 只在 Content-Type 为 application/json 时解析正文。
// 其他类型视为无体（Nest body-parser 跳过，ValidationPipe 收到 {}）。
// 超限与非法 JSON 在鉴权之前返回。
func readJSONBody(r *http.Request) ([]byte, bodyKind) {
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

// invalidJSONMessage 对齐 Node JSON.parse 经 Nest 收成 BadRequestException
// 之后的 message。空白体是 Unexpected end of JSON input；单独的 `{`
// 是 Expected property name。
func invalidJSONMessage(body []byte) string {
	if len(bytes.TrimSpace(body)) == 0 {
		return "Unexpected end of JSON input"
	}
	trimmed := bytes.TrimSpace(body)
	if bytes.Equal(trimmed, []byte("{")) {
		return "Expected property name or '}' in JSON at position 1"
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

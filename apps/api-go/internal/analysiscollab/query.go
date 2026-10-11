package analysiscollab

import (
	"net/url"
	"strings"
	"unicode/utf8"
)

// NormalizeQueryString 对齐 service.normalizeQueryString：
// trim、去掉开头的问号、URLSearchParams 删除 savedView/page/pageSize，
// 保留其余重复参数、编码和顺序。
func NormalizeQueryString(queryString string) string {
	trimmed := strings.TrimSpace(queryString)
	for len(trimmed) > 0 && trimmed[0] == '?' {
		trimmed = trimmed[1:]
	}
	if trimmed == "" {
		return ""
	}
	pairs := parseSearchParams(trimmed)
	kept := pairs[:0]
	for _, pair := range pairs {
		switch pair.key {
		case "savedView", "page", "pageSize":
			continue
		default:
			kept = append(kept, pair)
		}
	}
	return encodeSearchParams(kept)
}

type searchPair struct {
	key   string
	value string
}

func parseSearchParams(raw string) []searchPair {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, "&")
	out := make([]searchPair, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		out = append(out, searchPair{key: queryDecode(key), value: queryDecode(value)})
	}
	return out
}

func encodeSearchParams(pairs []searchPair) string {
	if len(pairs) == 0 {
		return ""
	}
	var buf strings.Builder
	for index, pair := range pairs {
		if index > 0 {
			buf.WriteByte('&')
		}
		buf.WriteString(queryEncode(pair.key))
		buf.WriteByte('=')
		buf.WriteString(queryEncode(pair.value))
	}
	return buf.String()
}

func queryDecode(value string) string {
	value = strings.ReplaceAll(value, "+", " ")
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

func queryEncode(value string) string {
	var buf strings.Builder
	for _, r := range value {
		if isFormUnreserved(r) {
			buf.WriteRune(r)
			continue
		}
		if r == ' ' {
			buf.WriteByte('+')
			continue
		}
		var tmp [4]byte
		n := utf8.EncodeRune(tmp[:], r)
		for i := 0; i < n; i++ {
			buf.WriteByte('%')
			buf.WriteByte(hexUpper(tmp[i] >> 4))
			buf.WriteByte(hexUpper(tmp[i] & 0x0f))
		}
	}
	return buf.String()
}

func isFormUnreserved(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '*' || r == '-' || r == '.' || r == '_'
}

func hexUpper(v byte) byte {
	if v < 10 {
		return '0' + v
	}
	return 'A' + (v - 10)
}

// BuildQueryState 写入 SavedAnalysisView.queryState。只有 queryString 一个键。
func BuildQueryState(queryString string) ([]byte, error) {
	return Marshal(QueryState{QueryString: NormalizeQueryString(queryString)})
}

// ReadQueryState 对齐 service.readQueryState：坏 JSON、数组和非字符串都回退成空 queryString，
// 字符串会再走一遍 NormalizeQueryString。
func ReadQueryState(raw []byte) QueryState {
	if len(raw) == 0 {
		return QueryState{QueryString: ""}
	}
	var payload map[string]any
	if err := unmarshalObject(raw, &payload); err != nil {
		return QueryState{QueryString: ""}
	}
	value, _ := payload["queryString"].(string)
	return QueryState{QueryString: NormalizeQueryString(value)}
}

func unmarshalObject(raw []byte, dest *map[string]any) error {
	trimmed := bytesTrim(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errNotObject
	}
	return jsonUnmarshal(trimmed, dest)
}

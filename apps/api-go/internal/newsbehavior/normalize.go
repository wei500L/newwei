package newsbehavior

import (
	"net/url"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// structuredSourceRE 是 Nest looksLikeStructuredSourceKey。
// 长度 2..64，首字符字母或数字，其余为字母数字、点、下划线、连字符。
var structuredSourceRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,63}$`)

func normalizeTerms(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		term := normalizeTerm(value)
		if term == "" {
			continue
		}
		if _, ok := seen[term]; ok {
			continue
		}
		seen[term] = struct{}{}
		out = append(out, term)
		if len(out) >= maxTermsPerDimension {
			break
		}
	}
	return out
}

// normalizeID 只 trim 并按 UTF-16 码元截到 128，不改变大小写。
func normalizeID(value string) string {
	return sliceUTF16(trimJS(value), maxIDLength)
}

// normalizeTerm 对齐 trim → toLowerCase → 折叠空白 → slice(0, 96)。
// slice 按 UTF-16 码元，与 JavaScript String.slice 一致；BMP 文本与按码点截断相同。
func normalizeTerm(value string) string {
	compact := collapseSpaces(strings.ToLower(trimJS(value)))
	compact = sliceUTF16(compact, maxTermLength)
	return compact
}

func normalizeURLDomain(value string) string {
	if trimJS(value) == "" {
		return ""
	}
	// WHATWG URL 解析会去掉首尾空白。net/url 不会，这里先 trim。
	parsed, err := url.Parse(trimJS(value))
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return ""
	}
	host := strings.TrimPrefix(strings.ToLower(parsed.Hostname()), "www.")
	return normalizeTerm(host)
}

// normalizeSourceSignal 优先采用像稳定 source key 的字符串；
// 否则在有域名时用域名，最后才退回自由文本来源。
func normalizeSourceSignal(source, domain string) string {
	normalized := normalizeTerm(source)
	if normalized != "" && structuredSourceRE.MatchString(normalized) {
		return normalized
	}
	if domain != "" {
		return domain
	}
	return normalized
}

// isJSWhitespace 对齐 String.trim / \s：不含 U+0085，含 U+FEFF。
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

func trimJS(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

func collapseSpaces(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	prevSpace := false
	for _, r := range value {
		if isJSWhitespace(r) {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// sliceUTF16 按 UTF-16 码元截断。切断落在代理项中间时，utf16.Decode
// 会把孤立代理项换成 U+FFFD；BMP 文本不会走到这条路径。
func sliceUTF16(value string, maxUnits int) string {
	if value == "" || maxUnits <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) <= maxUnits {
		return value
	}
	return string(utf16.Decode(units[:maxUnits]))
}

// codePointLen 对齐 validator.js isLength：UTF-16 长度减去代理对，即码点数。
func codePointLen(value string) int {
	return utf8.RuneCountInString(value)
}

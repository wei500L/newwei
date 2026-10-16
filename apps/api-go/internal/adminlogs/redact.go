// Package adminlogs 是管理端日志与异常读取 7 条 GET 的 Go 接管实现
// （开关 API_GO_ADMIN_LOGS_MODE=go 时才注册 handler）。
//
// 事实源（逐段翻译，未使用简化版）：
//   - apps/api/src/modules/observability/admin-logs.controller.ts（全文）
//   - apps/api/src/modules/observability/admin-errors.controller.ts（全文）
//   - apps/api/src/modules/observability/admin-logs.service.ts 的
//     listTaskLogs / summarizeTaskLogs / listErrors / summarizeErrors /
//     listAuditLogs / redactDeep / isSensitiveKey
//   - apps/api/src/modules/observability/exception-events.service.ts 的
//     buildFilter / list / stats
//   - packages/utils/src/error-sanitizer.ts 的 SENSITIVE_PATTERNS 与
//     redactSensitiveFields
//   - packages/mongo/src/models/task-log.ts 与 exception-event.ts
//     （Mongoose 默认集合名 tasklogs / exceptionevents）
package adminlogs

import (
	"regexp"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	redacted = "[REDACTED]"
	// maxRedactDepth 对齐 redactDeep 的 depth > 10 原样返回。
	maxRedactDepth = 10
)

// sensitivePatterns 逐条翻译 packages/utils/src/error-sanitizer.ts 的
// SENSITIVE_PATTERNS（9 条，顺序保持——替换按序叠加，前一条的结果会再被
// 后面的模式扫描）。
var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)password\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)token\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)apiKey\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)api_key\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)secret\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)credential\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)auth\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)bearer\s+[a-zA-Z0-9._-]+`),
	regexp.MustCompile(`(?i)basic\s+[a-zA-Z0-9+/=]+`),
}

// redactSensitiveFields 对齐同名的 TS 函数：按模式顺序替换；命中里出现
// 分隔符（= 或 :）时保留「键名 + 分隔符」原样再拼 [REDACTED]；否则 Bearer
// 变 Bearer [REDACTED]、Basic 变 Basic [REDACTED]、其余整体变 [REDACTED]。
func redactSensitiveFields(input string) string {
	result := input
	for _, pattern := range sensitivePatterns {
		result = pattern.ReplaceAllStringFunc(result, redactMatch)
	}
	return result
}

func redactMatch(match string) string {
	// JS 先 match(/[=:]/) 找分隔符，再用 indexOf 找它的下标——等价于首个
	// = 或 : 的下标。
	if index := strings.IndexAny(match, "=:"); index >= 0 {
		return match[:index+1] + redacted
	}
	if len(match) >= len("bearer") && strings.EqualFold(match[:len("bearer")], "bearer") {
		return "Bearer " + redacted
	}
	if len(match) >= len("basic") && strings.EqualFold(match[:len("basic")], "basic") {
		return "Basic " + redacted
	}
	return redacted
}

// escapeRegex 对齐 exception-events.service.ts 的 escapeRegex：只把 JS
// 正则的 14 个元字符转义，其余原样。转义后的模式再由 Go RE2 编译（加 (?i)
// 即 $options: "i"）。
func escapeRegex(value string) string {
	var builder strings.Builder
	builder.Grow(len(value) + 8)
	for _, char := range value {
		switch char {
		case '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			builder.WriteByte('\\')
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// isSensitiveKey 对齐 admin-logs.service.ts 的 isSensitiveKey：trim + 小写
// 后命中固定表，或以 _api_key / apikey 结尾。
func isSensitiveKey(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	if normalized == "" {
		return false
	}
	switch normalized {
	case "authorization",
		"proxy-authorization",
		"x-api-key",
		"x_api_key",
		"api_key",
		"apikey",
		"token",
		"access_token",
		"refresh_token",
		"password",
		"passphrase",
		"secret":
		return true
	}
	return strings.HasSuffix(normalized, "_api_key") || strings.HasSuffix(normalized, "apikey")
}

// redactDeep 对齐同名的 TS 函数：
//   - depth > 10 原样返回；
//   - nil 原样返回；
//   - 字符串走 redactSensitiveFields；
//   - number / boolean 原样；
//   - 数组逐项递归（depth+1）；
//   - 对象逐键处理：敏感键 → "[REDACTED]"，否则递归（depth+1）。
//
// BSON 的 ObjectID / DateTime 先归一为 JS JSON.stringify 的等价物
// （ObjectId 的 toJSON 是 hex 字符串，Date 是 ISO 字符串）。
func redactDeep(value any, depth int) any {
	if depth > maxRedactDepth {
		return value
	}
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return redactSensitiveFields(typed)
	case bool, int32, int64, float64, int, int16, int8, uint, uint32, uint64:
		return typed
	case bson.ObjectID:
		return typed.Hex()
	case bson.DateTime:
		return formatJSTime(typed.Time())
	case bson.A:
		return redactArray(typed, depth)
	case []any:
		return redactArray(typed, depth)
	case bson.M:
		return redactObject(typed, depth)
	case map[string]any:
		return redactObject(typed, depth)
	case bson.D:
		object := make(map[string]any, len(typed))
		for _, entry := range typed {
			object[entry.Key] = entry.Value
		}
		return redactObject(object, depth)
	default:
		return value
	}
}

func redactArray(entries []any, depth int) []any {
	out := make([]any, 0, len(entries))
	for _, entry := range entries {
		out = append(out, redactDeep(entry, depth+1))
	}
	return out
}

func redactObject(entries map[string]any, depth int) map[string]any {
	out := make(map[string]any, len(entries))
	for key, entry := range entries {
		if isSensitiveKey(key) {
			out[key] = redacted
			continue
		}
		out[key] = redactDeep(entry, depth+1)
	}
	return out
}

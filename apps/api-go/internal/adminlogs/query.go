package adminlogs

import (
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ---- 查询参数读取（对齐 NestJS 控制器的 typeof value !== "string" 分支） ----

// querySingle 读一个查询参数。恰好出现一次时返回其值；缺失或重复出现
// （Express 的 qs 会把重复键变成数组，Nest 的 typeof 判成非字符串）返回
// 空串——两种情况在控制器里都当 undefined。
func querySingle(values url.Values, name string) string {
	items := values[name]
	if len(items) != 1 {
		return ""
	}
	return items[0]
}

// looseTimeLayouts 覆盖 JS new Date(string) 会接受的 ISO-8601 形状。
// 无时区的字符串按 UTC 解释（JS 对 "YYYY-MM-DD" 也是 UTC）。
var looseTimeLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02",
	"2006-01",
	"2006",
}

func parseLooseTime(value string) (time.Time, bool) {
	for _, layout := range looseTimeLayouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

// parseDateQuery 对齐 parseDateQuery：空 / 纯空白 → undefined；非法日期 →
// 400 "<name> must be a valid date"。
func parseDateQuery(name, raw string) (*time.Time, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	parsed, ok := parseLooseTime(trimmed)
	if !ok {
		return nil, &inputError{Message: name + " must be a valid date"}
	}
	return &parsed, nil
}

// parseDateRange 对齐 parseDateRange：两端都能解析且 start > end → 400。
func parseDateRange(startRaw, endRaw string) (*time.Time, *time.Time, error) {
	start, err := parseDateQuery("start", startRaw)
	if err != nil {
		return nil, nil, err
	}
	end, err := parseDateQuery("end", endRaw)
	if err != nil {
		return nil, nil, err
	}
	if start != nil && end != nil && start.After(*end) {
		return nil, nil, &inputError{Message: "start must be earlier than or equal to end"}
	}
	return start, end, nil
}

// jsNumber 对齐 JS 的 Number(string)：允许前导/尾随空白、十进制科学计数、
// 0x/0b/0o 前缀与 Infinity/NaN；下划线一律拒绝（JS 会得到 NaN）。
func jsNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	if strings.ContainsRune(trimmed, '_') {
		return 0, false
	}
	lower := strings.ToLower(trimmed)
	unsigned := strings.TrimLeft(trimmed, "+-")
	if len(lower) >= 2 && lower[0] == '0' && (lower[1] == 'x' || lower[1] == 'b' || lower[1] == 'o') {
		var base int
		switch lower[1] {
		case 'x':
			base = 16
		case 'b':
			base = 2
		default:
			base = 8
		}
		digits := unsigned[2:]
		if digits == "" {
			return 0, false
		}
		parsed, err := strconv.ParseInt(digits, base, 64)
		if err != nil {
			return 0, false
		}
		if strings.HasPrefix(trimmed, "-") {
			return -float64(parsed), true
		}
		return float64(parsed), true
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	case "NaN":
		return math.NaN(), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// parsePositiveIntQuery 对齐 parsePositiveIntQuery：空 / 纯空白 → fallback；
// 非正有限数 → 400 "<name> must be a positive number"；否则 Math.trunc。
func parsePositiveIntQuery(name, raw string, fallback int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	parsed, ok := jsNumber(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return 0, &inputError{Message: name + " must be a positive number"}
	}
	truncated := math.Trunc(parsed)
	if truncated > float64(math.MaxInt32) {
		return math.MaxInt32, nil
	}
	return int(truncated), nil
}

// normalizePagination 对齐 admin-logs.service.ts 的 normalizePagination
// （page 缺省 1；pageSize 缺省 20，收口到最大 100）。
func normalizePagination(page, pageSize int) (int, int) {
	if page <= 0 {
		page = defaultPage
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	return page, pageSize
}

// parseLimit 对齐 admin-errors.controller.ts 的 `const parsedLimit = limit ?
// Number(limit) : undefined` 再经 `Number.isFinite(...) ? ... : undefined`：
// 空串或非有限数都当 undefined（缺省 50）。
func parseLimit(raw string) (float64, bool) {
	if raw == "" {
		return 0, false
	}
	parsed, ok := jsNumber(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// clampLimit 对齐 exception-events.service.ts 的
// Math.max(1, Math.min(200, Math.floor(options.limit ?? 50))).
func clampLimit(value float64) int {
	floored := math.Floor(value)
	if floored > maxLimit {
		return maxLimit
	}
	if floored < 1 {
		return 1
	}
	return int(floored)
}

// clampOffset 对齐 Math.max(0, Math.floor(options.offset ?? 0)).
func clampOffset(value float64) int {
	floored := math.Floor(value)
	if floored < 0 {
		return 0
	}
	if floored > float64(math.MaxInt32) {
		return math.MaxInt32
	}
	return int(floored)
}

// normalizeTaskLogStatus 对齐 normalizeTaskLogStatus：trim 后空 → undefined；
// 不在四个枚举内 → 400。
func normalizeTaskLogStatus(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	switch value {
	case "pending", "processing", "completed", "failed":
		return value, nil
	}
	return "", &inputError{Message: "status must be one of pending, processing, completed, failed"}
}

// normalizeExceptionEventKind 对齐 normalizeExceptionEventKind（logs/* 的
// 严格版）：trim 后空 → undefined；不在三个枚举内 → 400。
func normalizeExceptionEventKind(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	switch value {
	case "http", "graphql", "unknown":
		return value, nil
	}
	return "", &inputError{Message: "kind must be one of http, graphql, unknown"}
}

// lenientExceptionEventKind 对齐 admin-errors.controller.ts：不做 trim，
// 不在三个枚举内一律当 undefined（返回空串），不报错。
func lenientExceptionEventKind(raw string) string {
	switch raw {
	case "http", "graphql", "unknown":
		return raw
	}
	return ""
}

// normalizeText 对齐 normalizeText：trim 后空 → undefined。
func normalizeText(raw string) string {
	return strings.TrimSpace(raw)
}

// messageContainsFilter 对齐 buildFilter 的 message 条件：trim 后先
// escapeRegex，再不区分大小写正则匹配。
func messageContainsFilter(messageContains string) bson.D {
	return bson.D{
		{Key: "$regex", Value: escapeRegex(messageContains)},
		{Key: "$options", Value: "i"},
	}
}

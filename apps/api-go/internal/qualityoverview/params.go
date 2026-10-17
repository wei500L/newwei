package qualityoverview

import (
	"math"
	"strconv"
	"strings"
)

// jsNumber 对齐 JS 的 Number(string)：允许前导/尾随空白、十进制科学计数、
// 0x/0b/0o 前缀与 Infinity/NaN；下划线一律拒绝（JS 会得到 NaN）。与
// internal/adminlogs 的同名实现逐条一致（纯数值解析，不是脱敏规则）。
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

// finiteNumber 对齐控制器里 `Number.isFinite(Number(raw))` 的宽松回退：
// 空串、非有限数（NaN/Infinity）都返回 ok=false，交由调用方走缺省值。
func finiteNumber(raw string) (float64, bool) {
	if raw == "" {
		return 0, false
	}
	parsed, ok := jsNumber(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// parseWindowOption 对齐控制器 `windowHours ? Number(windowHours) : undefined`
// 再经 `Number.isFinite(parsed) ? parsed : undefined`。返回 ok=false 表示
// 交给服务层缺省值（24 / 60）。
func parseWindowOption(raw string) (float64, bool) {
	return finiteNumber(raw)
}

// parseListLimit 对齐任务日志列表控制器的 limit 规则：
//
//	const raw = limit ? Number(limit) : 50;
//	Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : 50, 1), 200)
func parseListLimit(raw string) int {
	value := 50.0
	if parsed, ok := finiteNumber(raw); ok {
		value = math.Floor(parsed)
	}
	if value < 1 {
		return 1
	}
	if value > 200 {
		return 200
	}
	return int(value)
}

// parseSinceMinutes 对齐任务日志控制器的 sinceMinutes 规则：空串或非有限
// 数 → null；有限数 floor；仅当 > 0 时作为时间下界。返回 since 是否生效、
// 以及生效时的分钟数。
func parseSinceMinutes(raw string) (int, bool) {
	parsed, ok := finiteNumber(raw)
	if !ok {
		return 0, false
	}
	value := int(math.Floor(parsed))
	if value > 0 {
		return value, true
	}
	return value, false
}

// normalizeTaskLogStatus 对齐任务日志列表的宽松 status：trim 后不在四个
// 枚举内一律当 undefined（返回空串），不报 400。
func normalizeTaskLogStatus(raw string) string {
	switch strings.TrimSpace(raw) {
	case "pending", "processing", "completed", "failed":
		return strings.TrimSpace(raw)
	}
	return ""
}

// normalizeText 对齐控制器 `typeof x === "string" ? x.trim() || undefined
// : undefined`：trim 后空 → undefined（空串）。
func normalizeText(raw string) string {
	return strings.TrimSpace(raw)
}

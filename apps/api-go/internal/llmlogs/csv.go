package llmlogs

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// exportFilename / exportCSVHeaders 与 service 的 EXPORT_FILENAME /
// EXPORT_CSV_HEADERS 一致。
const exportFilename = "llm-logs-export.csv"

var exportCSVHeaders = []string{
	"timestamp",
	"model",
	"requestType",
	"status",
	"durationMs",
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"error",
}

// isoLayout 等价于 JS Date.prototype.toISOString() 的毫秒 UTC 形态
// （唯一差别是年份超过四位时的扩展形态，此处不涉及）。
const isoLayout = "2006-01-02T15:04:05.000Z"

var plainNumberPattern = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// exportRow 是 CSV 行构造的输入形态：CreatedAt 保持 Date 语义（nil 表示
// 缺失/非日期），其余按 Mongo 原值（字符串、数字或空）交给各列构造。
type exportRow struct {
	CreatedAt        *time.Time
	Model            any
	RequestType      any
	Status           any
	LatencyMs        any
	PromptTokens     any
	CompletionTokens any
	TotalTokens      any
	Error            any
}

// escapeCSVValue 逐段翻译 service 的 escapeCsvValue：
//
//   - null/undefined → 空串；
//   - 字符串：去掉前导空白后，若以 =、+、-、@ 开头且不是纯数字
//     （^-?\d+(\.\d+)?$），先在原字符串前加一个单引号 ' 再转义；
//   - 其余：JS String(value) 的形态（数字按 JS Number.toString 输出）；
//   - 最后：含 "、逗号、\n、\r 时用双引号包裹并把内部 " 变成 ""。
func escapeCSVValue(value any) string {
	text := ""
	switch typed := value.(type) {
	case nil:
		text = ""
	case string:
		text = typed
		trimmed := strings.TrimLeftFunc(typed, unicode.IsSpace)
		if startsWithFormulaChar(trimmed) && !plainNumberPattern.MatchString(trimmed) {
			// 递归一次：前缀 ' 之后不再是公式起始字符。
			return escapeCSVValue("'" + typed)
		}
	case float64:
		text = jsNumberString(typed)
	case int32:
		text = strconv.FormatInt(int64(typed), 10)
	case int64:
		text = strconv.FormatInt(typed, 10)
	default:
		text = fmt.Sprint(typed)
	}
	return quoteIfNeeded(text)
}

func startsWithFormulaChar(value string) bool {
	if value == "" {
		return false
	}
	switch value[0] {
	case '=', '+', '-', '@':
		return true
	default:
		return false
	}
}

func quoteIfNeeded(text string) string {
	if !strings.ContainsAny(text, "\",\n\r") {
		return text
	}
	return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
}

// jsNumberString 输出与 JS Number.prototype.toString 一致的十进制文本：
// 整数不带小数点；|x| >= 1e21 或 < 1e-6 用指数形式（指数不带前导零）。
func jsNumberString(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == 0:
		return "0"
	}
	abs := math.Abs(value)
	if abs < 1e-6 || abs >= 1e21 {
		return normalizeExponent(strconv.FormatFloat(value, 'e', -1, 64))
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// normalizeExponent 去掉 Go 指数形式里的前导零（1e-07 → 1e-7），与 JS
// Number.toString 的输出一致。
func normalizeExponent(text string) string {
	index := strings.IndexAny(text, "eE")
	if index < 0 {
		return text
	}
	mantissa := text[:index]
	exponent := text[index+1:]
	sign := ""
	if strings.HasPrefix(exponent, "+") || strings.HasPrefix(exponent, "-") {
		sign = exponent[:1]
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

// formatISO 等价于 JS Date.prototype.toISOString()；nil/零值按
// new Date(0) 输出（与 toExportCsvLine / toListItem 的兜底一致）。
func formatISO(value *time.Time) string {
	if value == nil || value.IsZero() {
		return time.Unix(0, 0).UTC().Format(isoLayout)
	}
	return value.UTC().Format(isoLayout)
}

// numericValue 对齐 JS Number(value) 的可转换子集。
func numericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int:
		return float64(typed), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// exportString 对齐 toExportCsvLine 里 `typeof x === "string" ? x : ""`。
func exportString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

// exportModel 对齐 `model.trim().length > 0 ? model : "unknown"`。
func exportModel(value any) string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "unknown"
	}
	return text
}

// exportDuration 对齐 `Math.max(0, Number(latencyMs ?? 0))`。
func exportDuration(value any) float64 {
	if value == nil {
		// latencyMs ?? 0。
		return 0
	}
	numeric, ok := numericValue(value)
	if !ok {
		// Number("abc") === NaN → Math.max(0, NaN) === NaN。
		return math.NaN()
	}
	return math.Max(0, numeric)
}

// exportNullableNumber 对齐 toCsvNullableNumber：null/undefined 或不可转
// 换 → null（CSV 里是空串）。
func exportNullableNumber(value any) any {
	if value == nil {
		return nil
	}
	numeric, ok := numericValue(value)
	if !ok {
		return nil
	}
	return numeric
}

// toExportCSVLine 与 service 的 toExportCsvLine 逐段一致。
func toExportCSVLine(row exportRow) string {
	values := []any{
		formatISO(row.CreatedAt),
		exportModel(row.Model),
		exportString(row.RequestType),
		exportString(row.Status),
		exportDuration(row.LatencyMs),
		exportNullableNumber(row.PromptTokens),
		exportNullableNumber(row.CompletionTokens),
		exportNullableNumber(row.TotalTokens),
		exportString(row.Error),
	}
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, escapeCSVValue(value))
	}
	return strings.Join(parts, ",")
}

// exportCSVHeaderLine 是固定表头行（与 service 的 yield 一致，末尾换行）。
func exportCSVHeaderLine() string {
	return strings.Join(exportCSVHeaders, ",") + "\n"
}

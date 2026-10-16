package adminlogs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// jsISOLayout 是 new Date().toISOString() 的等价格式（毫秒 UTC）。Go 的
// time.Time 默认 RFC3339Nano 小数位不同，必须显式转换。
const jsISOLayout = "2006-01-02T15:04:05.000Z"

func formatJSTime(value time.Time) string {
	return value.UTC().Format(jsISOLayout)
}

// ---- 有序、可省略字段的 JSON 对象（对齐 JS 对象字面量的键序与 undefined 省略） ----

type rawField struct {
	name   string
	absent bool
	value  any
}

// jsonObject 按声明顺序序列化；absent 的字段整键省略（等价于 JS 里值为
// undefined 的键被 JSON.stringify 丢弃）。
type jsonObject []rawField

func (o jsonObject) MarshalJSON() ([]byte, error) {
	var builder bytes.Buffer
	builder.WriteByte('{')
	first := true
	for _, field := range o {
		if field.absent {
			continue
		}
		if !first {
			builder.WriteByte(',')
		}
		first = false
		builder.WriteString(strconv.Quote(field.name))
		builder.WriteByte(':')
		encoded, err := json.Marshal(field.value)
		if err != nil {
			return nil, err
		}
		builder.Write(encoded)
	}
	builder.WriteByte('}')
	return builder.Bytes(), nil
}

func field(name string, value any) rawField {
	return rawField{name: name, value: value}
}

func optionalField(name string, present bool, value any) rawField {
	return rawField{name: name, absent: !present, value: value}
}

// ---- 取值助手（对齐 JS 的 String(x ?? fallback) 与 ?? undefined） ----

func stringOrDefault(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func stringOrEmpty(value any) string {
	return stringOrDefault(value, "")
}

// jsonStringOrUnknown 对齐 String(x ?? "unknown")。
func jsonStringOrUnknown(value any) any {
	if value == nil {
		return "unknown"
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

// nonNullString 对齐 value ?? undefined：仅 nil（null/缺失）时省略。
func nonNullString(value any) (string, bool) {
	if value == nil {
		return "", false
	}
	if text, ok := value.(string); ok {
		return text, true
	}
	return fmt.Sprint(value), true
}

// serializeDate 对齐 admin-logs.service.ts 的 serializeDate：Date 走
// toISOString；非空字符串能解析则走 ISO、不能解析则原样返回；其余 null。
func serializeDate(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case time.Time:
		if typed.IsZero() {
			return nil
		}
		return formatJSTime(typed)
	case bson.DateTime:
		return formatJSTime(typed.Time())
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		if parsed, ok := parseLooseTime(trimmed); ok {
			return formatJSTime(parsed)
		}
		return typed
	default:
		return nil
	}
}

// taskLogID 对齐 mapTaskLog 的 id 计算：
//
//	rawId && typeof rawId === "object" && "toString" in rawId
//	  ? rawId.toString()
//	  : String(rawId ?? `${queue}:${jobId}:${stage}`)
func taskLogID(document bson.M) string {
	rawID := document["_id"]
	if rawID != nil {
		switch typed := rawID.(type) {
		case bson.ObjectID:
			return typed.Hex()
		case string:
			return typed
		}
		if _, isStringer := rawID.(fmt.Stringer); isStringer {
			return fmt.Sprint(rawID)
		}
	}
	fallback := stringOrDefault(document["queue"], "queue") + ":" +
		stringOrDefault(document["jobId"], "job") + ":" +
		stringOrDefault(document["stage"], "stage")
	if rawID == nil {
		return fallback
	}
	return stringOrDefault(rawID, fallback)
}

// ---- 响应形状 ----

type paginatedTaskLogs struct {
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
	Total    int            `json:"total"`
	Items    []jsonObject   `json:"items"`
	Summary  taskLogSummary `json:"summary"`
}

type taskLogSummary struct {
	Totals    taskLogTotals  `json:"totals"`
	ByStage   []stageCount   `json:"byStage"`
	TopErrors []taskTopError `json:"topErrors"`
}

type taskLogTotals struct {
	Total      int `json:"total"`
	Pending    int `json:"pending"`
	Processing int `json:"processing"`
	Completed  int `json:"completed"`
	Failed     int `json:"failed"`
}

type stageCount struct {
	Stage string `json:"stage"`
	Count int    `json:"count"`
}

type taskTopError struct {
	Queue         string `json:"queue"`
	Stage         string `json:"stage"`
	ErrorName     string `json:"errorName"`
	SampleMessage any    `json:"sampleMessage"`
	Count         int    `json:"count"`
}

type paginatedExceptionEvents struct {
	Page     int          `json:"page"`
	PageSize int          `json:"pageSize"`
	Total    int          `json:"total"`
	Items    []jsonObject `json:"items"`
}

type exceptionEventList struct {
	Total int          `json:"total"`
	Items []jsonObject `json:"items"`
}

type exceptionStats struct {
	Total  int         `json:"total"`
	ByKind []kindCount `json:"byKind"`
	ByDay  []dayCount  `json:"byDay"`
}

type kindCount struct {
	Kind  string `json:"kind"`
	Count int    `json:"count"`
}

type dayCount struct {
	Date  any `json:"date"`
	Count int `json:"count"`
}

type paginatedAuditLogs struct {
	Page     int          `json:"page"`
	PageSize int          `json:"pageSize"`
	Total    int          `json:"total"`
	Items    []jsonObject `json:"items"`
}

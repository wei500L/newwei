package llmlogs

import (
	"encoding/base64"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Mongo 集合名是 Mongoose 8 对 model 名 LlmRequestLog 的默认复数化结果。
const llmRequestLogsCollection = "llmrequestlogs"

// ---- 列表 ----

// metadataPolicy 对齐 LlmRequestLogMetadataPolicySummary。
type metadataPolicy struct {
	Source                  string   `json:"source"`
	AllowedTopLevelKeys     []string `json:"allowedTopLevelKeys"`
	AllowedTopLevelPrefixes []string `json:"allowedTopLevelPrefixes"`
	KeyCount                int      `json:"keyCount"`
	PrefixCount             int      `json:"prefixCount"`
}

// listItem 对齐 LlmRequestLogListItem / toListItem 的字段与顺序。
type listItem struct {
	ID                        string   `json:"id"`
	OrgID                     string   `json:"orgId"`
	RequestType               string   `json:"requestType"`
	Model                     string   `json:"model"`
	Status                    string   `json:"status"`
	PromptTokens              *float64 `json:"promptTokens"`
	CompletionTokens          *float64 `json:"completionTokens"`
	TotalTokens               *float64 `json:"totalTokens"`
	CostUSD                   *float64 `json:"costUsd"`
	Feature                   *string  `json:"feature"`
	GatewayProfileID          *string  `json:"gatewayProfileId"`
	GovernanceApplied         *bool    `json:"governanceApplied"`
	AuthMode                  *string  `json:"authMode"`
	GovernanceTargetProfileID *string  `json:"governanceTargetProfileId"`
	LatencyMs                 float64  `json:"latencyMs"`
	Error                     *string  `json:"error"`
	Metadata                  any      `json:"metadata"`
	APISurface                *string  `json:"apiSurface"`
	CreatedAt                 string   `json:"createdAt"`
	UpdatedAt                 string   `json:"updatedAt"`
}

type listResponse struct {
	Page           int            `json:"page"`
	PageSize       int            `json:"pageSize"`
	Total          int64          `json:"total"`
	Items          []listItem     `json:"items"`
	MetadataPolicy metadataPolicy `json:"metadataPolicy"`
}

// logRow 是 llmrequestlogs 的一行。可空字段用 bson.RawValue 是为了保留
// Mongoose 的 null 与「字段缺失（undefined）」的区别——toNullableNumber
// 对 null 得 Number(null)=0，对 undefined 得 Number(undefined)=NaN→null。
type logRow struct {
	ID                        bson.RawValue `bson:"_id"`
	OrgID                     string        `bson:"orgId"`
	RequestType               string        `bson:"requestType"`
	Model                     string        `bson:"model"`
	Status                    string        `bson:"status"`
	PromptTokens              bson.RawValue `bson:"promptTokens"`
	CompletionTokens          bson.RawValue `bson:"completionTokens"`
	TotalTokens               bson.RawValue `bson:"totalTokens"`
	CostUSD                   bson.RawValue `bson:"costUsd"`
	Feature                   bson.RawValue `bson:"feature"`
	GatewayProfileID          bson.RawValue `bson:"gatewayProfileId"`
	GovernanceApplied         bson.RawValue `bson:"governanceApplied"`
	AuthMode                  bson.RawValue `bson:"authMode"`
	GovernanceTargetProfileID bson.RawValue `bson:"governanceTargetProfileId"`
	LatencyMs                 bson.RawValue `bson:"latencyMs"`
	Error                     bson.RawValue `bson:"error"`
	Metadata                  bson.RawValue `bson:"metadata"`
	APISurface                bson.RawValue `bson:"apiSurface"`
	CreatedAt                 bson.RawValue `bson:"createdAt"`
	UpdatedAt                 bson.RawValue `bson:"updatedAt"`
}

func toListItem(row logRow) listItem {
	metadata := normalizeBSONValue(rawAnyOrNil(row.Metadata))
	return listItem{
		ID:                        objectIDString(row.ID),
		OrgID:                     row.OrgID,
		RequestType:               row.RequestType,
		Model:                     row.Model,
		Status:                    row.Status,
		PromptTokens:              nullableNumber(row.PromptTokens),
		CompletionTokens:          nullableNumber(row.CompletionTokens),
		TotalTokens:               nullableNumber(row.TotalTokens),
		CostUSD:                   nullableNumber(row.CostUSD),
		Feature:                   resolveRowFeature(row.Feature, metadata),
		GatewayProfileID:          profileIDOrNil(row.GatewayProfileID),
		GovernanceApplied:         boolOrNil(row.GovernanceApplied),
		AuthMode:                  authModeOrNil(row.AuthMode),
		GovernanceTargetProfileID: profileIDOrNil(row.GovernanceTargetProfileID),
		LatencyMs:                 latencyOf(row.LatencyMs),
		Error:                     errorOrNil(row.Error),
		Metadata:                  metadata,
		APISurface:                apiSurfaceOrNil(row.APISurface),
		CreatedAt:                 formatISO(rawTimeOrNil(row.CreatedAt)),
		UpdatedAt:                 formatISO(rawTimeOrNil(row.UpdatedAt)),
	}
}

// ---- 导出 ----

// exportDoc 是导出查询的投影行（EXPORT_PROJECTION）。
type exportDoc struct {
	CreatedAt        bson.RawValue `bson:"createdAt"`
	Model            bson.RawValue `bson:"model"`
	RequestType      bson.RawValue `bson:"requestType"`
	Status           bson.RawValue `bson:"status"`
	LatencyMs        bson.RawValue `bson:"latencyMs"`
	PromptTokens     bson.RawValue `bson:"promptTokens"`
	CompletionTokens bson.RawValue `bson:"completionTokens"`
	TotalTokens      bson.RawValue `bson:"totalTokens"`
	Error            bson.RawValue `bson:"error"`
}

// toExportRow 映射到 toExportCsvLine 的输入形态：日期保持 Date 语义、
// 其余按原值交给 CSV 列构造（字符串/数字/空）。
func toExportRow(doc exportDoc) exportRow {
	return exportRow{
		CreatedAt:        rawTimeOrNil(doc.CreatedAt),
		Model:            rawAnyOrNil(doc.Model),
		RequestType:      rawAnyOrNil(doc.RequestType),
		Status:           rawAnyOrNil(doc.Status),
		LatencyMs:        rawAnyOrNil(doc.LatencyMs),
		PromptTokens:     rawAnyOrNil(doc.PromptTokens),
		CompletionTokens: rawAnyOrNil(doc.CompletionTokens),
		TotalTokens:      rawAnyOrNil(doc.TotalTokens),
		Error:            rawAnyOrNil(doc.Error),
	}
}

// ---- 汇总 ----

type usageTotals struct {
	RequestCount     int64   `json:"requestCount"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	TotalTokens      int64   `json:"totalTokens"`
	CostUSD          float64 `json:"costUsd"`
	AvgLatencyMs     float64 `json:"avgLatencyMs"`
}

type usageModelRow struct {
	Model string `json:"model"`
	usageTotals
}

type usageDayRow struct {
	Date string `json:"date"`
	usageTotals
}

type usageStatusBreakdown struct {
	Success     int64   `json:"success"`
	Error       int64   `json:"error"`
	SuccessRate float64 `json:"successRate"`
	ErrorRate   float64 `json:"errorRate"`
}

type usageGovernanceBreakdown struct {
	GovernedRequestCount          int64   `json:"governedRequestCount"`
	DirectRequestCount            int64   `json:"directRequestCount"`
	GovernedCostUSD               float64 `json:"governedCostUsd"`
	DirectCostUSD                 float64 `json:"directCostUsd"`
	ManagedRuntimeKeyRequestCount int64   `json:"managedRuntimeKeyRequestCount"`
	ProfileKeyRequestCount        int64   `json:"profileKeyRequestCount"`
}

type usageLatency struct {
	AvgMs float64  `json:"avgMs"`
	P95Ms *float64 `json:"p95Ms"`
}

type usageTopError struct {
	Message string `json:"message"`
	Count   int64  `json:"count"`
}

type summaryResponse struct {
	Totals              usageTotals              `json:"totals"`
	StatusBreakdown     usageStatusBreakdown     `json:"statusBreakdown"`
	GovernanceBreakdown usageGovernanceBreakdown `json:"governanceBreakdown"`
	Latency             usageLatency             `json:"latency"`
	TopErrors           []usageTopError          `json:"topErrors"`
	ByModel             []usageModelRow          `json:"byModel"`
	ByDay               []usageDayRow            `json:"byDay"`
}

// 聚合结果行。字段用 any + safeNumber/safeInteger 转换，与 JS 的
// Number()/Math.trunc 语义一致（null → 0、undefined → 0）。
type usageAggRow struct {
	RequestCount     any `bson:"requestCount"`
	PromptTokens     any `bson:"promptTokens"`
	CompletionTokens any `bson:"completionTokens"`
	TotalTokens      any `bson:"totalTokens"`
	CostUSD          any `bson:"costUsd"`
	TotalLatencyMs   any `bson:"totalLatencyMs"`
}

type usageModelAggRow struct {
	ID               any `bson:"_id"`
	RequestCount     any `bson:"requestCount"`
	PromptTokens     any `bson:"promptTokens"`
	CompletionTokens any `bson:"completionTokens"`
	TotalTokens      any `bson:"totalTokens"`
	CostUSD          any `bson:"costUsd"`
	TotalLatencyMs   any `bson:"totalLatencyMs"`
}

type usageDayAggRow struct {
	ID               any `bson:"_id"`
	RequestCount     any `bson:"requestCount"`
	PromptTokens     any `bson:"promptTokens"`
	CompletionTokens any `bson:"completionTokens"`
	TotalTokens      any `bson:"totalTokens"`
	CostUSD          any `bson:"costUsd"`
	TotalLatencyMs   any `bson:"totalLatencyMs"`
}

type usageStatusAggRow struct {
	ID    any `bson:"_id"`
	Count any `bson:"count"`
}

type usageGovernanceAggRow struct {
	GovernedRequestCount          any `bson:"governedRequestCount"`
	DirectRequestCount            any `bson:"directRequestCount"`
	GovernedCostUSD               any `bson:"governedCostUsd"`
	DirectCostUSD                 any `bson:"directCostUsd"`
	ManagedRuntimeKeyRequestCount any `bson:"managedRuntimeKeyRequestCount"`
	ProfileKeyRequestCount        any `bson:"profileKeyRequestCount"`
}

type usageErrorAggRow struct {
	ID    any `bson:"_id"`
	Count any `bson:"count"`
}

type latencyAggRow struct {
	LatencyMs any `bson:"latencyMs"`
}

// ---- bson → JSON 友好形态 ----

// normalizeBSONValue 把 BSON 文档转成 json.Marshal 友好的形态（bson.D/
// bson.M/bson.A → map/slice，ObjectID → hex，DateTime → time.Time）。
func normalizeBSONValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case bson.D:
		out := make(map[string]any, len(typed))
		for _, element := range typed {
			out[element.Key] = normalizeBSONValue(element.Value)
		}
		return out
	case bson.M:
		out := make(map[string]any, len(typed))
		for key, element := range typed {
			out[key] = normalizeBSONValue(element)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, element := range typed {
			out[key] = normalizeBSONValue(element)
		}
		return out
	case bson.A:
		out := make([]any, 0, len(typed))
		for _, element := range typed {
			out = append(out, normalizeBSONValue(element))
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, element := range typed {
			out = append(out, normalizeBSONValue(element))
		}
		return out
	case bson.ObjectID:
		return typed.Hex()
	case bson.DateTime:
		return typed.Time().UTC()
	case bson.Decimal128:
		return typed.String()
	case bson.Binary:
		return base64.StdEncoding.EncodeToString(typed.Data)
	case []byte:
		return base64.StdEncoding.EncodeToString(typed)
	default:
		return value
	}
}

// ---- RawValue 取值助手 ----

func rawAbsentValue(value bson.RawValue) bool {
	return value.IsZero() || value.Type == bson.TypeNull || value.Type == bson.TypeUndefined
}

// rawAnyOrNil 对缺失/null/undefined 返回 nil，其余交给 default decoder。
func rawAnyOrNil(value bson.RawValue) any {
	if rawAbsentValue(value) {
		return nil
	}
	var decoded any
	if err := value.Unmarshal(&decoded); err != nil {
		return nil
	}
	return decoded
}

func rawTimeOrNil(value bson.RawValue) *time.Time {
	if rawAbsentValue(value) {
		return nil
	}
	if value.Type != bson.TypeDateTime {
		return nil
	}
	var parsed time.Time
	if err := value.Unmarshal(&parsed); err != nil {
		return nil
	}
	utc := parsed.UTC()
	return &utc
}

func objectIDString(value bson.RawValue) string {
	if value.Type == bson.TypeObjectID {
		var id bson.ObjectID
		if err := value.Unmarshal(&id); err == nil {
			return id.Hex()
		}
	}
	if value.Type == bson.TypeString {
		var text string
		if err := value.Unmarshal(&text); err == nil {
			return text
		}
	}
	return ""
}

// nullableNumber 对齐 toNullableNumber：null → Number(null)=0；
// undefined → null；不可转换 → null。
func nullableNumber(value bson.RawValue) *float64 {
	// Type == 0 即 RawValue 的零值：字段在文档里不存在（undefined）。
	if value.Type == 0 || value.Type == bson.TypeUndefined {
		return nil
	}
	numeric, ok := jsNumberFromRaw(value)
	if !ok {
		return nil
	}
	return &numeric
}

// latencyOf 对齐 Math.max(0, Number(row.latencyMs ?? 0))。
func latencyOf(value bson.RawValue) float64 {
	numeric, ok := jsNumberFromRaw(value)
	if !ok {
		return 0
	}
	if numeric < 0 {
		return 0
	}
	return numeric
}

func jsNumberFromRaw(value bson.RawValue) (float64, bool) {
	decoded := rawAnyOrNil(value)
	if decoded == nil {
		// Number(null) === 0。
		return 0, true
	}
	return safeNumber(decoded)
}

func profileIDOrNil(value bson.RawValue) *string {
	if value.Type != bson.TypeString {
		return nil
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return nil
	}
	return normalizeProfileIDValue(text)
}

func boolOrNil(value bson.RawValue) *bool {
	if value.Type != bson.TypeBoolean {
		return nil
	}
	var parsed bool
	if err := value.Unmarshal(&parsed); err != nil {
		return nil
	}
	return &parsed
}

func authModeOrNil(value bson.RawValue) *string {
	if value.Type != bson.TypeString {
		return nil
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return nil
	}
	if text == "managed_runtime_key" || text == "profile_key" {
		return &text
	}
	return nil
}

func apiSurfaceOrNil(value bson.RawValue) *string {
	if value.Type != bson.TypeString {
		return nil
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return nil
	}
	switch text {
	case "chat_completions", "responses", "embeddings", "rerank":
		return &text
	default:
		return nil
	}
}

// errorOrNil 对齐 `typeof row.error === "string" ? row.error : null`
// （不 trim、不截断）。
func errorOrNil(value bson.RawValue) *string {
	if value.Type != bson.TypeString {
		return nil
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return nil
	}
	return &text
}

// resolveRowFeature 对齐
// normalizeFeatureToken(row.feature) ?? resolveFeatureFromMetadata(...) ?? null。
func resolveRowFeature(value bson.RawValue, metadata any) *string {
	if value.Type == bson.TypeString {
		var text string
		if err := value.Unmarshal(&text); err == nil {
			if token := normalizeFeatureTokenValue(text); token != "" {
				return &token
			}
		}
	}
	if record, ok := metadata.(map[string]any); ok {
		for _, key := range []string{"feature", "source", "module"} {
			text, ok := record[key].(string)
			if !ok {
				continue
			}
			if token := normalizeFeatureTokenValue(text); token != "" {
				return &token
			}
		}
	}
	return nil
}

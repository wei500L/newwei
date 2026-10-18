package llmlogs

import (
	"context"
	"database/sql"
	"math"
	"strings"
	"time"
	"unicode/utf16"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// 本文件只新增 LLM request log 的写入能力，供简报等同步生成路径按每次真实
// 模型尝试落一行 llmrequestlogs。既有列表/汇总/导出查询与设置 CRUD 不变。
// 字段、归一化与 metadata 过滤对齐
// apps/api/src/modules/news-pipeline/llm-request-log.service.ts。

const (
	completionRequestType       = "completion"
	completionStatusSuccess     = "success"
	completionStatusError       = "error"
	completionUnknownOrgID      = "_unknown_"
	completionUnknownModel      = "unknown"
	maxCompletionErrorLength    = 1000
	maxProfileIDLength          = 128
	maxFeatureTokenLength       = 64
	maxMetadataStringLength     = 500
	maxMetadataObjectKeys       = 40
	maxMetadataSerializedLength = 8192
)

// CompletionUsage 是一次模型调用的 token/成本。网关未上报的值为 nil，
// 不会写成 0。
type CompletionUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// CompletionMetadata 是模型请求 metadata。写入 Mongo 前按
// llm_request_log_settings 的 allowlist/prefix/长度策略过滤；默认策略只保留
// feature。
type CompletionMetadata struct {
	Feature    string `json:"feature"`
	EventTitle string `json:"eventTitle"`
	Sources    int    `json:"sources"`
}

// CompletionLogEntry 是一次真实模型尝试的日志输入。调用方（简报路径）按每次
// HTTP 尝试构造一条。
type CompletionLogEntry struct {
	OrgID                     string
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     CompletionUsage
	Feature                   string
	GatewayProfileID          string
	GovernanceApplied         *bool
	AuthMode                  string
	GovernanceTargetProfileID string
	APISurface                string
	Metadata                  *CompletionMetadata
	OccurredAt                time.Time
}

// CompletionWriter 写入 llmrequestlogs。写失败是 best effort：调用方记录
// warning 后继续，不使已生成的简报失败。
type CompletionWriter struct {
	service *Service
}

// NewCompletionWriter 复用既有 *sql.DB 与 Mongo 连接，不新开连接池。
func NewCompletionWriter(db *sql.DB, mongoDatabase *mongo.Database) *CompletionWriter {
	return &CompletionWriter{service: NewService(db, mongoDatabase)}
}

// completionLogDocument 是 llmrequestlogs 的一行。String/Number 字段显式写
// null，与 Mongoose 的 default null 一致；metadata 为空时写 null。
type completionLogDocument struct {
	ID                        bson.ObjectID `bson:"_id"`
	OrgID                     string        `bson:"orgId"`
	RequestType               string        `bson:"requestType"`
	Model                     string        `bson:"model"`
	Status                    string        `bson:"status"`
	PromptTokens              *float64      `bson:"promptTokens"`
	CompletionTokens          *float64      `bson:"completionTokens"`
	TotalTokens               *float64      `bson:"totalTokens"`
	CostUSD                   *float64      `bson:"costUsd"`
	Feature                   *string       `bson:"feature"`
	GatewayProfileID          *string       `bson:"gatewayProfileId"`
	GovernanceApplied         *bool         `bson:"governanceApplied"`
	AuthMode                  *string       `bson:"authMode"`
	GovernanceTargetProfileID *string       `bson:"governanceTargetProfileId"`
	LatencyMS                 float64       `bson:"latencyMs"`
	Error                     *string       `bson:"error"`
	Metadata                  *bson.D       `bson:"metadata"`
	APISurface                *string       `bson:"apiSurface"`
	CreatedAt                 time.Time     `bson:"createdAt"`
	UpdatedAt                 time.Time     `bson:"updatedAt"`
}

// WriteAttempt 落一行日志。Mongo 未配置或插入失败都返回 error，由调用方按
// best effort 记录 warning。
func (w *CompletionWriter) WriteAttempt(ctx context.Context, entry CompletionLogEntry) error {
	if w == nil || w.service == nil {
		return errMongoUnavailable
	}
	collection, err := w.service.collection()
	if err != nil {
		return err
	}
	metadata := w.service.filterCompletionMetadata(ctx, entry.Metadata)
	created := entry.OccurredAt.UTC()
	if created.IsZero() {
		created = nowMillis()
	} else {
		created = created.Truncate(time.Millisecond)
	}
	document := completionLogDocument{
		ID:                        bson.NewObjectID(),
		OrgID:                     normalizeCompletionOrgID(entry.OrgID),
		RequestType:               completionRequestType,
		Model:                     normalizeCompletionModel(entry.Model),
		Status:                    normalizeCompletionStatus(entry.Status),
		PromptTokens:              finiteOrNil(entry.Usage.PromptTokens),
		CompletionTokens:          finiteOrNil(entry.Usage.CompletionTokens),
		TotalTokens:               finiteOrNil(entry.Usage.TotalTokens),
		CostUSD:                   finiteOrNil(entry.Usage.CostUSD),
		Feature:                   completionFeatureToken(entry.Feature, entry.Metadata),
		GatewayProfileID:          normalizeLogProfileID(entry.GatewayProfileID),
		GovernanceApplied:         entry.GovernanceApplied,
		AuthMode:                  normalizeAuthMode(entry.AuthMode),
		GovernanceTargetProfileID: normalizeLogProfileID(entry.GovernanceTargetProfileID),
		LatencyMS:                 normalizeLatencyMS(entry.Latency),
		Error:                     normalizeCompletionError(entry.Status, entry.Error),
		Metadata:                  metadata,
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

func normalizeCompletionOrgID(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return completionUnknownOrgID
	}
	return trimmed
}

func normalizeCompletionModel(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return completionUnknownModel
	}
	return trimmed
}

func normalizeCompletionStatus(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), completionStatusSuccess) {
		return completionStatusSuccess
	}
	return completionStatusError
}

func finiteOrNil(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	copy := *value
	return &copy
}

func normalizeLogProfileID(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > maxProfileIDLength {
		return nil
	}
	return &trimmed
}

func normalizeAuthMode(value string) *string {
	switch strings.TrimSpace(value) {
	case "profile_key":
		mode := "profile_key"
		return &mode
	case "managed_runtime_key":
		mode := "managed_runtime_key"
		return &mode
	default:
		return nil
	}
}

func normalizeLatencyMS(value time.Duration) float64 {
	millis := float64(value) / float64(time.Millisecond)
	if math.IsNaN(millis) || math.IsInf(millis, 0) || millis < 0 {
		return 0
	}
	return math.Trunc(millis)
}

func normalizeCompletionError(status, value string) *string {
	if !strings.EqualFold(strings.TrimSpace(status), completionStatusError) {
		return nil
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if jsLength(trimmed) > maxCompletionErrorLength {
		trimmed = truncateUTF16(trimmed, maxCompletionErrorLength)
	}
	return &trimmed
}

func optionalTrimmed(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// completionFeatureToken mirrors normalizeFeatureToken followed by
// resolveFeatureFromMetadata: an explicit feature wins, otherwise the
// policy-filtered metadata feature/source/module is used.
func completionFeatureToken(value string, metadata *CompletionMetadata) *string {
	if token := normalizeFeatureToken(value); token != nil {
		return token
	}
	if metadata == nil {
		return nil
	}
	if token := normalizeFeatureToken(metadata.Feature); token != nil {
		return token
	}
	return nil
}

func normalizeFeatureToken(value string) *string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" || jsLength(trimmed) > maxFeatureTokenLength {
		return nil
	}
	if !featureTokenPattern.MatchString(trimmed) {
		return nil
	}
	return &trimmed
}

// filterCompletionMetadata applies the llm_request_log_settings allowlist,
// prefix and length policy. It returns nil when nothing survives, which stores
// BSON null exactly like Nest's normalizeMetadata.
func (s *Service) filterCompletionMetadata(ctx context.Context, metadata *CompletionMetadata) *bson.D {
	if s == nil || metadata == nil {
		return nil
	}
	policy := s.MetadataPolicy(ctx)
	allowed := make(map[string]struct{}, len(policy.AllowedTopLevelKeys))
	for _, key := range policy.AllowedTopLevelKeys {
		allowed[key] = struct{}{}
	}
	kept := bson.D{}
	for _, entry := range metadata.entries() {
		key := normalizeMetadataKey(entry.Key)
		if key == "" {
			continue
		}
		if !metadataKeyAllowed(key, allowed, policy.AllowedTopLevelPrefixes) {
			continue
		}
		value, ok := entry.bsonValue()
		if !ok {
			continue
		}
		kept = append(kept, bson.E{Key: key, Value: value})
		if len(kept) >= maxMetadataObjectKeys {
			break
		}
	}
	if len(kept) == 0 {
		return nil
	}
	if serializedLength(kept) > maxMetadataSerializedLength {
		kept = compactCompletionMetadata(kept, len(kept))
	}
	return &kept
}

func metadataKeyAllowed(key string, allowed map[string]struct{}, prefixes []string) bool {
	if _, ok := allowed[key]; ok {
		return true
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

// completionMetadataEntry 是过滤前的一个具名 metadata 叶子。
type completionMetadataEntry struct {
	Key    string
	Text   *string
	Number *float64
}

// entries 按模型请求 metadata 的字段顺序返回，保证写入顺序稳定。
func (m CompletionMetadata) entries() []completionMetadataEntry {
	feature := m.Feature
	title := m.EventTitle
	sources := float64(m.Sources)
	return []completionMetadataEntry{
		{Key: "feature", Text: &feature},
		{Key: "eventTitle", Text: &title},
		{Key: "sources", Number: &sources},
	}
}

func (e completionMetadataEntry) bsonValue() (any, bool) {
	if e.Text != nil {
		text := *e.Text
		if jsLength(text) > maxMetadataStringLength {
			text = truncateUTF16(text, maxMetadataStringLength) + "...[truncated]"
		}
		return text, true
	}
	if e.Number != nil {
		number := *e.Number
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return nil, false
		}
		return number, true
	}
	return nil, false
}

// metadataPriorityKeys mirrors METADATA_PRIORITY_KEYS.
var metadataPriorityKeys = []string{
	"traceid", "requestid", "correlationid", "taskid", "jobid", "module",
	"feature", "source", "operation", "pipeline", "provider", "attempt",
	"retry", "stage", "tags",
}

func compactCompletionMetadata(kept bson.D, originalKeyCount int) bson.D {
	compact := bson.D{}
	present := make(map[string]bson.E, len(kept))
	for _, item := range kept {
		present[item.Key] = item
	}
	for _, key := range metadataPriorityKeys {
		if item, ok := present[key]; ok {
			compact = append(compact, item)
		}
	}
	if len(compact) == 0 {
		for index, item := range kept {
			if index >= 5 {
				break
			}
			compact = append(compact, item)
		}
	}
	retained := int32(len(compact))
	compact = append(compact,
		bson.E{Key: "_truncated", Value: true},
		bson.E{Key: "_originalKeyCount", Value: int32(originalKeyCount)},
		bson.E{Key: "_retainedKeyCount", Value: retained},
	)
	if serializedLength(compact) > maxMetadataSerializedLength {
		return bson.D{
			{Key: "_truncated", Value: true},
			{Key: "_originalKeyCount", Value: int32(originalKeyCount)},
			{Key: "_retainedKeyCount", Value: int32(0)},
		}
	}
	return compact
}

func serializedLength(document bson.D) int {
	raw, err := bson.Marshal(document)
	if err != nil {
		return 0
	}
	return len(raw)
}

// truncateUTF16 mirrors String.prototype.slice for a positive limit.
func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if limit >= len(units) {
		return value
	}
	if limit < 0 {
		limit = 0
	}
	return string(utf16.Decode(units[:limit]))
}

// normalizeMetadataKey 对齐 Nest normalizeMetadataKey：trim + 小写，空串丢弃，
// 超过 64 个 UTF-16 单元截断。
func normalizeMetadataKey(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" {
		return ""
	}
	if jsLength(trimmed) > maxMetadataKeyLength {
		trimmed = truncateUTF16(trimmed, maxMetadataKeyLength)
	}
	return trimmed
}

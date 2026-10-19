package llmlogs

import (
	"context"
	"database/sql"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// 本文件只新增知识图谱自动构建的 LLM request log 写入能力：每次真实模型尝试
// 落一行 llmrequestlogs，metadata 使用知识图谱自己的 task/orgId/articleId
// 叶子。既有简报、RSS 翻译、网关探测写入与列表/汇总/导出查询不变。

// KGCompletionMetadata 是知识图谱模型请求 metadata，写入 Mongo 前按
// llm_request_log_settings 的 allowlist/prefix/长度策略过滤。默认策略不含
// task/orgid/articleid，因此默认情况下 metadata 落 null，与 Nest 一致。
type KGCompletionMetadata struct {
	Task      string `json:"task"`
	OrgID     string `json:"orgId"`
	ArticleID string `json:"articleId"`
}

// KGCompletionLogEntry 是知识图谱一次真实模型尝试的日志输入。
type KGCompletionLogEntry struct {
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
	Metadata                  *KGCompletionMetadata
	OccurredAt                time.Time
}

// KGCompletionWriter 写入 llmrequestlogs。写失败是 best effort：调用方记录
// warning 后继续，不使知识图谱构建失败。
type KGCompletionWriter struct {
	service *Service
}

// NewKGCompletionWriter 复用既有 *sql.DB 与 Mongo 连接，不新开连接池。
func NewKGCompletionWriter(db *sql.DB, mongoDatabase *mongo.Database) *KGCompletionWriter {
	return &KGCompletionWriter{service: NewService(db, mongoDatabase)}
}

// kgCompletionLogDocument 是 llmrequestlogs 的一行。字段与其他写入路径保持
// 同一形状；String/Number 字段显式写 null，metadata 为空时写 null。
type kgCompletionLogDocument struct {
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
func (w *KGCompletionWriter) WriteAttempt(ctx context.Context, entry KGCompletionLogEntry) error {
	if w == nil || w.service == nil {
		return errMongoUnavailable
	}
	collection, err := w.service.collection()
	if err != nil {
		return err
	}
	created := entry.OccurredAt.UTC()
	if created.IsZero() {
		created = nowMillis()
	} else {
		created = created.Truncate(time.Millisecond)
	}
	document := kgCompletionLogDocument{
		ID:                        bson.NewObjectID(),
		OrgID:                     normalizeCompletionOrgID(entry.OrgID),
		RequestType:               completionRequestType,
		Model:                     normalizeCompletionModel(entry.Model),
		Status:                    normalizeCompletionStatus(entry.Status),
		PromptTokens:              finiteOrNil(entry.Usage.PromptTokens),
		CompletionTokens:          finiteOrNil(entry.Usage.CompletionTokens),
		TotalTokens:               finiteOrNil(entry.Usage.TotalTokens),
		CostUSD:                   finiteOrNil(entry.Usage.CostUSD),
		Feature:                   normalizeFeatureToken(entry.Feature),
		GatewayProfileID:          normalizeLogProfileID(entry.GatewayProfileID),
		GovernanceApplied:         entry.GovernanceApplied,
		AuthMode:                  normalizeAuthMode(entry.AuthMode),
		GovernanceTargetProfileID: normalizeLogProfileID(entry.GovernanceTargetProfileID),
		LatencyMS:                 normalizeLatencyMS(entry.Latency),
		Error:                     normalizeCompletionError(entry.Status, entry.Error),
		Metadata:                  w.service.filterKGCompletionMetadata(ctx, entry.Metadata),
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

// entries 按模型请求 metadata 的字段顺序返回，保证写入顺序稳定。
func (m KGCompletionMetadata) entries() []metadataEntry {
	task := m.Task
	orgID := m.OrgID
	articleID := m.ArticleID
	return []metadataEntry{
		{Key: "task", Text: &task},
		{Key: "orgid", Text: &orgID},
		{Key: "articleid", Text: &articleID},
	}
}

// filterKGCompletionMetadata applies the same llm_request_log_settings
// allowlist, prefix and length policy as every other typed log writer. It
// returns nil when nothing survives, which stores BSON null exactly like Nest's
// normalizeMetadata.
func (s *Service) filterKGCompletionMetadata(ctx context.Context, metadata *KGCompletionMetadata) *bson.D {
	if s == nil || metadata == nil {
		return nil
	}
	return s.filterMetadataEntries(ctx, metadata.entries())
}

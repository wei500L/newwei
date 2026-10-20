package llmlogs

import (
	"context"
	"database/sql"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// 本文件只新增 Frontier LLM 判定/学习的请求日志写入能力：每次真实模型尝试
// 落一行 llmrequestlogs，metadata 使用调用方给出的有序叶子，写入前仍按
// llm_request_log_settings 的 allowlist/prefix/长度策略过滤。既有简报、RSS、
// KG、聚类等写入器保持不变。

// FrontierMetadataEntry 是过滤前的一个具名 metadata 叶子。
type FrontierMetadataEntry struct {
	Key    string
	Text   *string
	Number *float64
}

// FrontierLogEntry 是一次真实模型尝试的日志输入。
type FrontierLogEntry struct {
	OrgID                     string
	RequestType               string
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
	Metadata                  []FrontierMetadataEntry
	OccurredAt                time.Time
}

// FrontierWriter 写入 llmrequestlogs。写失败是 best effort：调用方记录
// warning 后继续，不使已完成的判定/学习失败。
type FrontierWriter struct {
	service *Service
}

// NewFrontierWriter 复用既有 *sql.DB 与 Mongo 连接，不新开连接池。
func NewFrontierWriter(db *sql.DB, mongoDatabase *mongo.Database) *FrontierWriter {
	return &FrontierWriter{service: NewService(db, mongoDatabase)}
}

type frontierLogDocument struct {
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
func (w *FrontierWriter) WriteAttempt(ctx context.Context, entry FrontierLogEntry) error {
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
	document := frontierLogDocument{
		ID:                        bson.NewObjectID(),
		OrgID:                     normalizeCompletionOrgID(entry.OrgID),
		RequestType:               normalizeCompletionRequestType(entry.RequestType),
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
		Metadata:                  w.service.filterMetadataEntries(ctx, frontierMetadataEntries(entry.Metadata)),
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

func frontierMetadataEntries(entries []FrontierMetadataEntry) []metadataEntry {
	out := make([]metadataEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, metadataEntry{Key: entry.Key, Text: entry.Text, Number: entry.Number})
	}
	return out
}

// normalizeCompletionRequestType keeps the requestType enum Nest writes.
func normalizeCompletionRequestType(value string) string {
	switch value {
	case "completion", "embedding", "rerank", "stream", "responses":
		return value
	}
	return completionRequestType
}

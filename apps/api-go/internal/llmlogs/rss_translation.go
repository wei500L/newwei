package llmlogs

import (
	"context"
	"database/sql"
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// 本文件只新增 RSS 翻译的 LLM request log 写入能力：每次真实模型尝试落一行
// llmrequestlogs，metadata 使用 RSS 自己的 source/targetLanguage 叶子。既有
// 简报写入（completion.go 的 CompletionWriter）与列表/汇总/导出查询不变，
// 也不引用 #81 正在重命名的私有表面。

// RssTranslationMetadata 是 RSS 翻译模型请求 metadata，写入 Mongo 前按
// llm_request_log_settings 的 allowlist/prefix/长度策略过滤。
type RssTranslationMetadata struct {
	Source         string `json:"source"`
	TargetLanguage string `json:"targetLanguage"`
}

// RssTranslationLogEntry 是 RSS 翻译一次真实模型尝试的日志输入。
type RssTranslationLogEntry struct {
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
	Metadata                  *RssTranslationMetadata
	OccurredAt                time.Time
}

// RssTranslationWriter 写入 llmrequestlogs。写失败是 best effort：调用方记录
// warning 后继续，不使翻译失败。
type RssTranslationWriter struct {
	service *Service
}

// NewRssTranslationWriter 复用既有 *sql.DB 与 Mongo 连接，不新开连接池。
func NewRssTranslationWriter(db *sql.DB, mongoDatabase *mongo.Database) *RssTranslationWriter {
	return &RssTranslationWriter{service: NewService(db, mongoDatabase)}
}

// rssTranslationLogDocument 是 llmrequestlogs 的一行。字段与简报写入保持同一
// 形状；String/Number 字段显式写 null，metadata 为空时写 null。
type rssTranslationLogDocument struct {
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
func (w *RssTranslationWriter) WriteAttempt(ctx context.Context, entry RssTranslationLogEntry) error {
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
	document := rssTranslationLogDocument{
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
		Metadata:                  w.service.filterRssTranslationMetadata(ctx, entry.Metadata),
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

// rssMetadataEntry 是过滤前的一个具名 RSS metadata 叶子。
type rssMetadataEntry struct {
	Key    string
	Text   *string
	Number *float64
}

// entries 按模型请求 metadata 的字段顺序返回，保证写入顺序稳定。
func (m RssTranslationMetadata) entries() []rssMetadataEntry {
	source := m.Source
	targetLanguage := m.TargetLanguage
	return []rssMetadataEntry{
		{Key: "source", Text: &source},
		{Key: "targetLanguage", Text: &targetLanguage},
	}
}

func (e rssMetadataEntry) bsonValue() (any, bool) {
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

// filterRssTranslationMetadata applies the same llm_request_log_settings
// allowlist, prefix and length policy as the brief writer. It returns nil when
// nothing survives, which stores BSON null exactly like Nest's normalizeMetadata.
func (s *Service) filterRssTranslationMetadata(ctx context.Context, metadata *RssTranslationMetadata) *bson.D {
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

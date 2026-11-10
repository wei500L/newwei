package llmembed

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/outbound"
)

// Hit 是一条 rerank 命中。Index 相对本次 documents。
type Hit struct {
	Index int
	Score float64
}

type requestMeta struct {
	Source string `json:"source,omitempty"`
	Stage  string `json:"stage,omitempty"`
}

type metaContextKey struct{}
type modelContextKey struct{}

var (
	errEmbeddingUnavailable = errors.New("embedding unavailable")
	errRerankUnavailable    = errors.New("rerank unavailable")
	errUpstream             = errors.New("model gateway request failed")
)

// ContextWithMeta 给本次 embedding/rerank 带上 Nest 使用的 source/stage。
// 只有 profile 打开 sendMetadata 时才会放进请求体。
func ContextWithMeta(ctx context.Context, source, stage string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, metaContextKey{}, requestMeta{Source: source, Stage: stage})
}

// ContextWithModel 让后续 catalog batch 使用 taxonomy embedding 返回的模型名。
// 空字符串保持 profile 自己的 embeddingModel。
func ContextWithModel(ctx context.Context, model string) context.Context {
	model = strings.TrimSpace(model)
	if model == "" {
		return ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, modelContextKey{}, model)
}

// Client 从 MySQL 的 llm_gateway_profiles 选择 embedding 与 rerank。
// 网关配置是全局 SystemSetting，orgID 不决定 profile。
type Client struct {
	db   *sql.DB
	http *http.Client
}

// NewClient 不绑定写死的模型名。模型来自当前启用的 embedding 或 rerank profile。
func NewClient(db *sql.DB) *Client {
	return &Client{db: db, http: outbound.NewClient(0)}
}

// Embed 调用当前 embedding profile。失败返回通用错误，不返回空向量冒充成功。
// 传输、重试与响应解析由共享的 litellmcompat.Client.Embedding 负责。
func (c *Client) Embed(ctx context.Context, orgID string, texts []string) ([][]float64, string, error) {
	if len(texts) == 0 {
		return [][]float64{}, "", nil
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	request := litellmcompat.EmbeddingRequest{
		OrgID:    orgID,
		Input:    texts,
		Metadata: embeddingMetadataFromContext(ctx),
	}
	if override := modelFromContext(ctx); override != "" {
		request.Model = override
	}
	response, err := c.sharedClient().Embedding(ctx, request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", errEmbeddingUnavailable
	}
	vectors := make([][]float64, len(texts))
	for _, row := range response.Rows {
		if row.Index < 0 || row.Index >= len(texts) {
			continue
		}
		vectors[row.Index] = row.Embedding
	}
	responseModel := strings.TrimSpace(response.Model)
	if responseModel == "" {
		responseModel = strings.TrimSpace(request.Model)
	}
	return vectors, responseModel, nil
}

// Rerank 按 profile 的 rerank 模型与 fallback 依次尝试。越界 index 不会返回。
// 模型/回退/重试链路由共享的 litellmcompat.Client.Rerank 负责。
func (c *Client) Rerank(ctx context.Context, orgID, query string, documents []string) ([]Hit, error) {
	if len(documents) == 0 {
		return nil, errRerankUnavailable
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errRerankUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	response, err := c.sharedClient().Rerank(ctx, litellmcompat.RerankRequest{
		OrgID:     orgID,
		Query:     query,
		Documents: documents,
		TopN:      len(documents),
		Metadata:  embeddingMetadataFromContext(ctx),
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errRerankUnavailable
	}
	hits := make([]Hit, 0, len(response.Results))
	for _, result := range response.Results {
		hits = append(hits, Hit{Index: result.Index, Score: result.Score})
	}
	return hits, nil
}

// sharedClient builds a litellmcompat client over the same MySQL pool and HTTP
// client so Embed/Rerank share profile resolution, transport and parsing.
func (c *Client) sharedClient() *litellmcompat.Client {
	env := gatewayEnv()
	cfg := litellmcompat.Config{
		EncryptionKey: env.EncryptionKey,
		APIBase:       env.APIBase,
		Timeout:       time.Duration(env.TimeoutMs) * time.Millisecond,
		MaxRetries:    env.MaxRetries,
	}
	return litellmcompat.NewClient(c.db, nil, cfg).WithHTTP(c.http)
}

// embeddingMetadata adapts the per-call source/stage tokens onto the shared
// Metadata interface. It is only sent when the resolved profile enables
// sendMetadata.
type embeddingMetadata struct {
	Source string
	Stage  string
}

func (m embeddingMetadata) JSONValue() any { return requestMeta{Source: m.Source, Stage: m.Stage} }

func (m embeddingMetadata) LogFields() []llmlogs.ModelRequestMetadataField { return nil }

func embeddingMetadataFromContext(ctx context.Context) litellmcompat.Metadata {
	if ctx == nil {
		return nil
	}
	meta, ok := ctx.Value(metaContextKey{}).(requestMeta)
	if !ok || (meta.Source == "" && meta.Stage == "") {
		return nil
	}
	return embeddingMetadata{Source: meta.Source, Stage: meta.Stage}
}

func modelFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	model, _ := ctx.Value(modelContextKey{}).(string)
	return strings.TrimSpace(model)
}

func uniqueModels(models []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func parseRerank(raw []byte, docCount int) ([]Hit, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, errRerankUnavailable
	}
	rows, _ := doc["results"].([]any)
	if rows == nil {
		rows, _ = doc["data"].([]any)
	}
	hits := make([]Hit, 0, len(rows))
	for _, row := range rows {
		record, ok := row.(map[string]any)
		if !ok {
			continue
		}
		index, ok := integerIndex(record["index"])
		if !ok || index < 0 || index >= docCount {
			continue
		}
		score, ok := rerankScore(record)
		if !ok {
			continue
		}
		hits = append(hits, Hit{Index: index, Score: score})
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) == 0 {
		return nil, errRerankUnavailable
	}
	return hits, nil
}

func rerankScore(record map[string]any) (float64, bool) {
	for _, key := range []string{"relevance_score", "relevanceScore", "score", "similarity"} {
		if score, ok := finiteFloat(record[key]); ok {
			return score, true
		}
	}
	return 0, false
}

func integerIndex(value any) (int, bool) {
	number, ok := finiteFloat(value)
	if !ok || number < 0 || math.Trunc(number) != number {
		return 0, false
	}
	return int(number), true
}

func finiteFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case string:
		parsed, err := json.Number(strings.TrimSpace(typed)).Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func floatSlice(value any) []float64 {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	out := make([]float64, len(items))
	for i, item := range items {
		number, ok := finiteFloat(item)
		if !ok {
			return nil
		}
		out[i] = number
	}
	return out
}

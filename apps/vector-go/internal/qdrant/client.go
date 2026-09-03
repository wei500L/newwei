// Package qdrant 是 Qdrant REST 客户端，行为逐条对齐
// apps/vector/src/modules/vector/qdrant.service.ts：
//   - 集合命名：{prefix}_{sha256(model.trim().lower()).hex[:16]}
//   - point ID：sha256("{model}:{processedItemId}") 前 16 字节构造的确定性 UUID
//     （置 version/variant 位，与 TS 实现逐字节一致）
//   - payload：{orgId, embeddingModel, processedItemId, itemMetaId, createdAtMs}
//   - 检索过滤：must[0] 恒为 orgId match；lookbackMs>0 时追加 createdAtMs range gte
//   - ensureCollection：GET 命中校验维度，404 创建（Cosine + on_disk_payload），
//     并尽力建 orgId(keyword)/createdAtMs(integer) payload 索引（失败仅记日志）
//   - 集合信息有进程内缓存（带维度校验）
package qdrant

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Options 构造 Client 的依赖注入面（测试注入 baseURL 指向 httptest.Server）。
type Options struct {
	BaseURL          string
	APIKey           string // 空串表示未配置，不发送 api-key 头
	TimeoutMs        int
	CollectionPrefix string
	HTTPClient       *http.Client // 可选；默认按 TimeoutMs 构造
}

type collectionInfo struct {
	name       string
	vectorSize int
}

// Client 是 Qdrant REST 客户端。
type Client struct {
	baseURL          string
	apiKey           string
	timeout          time.Duration
	collectionPrefix string
	http             *http.Client

	mu          sync.RWMutex
	collections map[string]collectionInfo
}

// New 构造 Client。
func New(opts Options) *Client {
	timeout := time.Duration(opts.TimeoutMs) * time.Millisecond
	if opts.TimeoutMs <= 0 {
		timeout = 5 * time.Second
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	return &Client{
		baseURL:          strings.TrimRight(opts.BaseURL, "/"),
		apiKey:           opts.APIKey,
		timeout:          timeout,
		collectionPrefix: opts.CollectionPrefix,
		http:             client,
		collections:      make(map[string]collectionInfo),
	}
}

// Point 是 upsert 的单个向量点。
type Point struct {
	ProcessedItemID string
	ItemMetaID      string
	CreatedAtMs     int64
	Vector          []float64
}

// UpsertRequest 是 /v1/upsert 的业务请求。
type UpsertRequest struct {
	OrgID          string
	EmbeddingModel string
	Points         []Point
}

// SearchRequest 是 /v1/search 的业务请求（limit 已在 httpapi 层 clamp）。
type SearchRequest struct {
	OrgID          string
	EmbeddingModel string
	Vector         []float64
	Limit          int
	MinScore       *float64
	LookbackMs     *int64
}

// Match 是检索命中项。
type Match struct {
	ProcessedItemID string  `json:"processedItemId"`
	ItemMetaID      string  `json:"itemMetaId"`
	Score           float64 `json:"score"`
	CreatedAtMs     int64   `json:"createdAtMs"`
}

// UpsertResult 是 upsert 的响应体。
type UpsertResult struct {
	Upserted   int    `json:"upserted"`
	Collection string `json:"collection"`
}

// SearchResult 是 search 的响应体。
type SearchResult struct {
	Collection string  `json:"collection"`
	Matches    []Match `json:"matches"`
}

type qdrantPayload struct {
	OrgID           string `json:"orgId"`
	EmbeddingModel  string `json:"embeddingModel"`
	ProcessedItemID string `json:"processedItemId"`
	ItemMetaID      string `json:"itemMetaId"`
	CreatedAtMs     int64  `json:"createdAtMs"`
}

type qdrantPoint struct {
	ID      string        `json:"id"`
	Vector  []float64     `json:"vector"`
	Payload qdrantPayload `json:"payload"`
}

type qdrantFilterCondition struct {
	Key   string           `json:"key"`
	Match map[string]any   `json:"match,omitempty"`
	Range map[string]int64 `json:"range,omitempty"`
}

type qdrantFilter struct {
	Must []qdrantFilterCondition `json:"must"`
}

type qdrantSearchBody struct {
	Vector         []float64    `json:"vector"`
	Limit          int          `json:"limit"`
	WithPayload    bool         `json:"with_payload"`
	ScoreThreshold *float64     `json:"score_threshold,omitempty"`
	Filter         qdrantFilter `json:"filter"`
}

type qdrantSearchMatchPayload struct {
	OrgID           *string `json:"orgId"`
	ProcessedItemID *string `json:"processedItemId"`
	ItemMetaID      *string `json:"itemMetaId"`
	CreatedAtMs     *int64  `json:"createdAtMs"`
}

type qdrantSearchMatch struct {
	Score   *float64                  `json:"score"`
	Payload *qdrantSearchMatchPayload `json:"payload"`
}

type qdrantResponse[T any] struct {
	Status *string `json:"status"`
	Result *T      `json:"result"`
}

type qdrantCollectionInfo struct {
	Config *struct {
		Params *struct {
			Vectors *struct {
				Size *int `json:"size"`
			} `json:"vectors"`
		} `json:"params"`
	} `json:"config"`
}

// CollectionName 返回模型对应的集合名（导出供测试与诊断）。
func (c *Client) CollectionName(embeddingModel string) string {
	normalized := strings.ToLower(strings.TrimSpace(embeddingModel))
	sum := sha256.Sum256([]byte(normalized))
	return fmt.Sprintf("%s_%s", c.collectionPrefix, hex.EncodeToString(sum[:])[:16])
}

// StableUUID 返回 "{model}:{processedItemId}" 的确定性 UUID（导出供测试）。
func StableUUID(value string) string {
	sum := sha256.Sum256([]byte(value))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hexStr := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexStr[0:8], hexStr[8:12], hexStr[12:16], hexStr[16:20], hexStr[20:32])
}

// UpsertPoints 写入向量点。空 points 直接返回（不触碰 Qdrant），与 TS 行为一致。
func (c *Client) UpsertPoints(ctx context.Context, req UpsertRequest) (UpsertResult, error) {
	name := c.CollectionName(req.EmbeddingModel)
	if len(req.Points) == 0 {
		return UpsertResult{Upserted: 0, Collection: name}, nil
	}

	vectorSize := len(req.Points[0].Vector)
	collection, err := c.ensureCollection(ctx, req.EmbeddingModel, vectorSize)
	if err != nil {
		return UpsertResult{}, err
	}

	points := make([]qdrantPoint, 0, len(req.Points))
	for _, point := range req.Points {
		points = append(points, qdrantPoint{
			ID:     StableUUID(req.EmbeddingModel + ":" + point.ProcessedItemID),
			Vector: point.Vector,
			Payload: qdrantPayload{
				OrgID:           req.OrgID,
				EmbeddingModel:  req.EmbeddingModel,
				ProcessedItemID: point.ProcessedItemID,
				ItemMetaID:      point.ItemMetaID,
				CreatedAtMs:     point.CreatedAtMs,
			},
		})
	}

	body, err := json.Marshal(map[string]any{"points": points})
	if err != nil {
		return UpsertResult{}, err
	}
	endpoint := fmt.Sprintf("%s/collections/%s/points?wait=true", c.baseURL, url.PathEscape(collection.name))
	var parsed qdrantResponse[json.RawMessage]
	if err := c.doJSON(ctx, http.MethodPut, endpoint, body, &parsed); err != nil {
		return UpsertResult{}, fmt.Errorf("qdrant upsert failed: %w", err)
	}
	if parsed.Status == nil || *parsed.Status != "ok" {
		return UpsertResult{}, errors.New("qdrant upsert returned non-ok status")
	}
	return UpsertResult{Upserted: len(req.Points), Collection: collection.name}, nil
}

// Search 检索向量。返回按 score 降序、字段完备的命中项。
func (c *Client) Search(ctx context.Context, req SearchRequest) (SearchResult, error) {
	collection, err := c.ensureCollection(ctx, req.EmbeddingModel, len(req.Vector))
	if err != nil {
		return SearchResult{}, err
	}

	must := []qdrantFilterCondition{{
		Key:   "orgId",
		Match: map[string]any{"value": req.OrgID},
	}}
	var lookbackMs int64
	if req.LookbackMs != nil {
		lookbackMs = *req.LookbackMs
		if lookbackMs < 0 {
			lookbackMs = 0
		}
	}
	if lookbackMs > 0 {
		cutoff := time.Now().UnixMilli() - lookbackMs
		must = append(must, qdrantFilterCondition{
			Key:   "createdAtMs",
			Range: map[string]int64{"gte": cutoff},
		})
	}

	body, err := json.Marshal(qdrantSearchBody{
		Vector:         req.Vector,
		Limit:          req.Limit,
		WithPayload:    true,
		ScoreThreshold: req.MinScore,
		Filter:         qdrantFilter{Must: must},
	})
	if err != nil {
		return SearchResult{}, err
	}
	endpoint := fmt.Sprintf("%s/collections/%s/points/search", c.baseURL, url.PathEscape(collection.name))
	var parsed qdrantResponse[[]qdrantSearchMatch]
	if err := c.doJSON(ctx, http.MethodPost, endpoint, body, &parsed); err != nil {
		return SearchResult{}, fmt.Errorf("qdrant search failed: %w", err)
	}

	var matches []Match
	if parsed.Result != nil {
		for _, entry := range *parsed.Result {
			if entry.Score == nil || entry.Payload == nil {
				continue
			}
			payload := entry.Payload
			if payload.ProcessedItemID == nil || payload.ItemMetaID == nil || payload.CreatedAtMs == nil {
				continue
			}
			matches = append(matches, Match{
				ProcessedItemID: *payload.ProcessedItemID,
				ItemMetaID:      *payload.ItemMetaID,
				Score:           *entry.Score,
				CreatedAtMs:     *payload.CreatedAtMs,
			})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return matches[i].Score > matches[j].Score
	})
	if matches == nil {
		matches = []Match{}
	}
	return SearchResult{Collection: collection.name, Matches: matches}, nil
}

func (c *Client) ensureCollection(ctx context.Context, embeddingModel string, vectorSize int) (collectionInfo, error) {
	name := c.CollectionName(embeddingModel)

	c.mu.RLock()
	cached, ok := c.collections[name]
	c.mu.RUnlock()
	if ok && cached.vectorSize == vectorSize {
		return cached, nil
	}

	endpoint := fmt.Sprintf("%s/collections/%s", c.baseURL, url.PathEscape(name))
	var info qdrantResponse[qdrantCollectionInfo]
	httpErr := c.doJSON(ctx, http.MethodGet, endpoint, nil, &info)
	if httpErr == nil {
		var existingSize *int
		if info.Result != nil && info.Result.Config != nil && info.Result.Config.Params != nil &&
			info.Result.Config.Params.Vectors != nil {
			existingSize = info.Result.Config.Params.Vectors.Size
		}
		if existingSize == nil || *existingSize != vectorSize {
			return collectionInfo{}, fmt.Errorf(
				"qdrant collection size mismatch for %s: expected %d, got %v", name, vectorSize, existingSize)
		}
		result := collectionInfo{name: name, vectorSize: vectorSize}
		c.mu.Lock()
		c.collections[name] = result
		c.mu.Unlock()
		return result, nil
	}

	var statusErr *httpStatusError
	if !errors.As(httpErr, &statusErr) || statusErr.status != http.StatusNotFound {
		return collectionInfo{}, fmt.Errorf("qdrant collection lookup failed: %w", httpErr)
	}

	createBody, err := json.Marshal(map[string]any{
		"vectors":         map[string]any{"size": vectorSize, "distance": "Cosine"},
		"on_disk_payload": true,
	})
	if err != nil {
		return collectionInfo{}, err
	}
	var created qdrantResponse[json.RawMessage]
	if err := c.doJSON(ctx, http.MethodPut, endpoint, createBody, &created); err != nil {
		return collectionInfo{}, fmt.Errorf("qdrant collection create failed: %w", err)
	}

	c.ensurePayloadIndex(ctx, name, "orgId", "keyword")
	c.ensurePayloadIndex(ctx, name, "createdAtMs", "integer")

	result := collectionInfo{name: name, vectorSize: vectorSize}
	c.mu.Lock()
	c.collections[name] = result
	c.mu.Unlock()
	return result, nil
}

// ensurePayloadIndex 尽力创建 payload 索引：失败仅记日志（与 TS 行为一致）。
func (c *Client) ensurePayloadIndex(ctx context.Context, collection, fieldName, fieldSchema string) {
	body, err := json.Marshal(map[string]string{"field_name": fieldName, "field_schema": fieldSchema})
	if err != nil {
		return
	}
	endpoint := fmt.Sprintf("%s/collections/%s/index", c.baseURL, url.PathEscape(collection))
	var parsed qdrantResponse[json.RawMessage]
	if err := c.doJSON(ctx, http.MethodPut, endpoint, body, &parsed); err != nil {
		log.Printf("qdrant: failed to ensure payload index collection=%s field=%s: %v", collection, fieldName, err)
	}
}

type httpStatusError struct {
	status int
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("unexpected status %d", e.status)
}

// doJSON 发送请求并解析 JSON 响应。非 2xx 返回 *httpStatusError；
// 响应体非 JSON 时按 TS fetchJson 语义视为 data=null（解析为零值，不报错）。
func (c *Client) doJSON(ctx context.Context, method, endpoint string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("api-key", c.apiKey)
	}

	response, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &httpStatusError{status: response.StatusCode}
	}
	if out != nil && len(raw) > 0 {
		// 解析失败不返回错误：TS 侧 json().catch(() => null) 把坏响应当 null。
		_ = json.Unmarshal(raw, out)
	}
	return nil
}

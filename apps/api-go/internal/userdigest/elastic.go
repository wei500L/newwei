package userdigest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// elasticSearcher 只实现摘要用到的字面关键词检索。
// 索引仍由 NestJS 在搜索前确保存在；这里不创建索引、不写文档。
// 索引不存在或请求失败时返回 error，摘要回退 Mongo。
type elasticSearcher struct {
	node   string
	alias  string
	apiKey string
	user   string
	pass   string
	client *http.Client
}

// NewElasticsearchFromEnv 在 ELASTICSEARCH_ENABLED 且 NODE 非空时返回客户端。
// 未启用时返回 nil，摘要走 Mongo，进程照常启动。凭据不写入日志。
func NewElasticsearchFromEnv() ItemSearcher {
	if !envBool(os.Getenv("ELASTICSEARCH_ENABLED")) {
		return nil
	}
	node := strings.TrimRight(strings.TrimSpace(os.Getenv("ELASTICSEARCH_NODE")), "/")
	if node == "" {
		return nil
	}
	alias := strings.TrimSpace(os.Getenv("ELASTICSEARCH_ITEMS_ALIAS"))
	if alias == "" {
		alias = "items-current"
	}
	timeoutMs := 3000
	if raw := strings.TrimSpace(os.Getenv("ELASTICSEARCH_REQUEST_TIMEOUT_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			timeoutMs = value
		}
	}
	return &elasticSearcher{
		node:   node,
		alias:  alias,
		apiKey: strings.TrimSpace(os.Getenv("ELASTICSEARCH_API_KEY")),
		user:   os.Getenv("ELASTICSEARCH_USERNAME"),
		pass:   os.Getenv("ELASTICSEARCH_PASSWORD"),
		client: &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond},
	}
}

func (e *elasticSearcher) SearchLiteralKeywords(ctx context.Context, orgID string, keywords []string, createdAtGte time.Time, limit int) ([]KeywordHit, error) {
	normalized := normalizeLiteralKeywords(keywords)
	if len(normalized) == 0 {
		return []KeywordHit{}, nil
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 1000 {
		limit = 1000
	}
	filters := []any{map[string]any{"term": map[string]any{"orgId": orgID}}}
	if !createdAtGte.IsZero() {
		filters = append(filters, map[string]any{
			"range": map[string]any{"createdAt": map[string]any{"gte": createdAtGte.UTC().Format(time.RFC3339Nano)}},
		})
	}
	should := make([]any, 0, len(normalized))
	for _, keyword := range normalized {
		should = append(should, map[string]any{
			"multi_match": map[string]any{
				"query": keyword,
				"type":  "phrase",
				"fields": []string{
					"title^4",
					"summary^2",
					"sourceName^2",
					"topics^2",
					"entities^2",
					"searchText",
				},
			},
		})
	}
	payload := map[string]any{
		"size": limit,
		"query": map[string]any{
			"bool": map[string]any{
				"filter":               filters,
				"should":               should,
				"minimum_should_match": 1,
			},
		},
		"sort": []any{
			map[string]any{"_score": map[string]any{"order": "desc"}},
			map[string]any{"sortAt": map[string]any{"order": "desc"}},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	endpoint := e.node + "/" + url.PathEscape(e.alias) + "/_search"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	if e.apiKey != "" {
		req.Header.Set("authorization", "ApiKey "+e.apiKey)
	} else if e.user != "" || e.pass != "" {
		req.SetBasicAuth(e.user, e.pass)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, errSearchHTTP
	}
	var parsed struct {
		Hits struct {
			Hits []struct {
				Source struct {
					ItemMetaID string `json:"itemMetaId"`
				} `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	out := make([]KeywordHit, 0, len(parsed.Hits.Hits))
	for _, hit := range parsed.Hits.Hits {
		id := strings.TrimSpace(hit.Source.ItemMetaID)
		if id == "" {
			continue
		}
		out = append(out, KeywordHit{ID: id})
	}
	return out, nil
}

var errSearchHTTP = errString("elasticsearch keyword search failed")

type errString string

func (e errString) Error() string { return string(e) }

func normalizeLiteralKeywords(keywords []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(keywords))
	for _, keyword := range keywords {
		trimmed := strings.Join(strings.Fields(keyword), " ")
		if len(trimmed) > 128 {
			trimmed = trimmed[:128]
		}
		key := strings.ToLower(trimmed)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
		if len(out) >= 50 {
			break
		}
	}
	return out
}

func envBool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "y", "on":
		return true
	default:
		return false
	}
}

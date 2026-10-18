package searchreindex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Elasticsearch environment defaults mirror apps/api/src/modules/config/
// env.schema.ts.
const (
	elasticsearchDefaultItemsIndex = "items-v1"
	elasticsearchDefaultItemsAlias = "items-current"
	elasticsearchDefaultTimeoutMs  = 3000
	// elasticsearchMaxResponseBytes bounds one Elasticsearch response read.
	elasticsearchMaxResponseBytes = 1 << 20
)

// indexFieldType is one Elasticsearch mapping type.
type indexFieldType string

const (
	indexFieldKeyword indexFieldType = "keyword"
	indexFieldText    indexFieldType = "text"
	indexFieldDate    indexFieldType = "date"
)

// indexProperty mirrors one mappings.properties entry.
type indexProperty struct {
	Type   indexFieldType           `json:"type"`
	Fields map[string]indexProperty `json:"fields,omitempty"`
}

// indexMappings is the mappings block of the items index.
type indexMappings struct {
	Properties map[string]indexProperty `json:"properties"`
}

// indexCreateRequest is the PUT /<index> body.
type indexCreateRequest struct {
	Mappings indexMappings `json:"mappings"`
}

// bulkActionMeta is the action line of one bulk operation.
type bulkActionMeta struct {
	Index bulkActionTarget `json:"index"`
}

// bulkActionTarget carries the target index and the "<orgId>:<itemMetaId>"
// document id.
type bulkActionTarget struct {
	Index string `json:"_index"`
	ID    string `json:"_id"`
}

// bulkResponse is the subset of the bulk reply the rebuild inspects.
type bulkResponse struct {
	Errors bool               `json:"errors"`
	Items  []bulkResponseItem `json:"items"`
}

// bulkResponseItem is one per-operation bulk outcome.
type bulkResponseItem struct {
	Index *bulkItemResult `json:"index"`
}

// bulkItemResult is one write outcome: a 2xx status without an error field means
// the document was written.
type bulkItemResult struct {
	ID     string         `json:"_id"`
	Status int            `json:"status"`
	Error  *bulkItemError `json:"error"`
}

// bulkItemError is the per-item failure detail.
type bulkItemError struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// bulkFailure is the sanitized description of one failed document. It never
// carries credentials or the document body.
type bulkFailure struct {
	itemMetaID string
	errorType  string
	reason     string
}

// elasticsearchConfig is the resolved ELASTICSEARCH_* configuration.
type elasticsearchConfig struct {
	enabled        bool
	node           string
	username       string
	password       string
	apiKey         string
	itemsIndex     string
	itemsAlias     string
	requestTimeout time.Duration
}

// Elasticsearch is the minimal REST writer the rebuild needs: index and alias
// bootstrap, bulk indexing and the final refresh.
type Elasticsearch struct {
	node       string
	itemsIndex string
	itemsAlias string
	apiKey     string
	username   string
	password   string
	client     *http.Client
}

// elasticsearchConfigFromEnv reads the same variables, defaults and boolean
// parsing as the NestJS env schema.
func elasticsearchConfigFromEnv() elasticsearchConfig {
	config := elasticsearchConfig{
		enabled:        envBoolean(os.Getenv("ELASTICSEARCH_ENABLED")),
		node:           strings.TrimRight(strings.TrimSpace(os.Getenv("ELASTICSEARCH_NODE")), "/"),
		username:       os.Getenv("ELASTICSEARCH_USERNAME"),
		password:       os.Getenv("ELASTICSEARCH_PASSWORD"),
		apiKey:         strings.TrimSpace(os.Getenv("ELASTICSEARCH_API_KEY")),
		itemsIndex:     strings.TrimSpace(os.Getenv("ELASTICSEARCH_ITEMS_INDEX")),
		itemsAlias:     strings.TrimSpace(os.Getenv("ELASTICSEARCH_ITEMS_ALIAS")),
		requestTimeout: elasticsearchDefaultTimeoutMs * time.Millisecond,
	}
	if config.itemsIndex == "" {
		config.itemsIndex = elasticsearchDefaultItemsIndex
	}
	if config.itemsAlias == "" {
		config.itemsAlias = elasticsearchDefaultItemsAlias
	}
	if raw := strings.TrimSpace(os.Getenv("ELASTICSEARCH_REQUEST_TIMEOUT_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			config.requestTimeout = time.Duration(value) * time.Millisecond
		}
	}
	return config
}

// envBoolean mirrors the NestJS envBoolean preprocessor.
func envBoolean(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "y", "on":
		return true
	default:
		return false
	}
}

// newElasticsearchFromEnv returns the writer, or nil when Elasticsearch is
// disabled or has no node. A nil writer keeps the legacy disabled branch.
func newElasticsearchFromEnv() *Elasticsearch {
	return newElasticsearch(elasticsearchConfigFromEnv())
}

// newElasticsearch builds the client from a resolved configuration.
func newElasticsearch(config elasticsearchConfig) *Elasticsearch {
	if !config.enabled || config.node == "" {
		return nil
	}
	return &Elasticsearch{
		node:       config.node,
		itemsIndex: config.itemsIndex,
		itemsAlias: config.itemsAlias,
		apiKey:     config.apiKey,
		username:   config.username,
		password:   config.password,
		client:     &http.Client{Timeout: config.requestTimeout},
	}
}

// ensureIndex keeps the current index and alias behavior: create the index with
// the current mappings when it does not exist, then add the alias to that index
// when the alias does not exist. No shared index is rebuilt, no other
// organization's documents are deleted and no alias is switched.
func (e *Elasticsearch) ensureIndex(ctx context.Context) error {
	exists, err := e.indexExists(ctx)
	if err != nil {
		return err
	}
	if !exists {
		if err := e.createIndex(ctx); err != nil {
			return err
		}
	}
	aliasExists, err := e.aliasExists(ctx)
	if err != nil {
		return err
	}
	if aliasExists {
		return nil
	}
	return e.putAlias(ctx)
}

// indexExists issues HEAD /<index>.
func (e *Elasticsearch) indexExists(ctx context.Context) (bool, error) {
	response, err := e.do(ctx, http.MethodHead, "/"+url.PathEscape(e.itemsIndex), nil, "")
	if err != nil {
		return false, err
	}
	defer drainAndClose(response.Body)
	switch response.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, httpFailure("index existence check", response.StatusCode)
	}
}

// createIndex issues PUT /<index> with the current items mappings.
func (e *Elasticsearch) createIndex(ctx context.Context) error {
	payload, err := json.Marshal(indexCreateRequest{Mappings: itemsIndexMappings()})
	if err != nil {
		return err
	}
	response, err := e.do(ctx, http.MethodPut, "/"+url.PathEscape(e.itemsIndex), bytes.NewReader(payload), "application/json")
	if err != nil {
		return err
	}
	defer drainAndClose(response.Body)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return httpFailure("index creation", response.StatusCode)
	}
	return nil
}

// aliasExists issues HEAD /_alias/<alias>.
func (e *Elasticsearch) aliasExists(ctx context.Context) (bool, error) {
	response, err := e.do(ctx, http.MethodHead, "/_alias/"+url.PathEscape(e.itemsAlias), nil, "")
	if err != nil {
		return false, err
	}
	defer drainAndClose(response.Body)
	switch response.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, httpFailure("alias existence check", response.StatusCode)
	}
}

// putAlias issues PUT /<index>/_alias/<alias>.
func (e *Elasticsearch) putAlias(ctx context.Context) error {
	path := "/" + url.PathEscape(e.itemsIndex) + "/_alias/" + url.PathEscape(e.itemsAlias)
	response, err := e.do(ctx, http.MethodPut, path, nil, "")
	if err != nil {
		return err
	}
	defer drainAndClose(response.Body)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return httpFailure("alias creation", response.StatusCode)
	}
	return nil
}

// itemsIndexMappings is the exact mapping set used by the NestJS ensureIndex.
func itemsIndexMappings() indexMappings {
	keywordSubField := map[string]indexProperty{"keyword": {Type: indexFieldKeyword}}
	return indexMappings{Properties: map[string]indexProperty{
		"orgId":       {Type: indexFieldKeyword},
		"itemMetaId":  {Type: indexFieldKeyword},
		"externalId":  {Type: indexFieldKeyword},
		"title":       {Type: indexFieldText},
		"sourceName":  {Type: indexFieldText, Fields: keywordSubField},
		"summary":     {Type: indexFieldText},
		"topics":      {Type: indexFieldText, Fields: keywordSubField},
		"entities":    {Type: indexFieldText, Fields: keywordSubField},
		"region":      {Type: indexFieldKeyword},
		"location":    {Type: indexFieldKeyword},
		"sentiment":   {Type: indexFieldKeyword},
		"contentType": {Type: indexFieldKeyword},
		"searchText":  {Type: indexFieldText},
		"sortAt":      {Type: indexFieldDate},
		"createdAt":   {Type: indexFieldDate},
	}}
}

// bulkIndex writes one batch with refresh=false. The NDJSON body alternates one
// action line and one document line per item and ends with a trailing newline.
// The returned count covers only the documents the bulk reply confirmed; every
// per-item failure is described without credentials or document content.
func (e *Elasticsearch) bulkIndex(ctx context.Context, documents []ItemSearchDocument) (int, []bulkFailure, error) {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	for _, document := range documents {
		action := bulkActionMeta{Index: bulkActionTarget{
			Index: e.itemsIndex,
			ID:    document.OrgID + ":" + document.ItemMetaID,
		}}
		if err := encoder.Encode(action); err != nil {
			return 0, nil, err
		}
		if err := encoder.Encode(document); err != nil {
			return 0, nil, err
		}
	}
	response, err := e.do(ctx, http.MethodPost, "/_bulk?refresh=false", &body, "application/x-ndjson")
	if err != nil {
		return 0, nil, err
	}
	defer drainAndClose(response.Body)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return 0, nil, httpFailure("bulk request", response.StatusCode)
	}
	var parsed bulkResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, elasticsearchMaxResponseBytes)).Decode(&parsed); err != nil {
		return 0, nil, fmt.Errorf("elasticsearch bulk response is not readable: %w", err)
	}
	indexed := 0
	failures := make([]bulkFailure, 0)
	for index, document := range documents {
		var result *bulkItemResult
		if index < len(parsed.Items) {
			result = parsed.Items[index].Index
		}
		if result == nil {
			failures = append(failures, bulkFailure{
				itemMetaID: document.ItemMetaID,
				errorType:  "missing_bulk_item",
				reason:     "elasticsearch returned no item result for this document",
			})
			continue
		}
		if result.Error != nil || result.Status < 200 || result.Status > 299 {
			failures = append(failures, bulkFailure{
				itemMetaID: document.ItemMetaID,
				errorType:  bulkErrorType(result.Error),
				reason:     bulkErrorReason(result.Error),
			})
			continue
		}
		indexed++
	}
	return indexed, failures, nil
}

// refresh issues the explicit final POST /<index>/_refresh. A job only completes
// after this call succeeds.
func (e *Elasticsearch) refresh(ctx context.Context) error {
	response, err := e.do(ctx, http.MethodPost, "/"+url.PathEscape(e.itemsIndex)+"/_refresh", nil, "")
	if err != nil {
		return err
	}
	defer drainAndClose(response.Body)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return httpFailure("index refresh", response.StatusCode)
	}
	return nil
}

// do sends one request. Authentication prefers the API key and otherwise uses
// basic auth only when both the username and the password are present, matching
// the NestJS client configuration. Credentials never appear in errors.
func (e *Elasticsearch) do(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, e.node+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/json")
	if contentType != "" {
		request.Header.Set("content-type", contentType)
	}
	if e.apiKey != "" {
		request.Header.Set("authorization", "ApiKey "+e.apiKey)
	} else if e.username != "" && e.password != "" {
		request.SetBasicAuth(e.username, e.password)
	}
	return e.client.Do(request)
}

// httpFailure builds a short status-only Elasticsearch error.
func httpFailure(operation string, status int) error {
	return fmt.Errorf("elasticsearch %s failed with status %d", operation, status)
}

// bulkErrorType names the per-item error type, defaulting to "unknown".
func bulkErrorType(failure *bulkItemError) string {
	if failure == nil || strings.TrimSpace(failure.Type) == "" {
		return "unknown"
	}
	return truncateText(failure.Type, 60)
}

// bulkErrorReason shortens the per-item reason and strips line breaks.
func bulkErrorReason(failure *bulkItemError) string {
	if failure == nil || strings.TrimSpace(failure.Reason) == "" {
		return "no reason returned by elasticsearch"
	}
	return truncateText(failure.Reason, 200)
}

// truncateText collapses whitespace and cuts the text to limit runes.
func truncateText(value string, limit int) string {
	normalized := strings.Join(strings.Fields(value), " ")
	runes := []rune(normalized)
	if len(runes) <= limit {
		return normalized
	}
	return string(runes[:limit]) + "..."
}

// drainAndClose releases the connection of a response that is not read fully.
func drainAndClose(body io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, elasticsearchMaxResponseBytes))
	_ = body.Close()
}

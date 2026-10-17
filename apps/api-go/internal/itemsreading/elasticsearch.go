package itemsreading

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Item search defaults mirrored from ELASTICSEARCH_* env schema entries and
// from the private normalizeSearchLimit of items-elasticsearch.service.ts.
const (
	// defaultItemsAlias is ELASTICSEARCH_ITEMS_ALIAS's default value.
	defaultItemsAlias = "items-current"
	// elasticsearchRequestTimeoutDefaultMs is ELASTICSEARCH_REQUEST_TIMEOUT_MS's
	// default value.
	elasticsearchRequestTimeoutDefaultMs = 3000
	// elasticsearchSearchDefaultSize is the NestJS `limit = 500` default.
	elasticsearchSearchDefaultSize = 500
	// elasticsearchSearchMaxSize is the normalizeSearchLimit upper clamp.
	elasticsearchSearchMaxSize = 1000
	// elasticsearchMaxHighlightSnippets caps one highlight field, mirroring the
	// extractHighlights slice(0, 3).
	elasticsearchMaxHighlightSnippets = 3
	// elasticsearchResponseBodyLimit caps how much of one response is read.
	elasticsearchResponseBodyLimit = 1 << 20
)

// itemSearchQueryFields is the query_string field list, in the exact order
// items-elasticsearch.service.ts sends it. Boosts are part of the string.
var itemSearchQueryFields = []string{
	"title^4",
	"summary^2",
	"sourceName^2",
	"topics^2",
	"entities^2",
	"region",
	"location",
	"sentiment",
	"contentType",
	"externalId",
	"searchText",
}

// itemFieldAliases ports FIELD_ALIASES from items-elasticsearch.service.ts.
var itemFieldAliases = map[string]string{
	"title":       "title",
	"source":      "sourceName",
	"sourceName":  "sourceName",
	"summary":     "summary",
	"topic":       "topics",
	"topics":      "topics",
	"entity":      "entities",
	"entities":    "entities",
	"region":      "region",
	"location":    "location",
	"sentiment":   "sentiment",
	"type":        "contentType",
	"contentType": "contentType",
	"id":          "externalId",
}

// ItemSearchHit is one Elasticsearch hit: the organization-scoped itemMetaId,
// the relevance score, and the highlight snippets per field (each field capped
// at three snippets). It is the Go port of the NestJS ItemSearchHit interface.
type ItemSearchHit struct {
	// ID is the hit's _source.itemMetaId; empty ids are dropped by Search.
	ID string
	// Score is _score, or 0 when Elasticsearch did not return a number.
	Score float64
	// Highlights holds up to three snippets per highlighted field; it is nil
	// when the hit carried no usable highlight block.
	Highlights map[string][]string
}

// elasticSearcher is the raw net/http Elasticsearch client for item search. It
// only ever issues _search requests against the read alias: index creation,
// alias management and document writes stay in NestJS, so this client can never
// mutate the cluster.
type elasticSearcher struct {
	// node is ELASTICSEARCH_NODE with a trailing slash removed.
	node string
	// alias is the items read alias (ELASTICSEARCH_ITEMS_ALIAS).
	alias string
	// apiKey is the base64 API key used as `authorization: ApiKey …`.
	apiKey string
	// user and pass are the basic-auth fallback used when no API key is set.
	user string
	pass string
	// client is the shared HTTP client with the request timeout applied.
	client *http.Client
}

// newElasticsearchFromEnv returns nil unless ELASTICSEARCH_ENABLED is truthy and
// ELASTICSEARCH_NODE is set. Env: ELASTICSEARCH_ITEMS_ALIAS (default
// "items-current"), ELASTICSEARCH_API_KEY, ELASTICSEARCH_USERNAME,
// ELASTICSEARCH_PASSWORD, ELASTICSEARCH_REQUEST_TIMEOUT_MS (default 3000).
//
// A nil return is the "Elasticsearch disabled" state: callers simply skip the
// recall source, exactly like the NestJS client being null.
func newElasticsearchFromEnv() *elasticSearcher {
	if !envTruthy(os.Getenv("ELASTICSEARCH_ENABLED")) {
		return nil
	}
	node := strings.TrimRight(strings.TrimSpace(os.Getenv("ELASTICSEARCH_NODE")), "/")
	if node == "" {
		return nil
	}
	alias := strings.TrimSpace(os.Getenv("ELASTICSEARCH_ITEMS_ALIAS"))
	if !validIndexName(alias) {
		alias = defaultItemsAlias
	}
	timeoutMs := elasticsearchRequestTimeoutDefaultMs
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

// Search ports the NestJS `search`: it returns nil when the client is nil or the
// query is blank, and nil (never an error) on an HTTP or parse failure so the
// caller degrades exactly like NestJS.
//
// The request uses the read alias, size = normalizeSearchLimit(limit),
// bool.filter term orgId, bool.must query_string over the eleven boosted fields
// with default_operator AND and lenient true, the highlight block (title,
// summary, sourceName, topics, entities and searchText with fragment_size 160
// and number_of_fragments 2), and sort [{_score desc},{sortAt desc}]. Hits with
// an empty _source.itemMetaId are dropped, and each highlight field is capped at
// three snippets. Indexes and aliases are never created and documents are never
// written.
func (e *elasticSearcher) Search(ctx context.Context, orgID string, query string, limit int) ([]ItemSearchHit, error) {
	if e == nil || e.client == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return nil, nil
	}
	body, err := json.Marshal(buildItemSearchBody(orgID, trimmed, normalizeSearchLimit(limit)))
	if err != nil {
		return nil, nil
	}
	endpoint := e.node + "/" + e.alias + "/_search"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, nil
	}
	req.Header.Set("content-type", "application/json")
	if e.apiKey != "" {
		req.Header.Set("authorization", "ApiKey "+e.apiKey)
	} else if e.user != "" || e.pass != "" {
		req.SetBasicAuth(e.user, e.pass)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, nil
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, elasticsearchResponseBodyLimit))
	if err != nil {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, nil
	}
	var parsed esSearchResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, nil
	}
	hits := make([]ItemSearchHit, 0, len(parsed.Hits.Hits))
	for _, hit := range parsed.Hits.Hits {
		id := hit.Source.ItemMetaID
		if id == "" {
			continue
		}
		hits = append(hits, ItemSearchHit{
			ID:         id,
			Score:      hit.Score,
			Highlights: extractHighlights(hit.Highlight),
		})
	}
	return hits, nil
}

// esSearchRequest is the POST {alias}/_search body.
type esSearchRequest struct {
	Size      int             `json:"size"`
	Query     esQueryClause   `json:"query"`
	Highlight esHighlightSpec `json:"highlight"`
	Sort      []esSortClause  `json:"sort"`
}

// esQueryClause wraps the bool query object.
type esQueryClause struct {
	Bool esBoolQuery `json:"bool"`
}

// esBoolQuery is the filtered bool query: exactly one org term filter and one
// query_string must clause.
type esBoolQuery struct {
	Filter []esTermFilter `json:"filter"`
	Must   []esMustClause `json:"must"`
}

// esTermFilter is a single `{"term":{...}}` filter entry.
type esTermFilter struct {
	Term esTermField `json:"term"`
}

// esTermField is the tenant term: `{"orgId": "..."}`.
type esTermField struct {
	OrgID string `json:"orgId"`
}

// esMustClause is a single `{"query_string":{...}}` must entry.
type esMustClause struct {
	QueryString esQueryString `json:"query_string"`
}

// esQueryString is the Lucene query_string clause shared with NestJS.
type esQueryString struct {
	Query           string   `json:"query"`
	Fields          []string `json:"fields"`
	DefaultOperator string   `json:"default_operator"`
	Lenient         bool     `json:"lenient"`
}

// esHighlightSpec is the highlight block.
type esHighlightSpec struct {
	PreTags  []string          `json:"pre_tags"`
	PostTags []string          `json:"post_tags"`
	Fields   esHighlightFields `json:"fields"`
}

// esHighlightFields lists every highlighted field in NestJS order. A field with
// no options marshals as `{}`, which is the NestJS `field: {}` shape.
type esHighlightFields struct {
	Title      esHighlightField `json:"title"`
	Summary    esHighlightField `json:"summary"`
	SourceName esHighlightField `json:"sourceName"`
	Topics     esHighlightField `json:"topics"`
	Entities   esHighlightField `json:"entities"`
	SearchText esHighlightField `json:"searchText"`
}

// esHighlightField carries the optional fragment options; nil pointers are
// omitted so plain fields serialize as `{}`.
type esHighlightField struct {
	FragmentSize      *int `json:"fragment_size,omitempty"`
	NumberOfFragments *int `json:"number_of_fragments,omitempty"`
}

// esSortClause is one sort array element. Only one of the two members is set,
// which reproduces the heterogeneous `[{_score:…},{sortAt:…}]` array.
type esSortClause struct {
	Score  *esSortOrder `json:"_score,omitempty"`
	SortAt *esSortOrder `json:"sortAt,omitempty"`
}

// esSortOrder is one `{"order":"desc"}` directive.
type esSortOrder struct {
	Order string `json:"order"`
}

// esSearchResponse is the subset of the Elasticsearch search response the items
// recall reads.
type esSearchResponse struct {
	Hits esSearchHits `json:"hits"`
}

// esSearchHits is the hits envelope.
type esSearchHits struct {
	Hits []esSearchHit `json:"hits"`
}

// esSearchHit is one returned hit. Highlight stays raw so a field whose value is
// not a string array can be skipped without failing the whole response.
type esSearchHit struct {
	Score     float64         `json:"_score"`
	Source    esSearchSource  `json:"_source"`
	Highlight json.RawMessage `json:"highlight"`
}

// esSearchSource is the indexed source projection the recall needs.
type esSearchSource struct {
	ItemMetaID string `json:"itemMetaId"`
}

// buildItemSearchBody assembles the exact search body of the NestJS `search`.
func buildItemSearchBody(orgID string, query string, size int) esSearchRequest {
	fragmentSize := 160
	numberOfFragments := 2
	return esSearchRequest{
		Size: size,
		Query: esQueryClause{Bool: esBoolQuery{
			Filter: []esTermFilter{{Term: esTermField{OrgID: orgID}}},
			Must: []esMustClause{{QueryString: esQueryString{
				Query:           rewriteFieldAliases(query),
				Fields:          itemSearchQueryFields,
				DefaultOperator: "AND",
				Lenient:         true,
			}}},
		}},
		Highlight: esHighlightSpec{
			PreTags:  []string{"<mark>"},
			PostTags: []string{"</mark>"},
			Fields: esHighlightFields{
				Title:      esHighlightField{},
				Summary:    esHighlightField{},
				SourceName: esHighlightField{},
				Topics:     esHighlightField{},
				Entities:   esHighlightField{},
				SearchText: esHighlightField{
					FragmentSize:      &fragmentSize,
					NumberOfFragments: &numberOfFragments,
				},
			},
		},
		Sort: []esSortClause{
			{Score: &esSortOrder{Order: "desc"}},
			{SortAt: &esSortOrder{Order: "desc"}},
		},
	}
}

// normalizeSearchLimit ports the private normalizeSearchLimit: floor the value,
// clamp it to [1,1000], and default to 500. Go's zero value stands in for the
// NestJS default parameter, so a non-positive limit selects 500.
func normalizeSearchLimit(limit int) int {
	if limit <= 0 {
		return elasticsearchSearchDefaultSize
	}
	if limit > elasticsearchSearchMaxSize {
		return elasticsearchSearchMaxSize
	}
	return limit
}

// rewriteFieldAliases ports rewriteFieldAliases, which replaces every
// `field:` occurrence with its FIELD_ALIASES target. It is a hand-rolled scan
// instead of a regexp so the file stays on the package's minimal import set:
// an ASCII word boundary, an identifier that starts with a letter, then ':'.
func rewriteFieldAliases(query string) string {
	if query == "" {
		return query
	}
	var builder strings.Builder
	builder.Grow(len(query))
	index := 0
	for index < len(query) {
		current := query[index]
		if !isASCIILetter(current) {
			builder.WriteByte(current)
			index++
			continue
		}
		if index > 0 && isWordByte(query[index-1]) {
			builder.WriteByte(current)
			index++
			continue
		}
		end := index + 1
		for end < len(query) && isWordByte(query[end]) {
			end++
		}
		if end < len(query) && query[end] == ':' {
			field := query[index:end]
			if mapped, ok := itemFieldAliases[field]; ok {
				builder.WriteString(mapped)
			} else {
				builder.WriteString(field)
			}
			builder.WriteByte(':')
			index = end + 1
			continue
		}
		builder.WriteString(query[index:end])
		index = end
	}
	return builder.String()
}

// isASCIILetter reports whether a byte is an ASCII letter.
func isASCIILetter(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
}

// isWordByte reports whether a byte is an ASCII word character, matching the
// JavaScript \b character class used by rewriteFieldAliases.
func isWordByte(value byte) bool {
	return isASCIILetter(value) || (value >= '0' && value <= '9') || value == '_'
}

// extractHighlights ports extractHighlights: a non-object block is empty, a
// non-array field is skipped, non-string snippets are skipped, and each field
// keeps at most three snippets. Fields with no kept snippet are omitted.
func extractHighlights(raw json.RawMessage) map[string][]string {
	if len(raw) == 0 {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	out := make(map[string][]string, len(fields))
	for field, value := range fields {
		var snippets []json.RawMessage
		if err := json.Unmarshal(value, &snippets); err != nil {
			continue
		}
		normalized := make([]string, 0, elasticsearchMaxHighlightSnippets)
		for _, snippet := range snippets {
			if len(normalized) >= elasticsearchMaxHighlightSnippets {
				break
			}
			var text string
			if err := json.Unmarshal(snippet, &text); err != nil {
				continue
			}
			normalized = append(normalized, text)
		}
		if len(normalized) > 0 {
			out[field] = normalized
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// validIndexName reports whether an Elasticsearch alias can be placed in a URL
// path without escaping. NestJS hands the raw alias to the official client,
// which URL-encodes it; this gateway restricts the accepted characters instead
// so a malformed environment value cannot point the request at another path.
func validIndexName(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		switch char := value[index]; {
		case char >= 'a' && char <= 'z':
		case char >= 'A' && char <= 'Z':
		case char >= '0' && char <= '9':
		case char == '-', char == '_', char == '.', char == '+':
		default:
			return false
		}
	}
	return true
}

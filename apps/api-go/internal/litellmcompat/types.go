// Package litellmcompat is the OpenAI-compatible LiteLLM client used by the
// migrated archive preparation worker and news classifier.
//
// It reproduces the LiteLlmService surfaces those two chains call: gateway
// profile selection from SystemSetting, the optional managed-proxy governance
// key, chat/completions and responses completion, embeddings, rerank, the per-
// model retry/fallback policy, guardrail resolution for untrusted content,
// compatibility-error classification and one llmrequestlogs row per real
// attempt. It deliberately does not reproduce the 60 second Redis cache around
// the gateway profile document; each model call reads the same authoritative
// SystemSetting row. Streaming and the non-classifier call shapes stay in NestJS.
package litellmcompat

import (
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// APISurface is the gateway request shape.
type APISurface string

// Gateway API surfaces.
const (
	APISurfaceChat      APISurface = "chat_completions"
	APISurfaceResponses APISurface = "responses"
)

// ResponseFormatMode is the stored response-format policy.
type ResponseFormatMode string

// Response-format modes.
const (
	ResponseFormatJSONSchema ResponseFormatMode = "json_schema"
	ResponseFormatJSONObject ResponseFormatMode = "json_object"
	ResponseFormatNone       ResponseFormatMode = "none"
)

// Metadata is the ordered model-request metadata. The same value is serialized
// into the request body and normalized into the request-log row.
type Metadata interface {
	JSONValue() any
	LogFields() []llmlogs.ModelRequestMetadataField
}

// Message is one chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// JSONSchemaFormat is the OpenAI response_format.json_schema object.
type JSONSchemaFormat struct {
	Name   string          `json:"name"`
	Schema json.RawMessage `json:"schema"`
}

// ResponseFormat is the OpenAI response_format object.
type ResponseFormat struct {
	Type       string            `json:"type"`
	JSONSchema *JSONSchemaFormat `json:"json_schema,omitempty"`
}

// Usage is the upstream token/cost snapshot. Unreported members stay nil.
type Usage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// CompletionRequest is one acompletion call.
type CompletionRequest struct {
	OrgID          string
	Model          string
	Messages       []Message
	Temperature    *float64
	TopP           *float64
	MaxTokens      *int
	ResponseFormat *ResponseFormat
	Metadata       Metadata
	MaxRetries     *int
	Timeout        time.Duration
	Guardrails     []string
}

// CompletionResponse is the normalized completion result.
type CompletionResponse struct {
	Content        string
	Model          string
	RequestedModel string
	FallbackUsed   bool
	Usage          Usage
}

// EmbeddingRequest is one embedding call.
type EmbeddingRequest struct {
	OrgID      string
	Model      string
	Input      []string
	Metadata   Metadata
	MaxRetries *int
}

// EmbeddingRow is one returned vector with its response index.
type EmbeddingRow struct {
	Index     int
	Embedding []float64
}

// EmbeddingResponse is the embedding result.
type EmbeddingResponse struct {
	Rows  []EmbeddingRow
	Model string
	Usage Usage
}

// RerankRequest is one rerank call.
type RerankRequest struct {
	OrgID     string
	Model     string
	Query     string
	Documents []string
	TopN      int
	Metadata  Metadata
}

// RerankResult is one rerank hit.
type RerankResult struct {
	Index int
	Score float64
}

// RerankResponse is the rerank result.
type RerankResponse struct {
	Results []RerankResult
	Model   string
	Usage   Usage
}

// RuntimeModel reports the model selected for an embedding/rerank call and
// whether one is configured.
type RuntimeModel struct {
	Model      string
	Configured bool
}

// Internal interface guards.
var (
	_ Metadata = ArchiveEmbeddingMetadata{}
	_ Metadata = ArchiveAnchorMetadata{}
	_ Metadata = ArchiveRerankMetadata{}
	_ Metadata = NewsClassifierMetadata{}
)

// completionJSON is the chat completion body in Nest's key order.
type completionJSON struct {
	Model          string          `json:"model"`
	Messages       []Message       `json:"messages"`
	Temperature    float64         `json:"temperature"`
	TopP           float64         `json:"top_p"`
	MaxTokens      int             `json:"max_tokens"`
	ResponseFormat *ResponseFormat `json:"response_format,omitempty"`
	Stream         bool            `json:"stream"`
	Guardrails     []string        `json:"guardrails,omitempty"`
	Metadata       any             `json:"metadata,omitempty"`
}

// responsesJSON is the Responses API body in Nest's key order.
type responsesJSON struct {
	Model           string         `json:"model"`
	Input           []Message      `json:"input"`
	Temperature     float64        `json:"temperature"`
	TopP            float64        `json:"top_p"`
	MaxOutputTokens int            `json:"max_output_tokens"`
	Text            *responsesText `json:"text,omitempty"`
	Guardrails      []string       `json:"guardrails,omitempty"`
	Metadata        any            `json:"metadata,omitempty"`
}

type responsesText struct {
	Format any `json:"format"`
}

type embeddingJSON struct {
	Model    string   `json:"model"`
	Input    []string `json:"input"`
	Metadata any      `json:"metadata,omitempty"`
}

type rerankJSON struct {
	Model     string   `json:"model"`
	Query     string   `json:"query"`
	Documents []string `json:"documents"`
	TopN      int      `json:"top_n"`
	Metadata  any      `json:"metadata,omitempty"`
}

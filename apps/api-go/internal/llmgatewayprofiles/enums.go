package llmgatewayprofiles

// APISurface selects the completion API dialect for one profile. It mirrors the
// LlmGatewayApiSurface union in the NestJS service.
type APISurface string

const (
	// APISurfaceChatCompletions is the default completion surface.
	APISurfaceChatCompletions APISurface = "chat_completions"
	// APISurfaceResponses selects the OpenAI Responses API surface.
	APISurfaceResponses APISurface = "responses"
)

// ResponseFormatMode mirrors LlmGatewayResponseFormatMode.
type ResponseFormatMode string

const (
	// ResponseFormatJSONSchema is the default response_format mode.
	ResponseFormatJSONSchema ResponseFormatMode = "json_schema"
	// ResponseFormatJSONObject requests a plain JSON object response.
	ResponseFormatJSONObject ResponseFormatMode = "json_object"
	// ResponseFormatNone forbids any response_format field.
	ResponseFormatNone ResponseFormatMode = "none"
)

// EmbeddingMode mirrors LlmGatewayEmbeddingMode.
type EmbeddingMode string

const (
	// EmbeddingModeFollowCompletion resolves embeddings from the active
	// completion profile (the default).
	EmbeddingModeFollowCompletion EmbeddingMode = "follow_completion"
	// EmbeddingModeUseDefault resolves embeddings from the first enabled
	// profile that configures an embedding model.
	EmbeddingModeUseDefault EmbeddingMode = "use_default"
)

// RerankMode mirrors LlmGatewayRerankMode.
type RerankMode string

const (
	// RerankModeFollowCompletion resolves rerank from the active completion
	// profile (the default).
	RerankModeFollowCompletion RerankMode = "follow_completion"
	// RerankModeUseDefault resolves rerank from the first enabled profile that
	// configures a rerank model.
	RerankModeUseDefault RerankMode = "use_default"
)

// AuditAction is the SystemSetting audit action string per operation.
type AuditAction string

const (
	// AuditActionCreate is written by POST /llm-gateways.
	AuditActionCreate AuditAction = "llm_gateway_create"
	// AuditActionUpdate is written by PUT /llm-gateways/:id.
	AuditActionUpdate AuditAction = "llm_gateway_update"
	// AuditActionDelete is written by DELETE /llm-gateways/:id.
	AuditActionDelete AuditAction = "llm_gateway_delete"
	// AuditActionActivate is written by PUT /llm-gateways/active.
	AuditActionActivate AuditAction = "llm_gateway_activate"
	// AuditActionEmbeddingActivate is written by
	// PUT /llm-gateways/embedding-active.
	AuditActionEmbeddingActivate AuditAction = "llm_gateway_embedding_activate"
	// AuditActionRerankActivate is written by PUT /llm-gateways/rerank-active.
	AuditActionRerankActivate AuditAction = "llm_gateway_rerank_activate"
)

// SecretKind discriminates the JSON shapes an apiKey can take in the stored
// document. A profile key may be absent, an explicit null, a plaintext string
// (non-production fallback), a v1 AES-GCM envelope, or any other legacy JSON
// value that must be preserved byte-for-byte when the document is rewritten.
type SecretKind int

const (
	// SecretAbsent means the apiKey key is not present in the document.
	SecretAbsent SecretKind = iota
	// SecretNull means the apiKey key is present with the JSON literal null.
	SecretNull
	// SecretPlaintext means the apiKey holds a plaintext string.
	SecretPlaintext
	// SecretEncrypted means the apiKey holds a system-settings:v1 envelope.
	SecretEncrypted
	// SecretOpaque means the apiKey holds an unrecognised legacy JSON value
	// (object, array, number, boolean) that is preserved on rewrite.
	SecretOpaque
)

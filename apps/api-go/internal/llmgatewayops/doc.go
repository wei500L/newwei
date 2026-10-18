// Package llmgatewayops serves the twelve LiteLLM gateway governance and
// diagnostics routes:
//
//	GET    /api/system-settings/llm-gateways/proxy-governance
//	PUT    /api/system-settings/llm-gateways/proxy-governance
//	DELETE /api/system-settings/llm-gateways/proxy-governance
//	POST   /api/system-settings/llm-gateways/proxy-governance/preflight
//	POST   /api/system-settings/llm-gateways/proxy-governance/rotate-key
//	GET    /api/system-settings/llm-gateways/:id/models
//	POST   /api/system-settings/llm-gateways/:id/test
//	GET    /api/system-settings/llm-gateways/:id/proxy-health
//	GET    /api/system-settings/llm-gateways/:id/proxy-model-info
//	POST   /api/system-settings/llm-gateways/:id/proxy-lb-test
//	POST   /api/system-settings/llm-gateways/models-config
//	POST   /api/system-settings/llm-gateways/test-config
//
// Every route requires the shared settings.manage permission and reuses the
// existing JWT / mtk_ machine identity chain. The settings themselves stay
// global SystemSetting rows: the actor orgId/userId is only used for the audit
// trail and the LLM request log attribution, never as a settings partition.
//
// The batch owns three kinds of side effects:
//
//   - governance persistence: the litellm_proxy_governance SystemSetting row,
//     its 30 second Redis envelope, and the encoded managed runtime key;
//   - LiteLLM management calls: /team/update|/team/new and
//     /key/update|/key/generate authenticated with LITELLM_MASTER_KEY;
//   - real diagnostics: /v1/models, /health/*, /v1/model/info,
//     /v1/chat/completions, /v1/responses, /v1/embeddings and /v1/rerank, each
//     real attempt persisted to llmrequestlogs.
//
// A governance write is not one transaction across MySQL and LiteLLM. The
// ordering below is the contract: remote sync first, then the durable write,
// then the audit, and only afterwards the best-effort shutdown of the previous
// managed resources.
package llmgatewayops

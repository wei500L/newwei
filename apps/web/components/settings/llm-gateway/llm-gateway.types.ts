export type LlmGatewayResponseFormatMode = "json_schema" | "json_object" | "none";
export type LlmGatewayApiSurface = "chat_completions" | "responses";
export type LlmGatewayTestAuthMode = "profile_key" | "managed_runtime_key";
export type LiteLlmManagedRuntimeKeyState = "missing" | "available" | "unreadable";
export type GovernanceAttentionType = "success" | "info" | "warning" | "error";

export interface GovernanceOverviewCard {
  key: string;
  title: string;
  value: string;
  description: string;
  tagColor?: string;
  tagLabel?: string;
}

export interface GovernanceAttentionItem {
  key: string;
  type: GovernanceAttentionType;
  title: string;
  description: string;
}

export interface LlmGatewayProfile {
  id: string;
  name: string;
  apiBase: string;
  model: string;
  assistantModel?: string | null;
  assistantWebSearchEnabled: boolean;
  embeddingModel?: string | null;
  rerankModel?: string | null;
  rerankFallbackModels: string[];
  apiSurface: LlmGatewayApiSurface;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  fallbackModels: string[];
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export type LlmGatewayEmbeddingMode = "follow_completion" | "use_default";
export type LlmGatewayRerankMode = "follow_completion" | "use_default";

export interface LlmGatewaySettingsResponse {
  activeId: string | null;
  embeddingActiveId: string | null;
  embeddingMode: LlmGatewayEmbeddingMode;
  rerankActiveId: string | null;
  rerankMode: LlmGatewayRerankMode;
  profiles: LlmGatewayProfile[];
}

export interface LlmGatewayTestResponse {
  apiBase: string;
  apiSurfaceUsed?: "chat_completions" | "responses";
  authModeUsed?: LlmGatewayTestAuthMode;
  compatibilityError?: {
    code: string;
    incompatibleField: string;
    hint: string;
    upstreamMessage: string;
    status?: number;
  };
  completion?: {
    model: string;
    content: string | null;
    finishReason?: string;
    latencyMs: number;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    costUsd?: number;
    keySpendUsd?: number;
  };
  completionError?: {
    code?: string;
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
    compatibilityError?: {
      code: string;
      incompatibleField: string;
      hint: string;
      upstreamMessage: string;
      status?: number;
    };
  };
  embedding?: {
    model: string;
    dimensions: number;
    latencyMs: number;
    usage?: { prompt_tokens: number; total_tokens: number };
    costUsd?: number;
    keySpendUsd?: number;
  };
  embeddingError?: {
    code?: string;
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
    compatibilityError?: {
      code: string;
      incompatibleField: string;
      hint: string;
      upstreamMessage: string;
      status?: number;
    };
  };
  rerank?: {
    model: string;
    topN: number;
    latencyMs: number;
    results: { index: number; score: number }[];
    costUsd?: number;
    keySpendUsd?: number;
  };
  rerankError?: {
    code?: string;
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
    compatibilityError?: {
      code: string;
      incompatibleField: string;
      hint: string;
      upstreamMessage: string;
      status?: number;
    };
  };
}

export interface LlmGatewayModelsResponse {
  apiBase: string;
  models: string[];
}

export interface LlmGatewayProxyEndpointCheck {
  ok: boolean;
  status?: number;
  message?: string;
  data?: unknown;
}

export interface LlmGatewayProxyHealthResponse {
  apiBase: string;
  checkedAt: string;
  liveliness: LlmGatewayProxyEndpointCheck;
  readiness: LlmGatewayProxyEndpointCheck;
}

export interface LlmGatewayProxyModelInfoEntry {
  modelName: string;
  litellmParams?: Record<string, unknown>;
  modelInfo?: Record<string, unknown>;
}

export interface LlmGatewayProxyModelInfoResponse {
  apiBase: string;
  checkedAt: string;
  models: LlmGatewayProxyModelInfoEntry[];
}

export interface LlmGatewayProxyLoadBalancingTestResponse {
  apiBase: string;
  model: string;
  attempts: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  checkedAt: string;
  modelIdDistribution: Record<string, number>;
  modelApiBaseDistribution: Record<string, number>;
  callIdSamples: string[];
  errors: {
    message: string;
    status?: number;
    axiosCode?: string;
    requestId?: string;
    upstreamType?: string;
    upstreamCode?: string;
  }[];
}

export interface LlmGatewayProxyLoadBalancingTestFormValues {
  model?: string;
  attempts?: number;
  concurrency?: number;
  prompt?: string;
}

export interface LlmGatewayTestFormValues {
  authMode?: LlmGatewayTestAuthMode;
  includeCompletion: boolean;
  model?: string;
  prompt?: string;
  apiSurface?: "chat_completions" | "responses";
  responseFormatMode?: LlmGatewayResponseFormatMode;
  includeMetadataProbe?: boolean;
  includeEmbeddings: boolean;
  embeddingModel?: string;
  embeddingInput?: string;
  includeRerank: boolean;
  rerankModel?: string;
  rerankQuery?: string;
  rerankDocuments?: string;
}

export interface LlmGatewayFormValues {
  name: string;
  apiBase: string;
  apiKey?: string;
  model?: string;
  assistantModel?: string;
  assistantWebSearchEnabled: boolean;
  embeddingModel?: string;
  rerankModel?: string;
  rerankFallbackModels?: string;
  apiSurface: LlmGatewayApiSurface;
  timeoutMs: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  maxRetries: number;
  fallbackModels?: string;
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
  clearApiKey?: boolean;
  enabled: boolean;
}

export interface LiteLlmProxyLbFormValues {
  enabled: boolean;
  openaiKeys?: string;
  anthropicKeys?: string;
  clearAnthropicKeys?: boolean;
  routingStrategy?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  deploymentRpm?: number;
  deploymentTpm?: number;
}

export interface OpenAiKeysSettingsResponse {
  source: "none" | "db";
  keysCount: number;
  hasKeys: boolean;
  keyFingerprints: string[];
  internalTokenConfigured: boolean;
  appliedAt: string | null;
  appliedSource: "db" | "env" | "none" | null;
  appliedKeyFingerprints: string[];
  restartRequired: boolean;
}

export interface LiteLlmProxyLoadBalancingSettingsResponse {
  source: "none" | "db";
  enabled: boolean;
  openai: OpenAiKeysSettingsResponse;
  anthropicKeysCount: number;
  anthropicKeyFingerprints: string[];
  routingStrategy: string;
  redisHost: string;
  redisPort: number;
  hasRedisPassword: boolean;
  deploymentRpm: number | null;
  deploymentTpm: number | null;
}

export interface LiteLlmProxyGovernanceSettingsResponse {
  source: "default" | "db";
  enabled: boolean;
  apiBase: string | null;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxParallelRequests: number;
  targetProfileId: string | null;
  targetProfileName: string | null;
  targetProfileEnabled: boolean;
  adminKeyConfigured: boolean;
  hasManagedRuntimeKey: boolean;
  managedRuntimeKeyState: LiteLlmManagedRuntimeKeyState;
  managedTeamId: string | null;
  managedRuntimeKeyAlias: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface LiteLlmProxyGovernancePreflightCheck {
  key:
    | "admin_key"
    | "target_profile"
    | "runtime_traffic"
    | "proxy_health"
    | "managed_runtime_key";
  ok: boolean;
  required: boolean;
  message: string;
}

export interface LiteLlmProxyGovernancePreflightResponse {
  targetProfileId: string | null;
  targetProfileName: string | null;
  apiBase: string | null;
  adminKeyConfigured: boolean;
  managedRuntimeKeyState: LiteLlmManagedRuntimeKeyState;
  trafficBindings: {
    completion: boolean;
    embedding: boolean;
    rerank: boolean;
  };
  health: LlmGatewayProxyHealthResponse | null;
  checks: LiteLlmProxyGovernancePreflightCheck[];
  canEnable: boolean;
  blockingIssues: string[];
  warnings: string[];
}

export interface LiteLlmProxyGovernanceFormValues {
  enabled: boolean;
  targetProfileId?: string;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxParallelRequests: number;
}

export interface ObservedUsageSummaryResponse {
  totals: {
    requestCount: number;
    totalTokens: number;
    costUsd: number;
    avgLatencyMs: number;
  };
  statusBreakdown: {
    success: number;
    error: number;
    successRate: number;
    errorRate: number;
  };
  governanceBreakdown: {
    governedRequestCount: number;
    directRequestCount: number;
    governedCostUsd: number;
    directCostUsd: number;
    managedRuntimeKeyRequestCount: number;
    profileKeyRequestCount: number;
  };
  latency: {
    avgMs: number;
    p95Ms: number | null;
  };
  topErrors?: {
    message: string;
    count: number;
  }[];
  leadingError?: {
    message: string;
    count: number;
  } | null;
}

export const EMPTY_SETTINGS: LlmGatewaySettingsResponse = {
  activeId: null,
  embeddingActiveId: null,
  embeddingMode: "follow_completion",
  rerankActiveId: null,
  rerankMode: "follow_completion",
  profiles: [],
};
export const DRAFT_CREATE_KEY = "__draft_create__";
export const DRAFT_EDIT_KEY = "__draft_edit__";
export const FOLLOW_COMPLETION_KEY = "__follow_completion__";
export const USE_DEFAULT_KEY = "__use_default__";
export const DEFAULT_LLM_GATEWAY_API_BASE =
  (process.env.NEXT_PUBLIC_LLM_GATEWAY_DEFAULT_API_BASE ?? "").trim() ||
  "http://localhost:4001";
export const MAX_LLM_GATEWAY_OUTPUT_TOKENS = 1_000_000;
export const GOVERNANCE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GOVERNANCE_MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const EMPTY_OBSERVED_USAGE_SUMMARY: ObservedUsageSummaryResponse = {
  totals: {
    requestCount: 0,
    totalTokens: 0,
    costUsd: 0,
    avgLatencyMs: 0,
  },
  statusBreakdown: {
    success: 0,
    error: 0,
    successRate: 0,
    errorRate: 0,
  },
  governanceBreakdown: {
    governedRequestCount: 0,
    directRequestCount: 0,
    governedCostUsd: 0,
    directCostUsd: 0,
    managedRuntimeKeyRequestCount: 0,
    profileKeyRequestCount: 0,
  },
  latency: {
    avgMs: 0,
    p95Ms: null,
  },
  topErrors: [],
  leadingError: null,
};

export interface LlmGatewayProxyModelInfoSnapshot {
  profileId: string;
  apiBase: string;
  groups: number;
  deployments: number;
  loadBalancedGroups: number;
  checkedAt: string;
}

export interface LlmGatewayModelsSnapshot {
  profileId: string;
  apiBase: string;
  count: number;
  checkedAt: string;
}

export interface LlmGatewayProxyLbTestSnapshot {
  profileId: string;
  apiBase: string;
  model: string;
  succeeded: number;
  failed: number;
  durationMs: number;
  modelIds: number;
  apiBases: number;
  checkedAt: string;
}

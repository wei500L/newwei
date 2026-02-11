export type LlmGatewayResponseFormatMode = "json_schema" | "json_object" | "none";

export type LlmGatewayPresetKey =
  | "litellmDocker"
  | "litellmLocal"
  | "openaiOfficial"
  | "openrouter"
  | "externalConservative"
  | "glm"
  | "kimi"
  | "deepseek"
  | "qwen";

export interface LlmGatewayApiBasePresetRule {
  hostname: string;
  presetKey: LlmGatewayPresetKey;
}

export interface LlmGatewayAutoRecommendationConfig {
  defaultPresetKey: LlmGatewayPresetKey;
  localGatewayHosts: string[];
  domainRules: LlmGatewayApiBasePresetRule[];
}

export interface LlmGatewayApiBaseRecommendation {
  presetKey: LlmGatewayPresetKey;
  hostname: string;
}

export interface LlmGatewayCompatibilityPreset {
  key: LlmGatewayPresetKey;
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
}

interface BuildAutoRecommendationPatchInput<TPreset extends LlmGatewayCompatibilityPreset> {
  apiBase: string;
  baselineApiBase?: string | null;
  presets: readonly TPreset[];
  currentValues: {
    preset?: LlmGatewayPresetKey;
    sendMetadata?: boolean;
    responseFormatMode?: LlmGatewayResponseFormatMode;
  };
  touchedFields: {
    preset: boolean;
    sendMetadata: boolean;
    responseFormatMode: boolean;
  };
  recommendationConfig?: LlmGatewayAutoRecommendationConfig;
}

interface BuildAutoRecommendationPatchResult<TPreset extends LlmGatewayCompatibilityPreset> {
  detected: LlmGatewayApiBaseRecommendation | null;
  recommendedPreset: TPreset | null;
  nextValues: Partial<{
    preset: LlmGatewayPresetKey;
    sendMetadata: boolean;
    responseFormatMode: LlmGatewayResponseFormatMode;
  }>;
  hasChanges: boolean;
}

const PRESET_KEYS: readonly LlmGatewayPresetKey[] = [
  "litellmDocker",
  "litellmLocal",
  "openaiOfficial",
  "openrouter",
  "externalConservative",
  "glm",
  "kimi",
  "deepseek",
  "qwen"
];

const PRESET_KEY_SET = new Set<LlmGatewayPresetKey>(PRESET_KEYS);

function isPresetKey(value: unknown): value is LlmGatewayPresetKey {
  return typeof value === "string" && PRESET_KEY_SET.has(value as LlmGatewayPresetKey);
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

export const DEFAULT_EXTERNAL_GATEWAY_PRESET_KEY: LlmGatewayPresetKey = "externalConservative";

const DEFAULT_LLM_GATEWAY_LOCAL_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal"
] as const;

const DEFAULT_LLM_GATEWAY_API_BASE_RULES: readonly LlmGatewayApiBasePresetRule[] = [
  { hostname: "api.openai.com", presetKey: "openaiOfficial" },
  { hostname: "openrouter.ai", presetKey: "openrouter" },
  { hostname: "open.bigmodel.cn", presetKey: "glm" },
  { hostname: "api.moonshot.cn", presetKey: "kimi" },
  { hostname: "api.deepseek.com", presetKey: "deepseek" },
  { hostname: "dashscope.aliyuncs.com", presetKey: "qwen" },
  { hostname: "litellm", presetKey: "litellmDocker" }
];

export const DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG: LlmGatewayAutoRecommendationConfig = {
  defaultPresetKey: DEFAULT_EXTERNAL_GATEWAY_PRESET_KEY,
  localGatewayHosts: [...DEFAULT_LLM_GATEWAY_LOCAL_HOSTS],
  domainRules: DEFAULT_LLM_GATEWAY_API_BASE_RULES.map((rule) => ({
    hostname: rule.hostname,
    presetKey: rule.presetKey
  }))
};

function resolveAutoRecommendationConfig(
  config?: LlmGatewayAutoRecommendationConfig
): LlmGatewayAutoRecommendationConfig {
  if (!config) {
    return DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG;
  }

  const localGatewayHosts = Array.isArray(config.localGatewayHosts)
    ? Array.from(
        new Set(
          config.localGatewayHosts
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => normalizeHostname(entry))
            .filter((entry) => entry.length > 0)
        )
      )
    : [...DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG.localGatewayHosts];

  const domainRules = Array.isArray(config.domainRules)
    ? config.domainRules
        .filter(
          (entry): entry is LlmGatewayApiBasePresetRule =>
            Boolean(entry) &&
            typeof entry.hostname === "string" &&
            isPresetKey(entry.presetKey)
        )
        .map((entry) => ({
          hostname: normalizeHostname(entry.hostname),
          presetKey: entry.presetKey
        }))
        .filter((entry) => entry.hostname.length > 0)
    : [...DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG.domainRules];

  return {
    defaultPresetKey: isPresetKey(config.defaultPresetKey)
      ? config.defaultPresetKey
      : DEFAULT_LLM_GATEWAY_AUTO_RECOMMENDATION_CONFIG.defaultPresetKey,
    localGatewayHosts,
    domainRules
  };
}

function normalizeApiBasePath(pathname: string): string {
  if (pathname === "/") {
    return "";
  }
  return pathname.replace(/\/+$/g, "");
}

export function normalizeApiBaseForComparison(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = normalizeApiBasePath(parsed.pathname);
    return `${protocol}//${hostname}${port}${pathname}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

export function hasApiBaseChanged(apiBase: string, baselineApiBase?: string | null): boolean {
  if (typeof baselineApiBase !== "string") {
    return normalizeApiBaseForComparison(apiBase).length > 0;
  }
  return normalizeApiBaseForComparison(apiBase) !== normalizeApiBaseForComparison(baselineApiBase);
}

export function detectPresetRecommendationByApiBase(
  apiBase: string,
  config?: LlmGatewayAutoRecommendationConfig
): LlmGatewayApiBaseRecommendation | null {
  try {
    const parsed = new URL(apiBase.trim());
    const hostname = parsed.hostname.toLowerCase();
    const resolvedConfig = resolveAutoRecommendationConfig(config);

    if (resolvedConfig.localGatewayHosts.includes(hostname)) {
      return { presetKey: "litellmLocal", hostname };
    }

    const matchedRule = resolvedConfig.domainRules.find((rule) => rule.hostname === hostname);
    if (matchedRule) {
      return { presetKey: matchedRule.presetKey, hostname };
    }

    return { presetKey: resolvedConfig.defaultPresetKey, hostname };
  } catch {
    return null;
  }
}

export function buildAutoRecommendationPatch<TPreset extends LlmGatewayCompatibilityPreset>(
  input: BuildAutoRecommendationPatchInput<TPreset>
): BuildAutoRecommendationPatchResult<TPreset> {
  if (!hasApiBaseChanged(input.apiBase, input.baselineApiBase)) {
    return {
      detected: null,
      recommendedPreset: null,
      nextValues: {},
      hasChanges: false
    };
  }

  const detected = detectPresetRecommendationByApiBase(input.apiBase, input.recommendationConfig);
  if (!detected) {
    return {
      detected: null,
      recommendedPreset: null,
      nextValues: {},
      hasChanges: false
    };
  }

  const recommendedPreset = input.presets.find((preset) => preset.key === detected.presetKey) ?? null;
  if (!recommendedPreset) {
    return {
      detected,
      recommendedPreset: null,
      nextValues: {},
      hasChanges: false
    };
  }

  const nextValues: BuildAutoRecommendationPatchResult<TPreset>["nextValues"] = {};

  if (!input.touchedFields.preset && input.currentValues.preset !== recommendedPreset.key) {
    nextValues.preset = recommendedPreset.key;
  }

  if (
    !input.touchedFields.sendMetadata &&
    input.currentValues.sendMetadata !== recommendedPreset.sendMetadata
  ) {
    nextValues.sendMetadata = recommendedPreset.sendMetadata;
  }

  if (
    !input.touchedFields.responseFormatMode &&
    input.currentValues.responseFormatMode !== recommendedPreset.responseFormatMode
  ) {
    nextValues.responseFormatMode = recommendedPreset.responseFormatMode;
  }

  return {
    detected,
    recommendedPreset,
    nextValues,
    hasChanges: Object.keys(nextValues).length > 0
  };
}

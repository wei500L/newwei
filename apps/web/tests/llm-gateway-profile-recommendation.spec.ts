import { describe, expect, it } from "vitest";

import {
  buildAutoRecommendationPatch,
  detectPresetRecommendationByApiBase,
  hasApiBaseChanged,
  type LlmGatewayCompatibilityPreset,
  type LlmGatewayPresetKey,
  normalizeApiBaseForComparison
} from "../lib/llm-gateway-profile-recommendation";

const PRESETS: LlmGatewayCompatibilityPreset[] = [
  { key: "openaiOfficial", sendMetadata: true, responseFormatMode: "json_schema" },
  { key: "openrouter", sendMetadata: false, responseFormatMode: "json_object" },
  { key: "externalConservative", sendMetadata: false, responseFormatMode: "none" },
  { key: "litellmLocal", sendMetadata: true, responseFormatMode: "json_schema" },
  { key: "litellmDocker", sendMetadata: true, responseFormatMode: "json_schema" },
  { key: "glm", sendMetadata: false, responseFormatMode: "json_object" },
  { key: "kimi", sendMetadata: false, responseFormatMode: "json_object" },
  { key: "deepseek", sendMetadata: false, responseFormatMode: "json_object" },
  { key: "qwen", sendMetadata: false, responseFormatMode: "json_object" }
];

describe("llm gateway profile recommendation", () => {
  it("detects known domains and local gateway hosts", () => {
    const cases: Array<[string, LlmGatewayPresetKey]> = [
      ["https://api.openai.com/v1", "openaiOfficial"],
      ["https://openrouter.ai/api/v1", "openrouter"],
      ["https://open.bigmodel.cn/api/paas/v4", "glm"],
      ["https://api.moonshot.cn/v1", "kimi"],
      ["https://api.deepseek.com/v1", "deepseek"],
      ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen"],
      ["http://litellm:4000", "litellmDocker"],
      ["http://localhost:4001", "litellmLocal"],
      ["http://host.docker.internal:4001", "litellmLocal"]
    ];

    for (const [url, expectedPreset] of cases) {
      expect(detectPresetRecommendationByApiBase(url)?.presetKey).toBe(expectedPreset);
    }
  });

  it("falls back to external conservative for unknown domains", () => {
    const recommendation = detectPresetRecommendationByApiBase("https://gateway.example.com/v1");
    expect(recommendation).toEqual({
      presetKey: "externalConservative",
      hostname: "gateway.example.com"
    });
  });

  it("returns null for invalid api base", () => {
    expect(detectPresetRecommendationByApiBase("not-a-url")).toBeNull();
  });

  it("supports backend-provided mapping config", () => {
    const recommendation = detectPresetRecommendationByApiBase("https://gateway.company/v1", {
      defaultPresetKey: "openrouter",
      localGatewayHosts: ["internal-gateway"],
      domainRules: [{ hostname: "gateway.company", presetKey: "openaiOfficial" }]
    });

    expect(recommendation).toEqual({
      presetKey: "openaiOfficial",
      hostname: "gateway.company"
    });

    const fallbackRecommendation = detectPresetRecommendationByApiBase("https://unknown.company/v1", {
      defaultPresetKey: "openrouter",
      localGatewayHosts: ["internal-gateway"],
      domainRules: [{ hostname: "gateway.company", presetKey: "openaiOfficial" }]
    });

    expect(fallbackRecommendation?.presetKey).toBe("openrouter");
  });

  it("normalizes api base before comparison", () => {
    expect(normalizeApiBaseForComparison("https://API.OpenAI.com/v1/"))
      .toBe("https://api.openai.com/v1");
    expect(hasApiBaseChanged("https://api.openai.com/v1/", "https://api.openai.com/v1")).toBe(false);
    expect(hasApiBaseChanged("https://api.openai.com/v1?x=1", "https://api.openai.com/v1")).toBe(true);
  });

  it("skips recommendation when api base did not change", () => {
    const result = buildAutoRecommendationPatch({
      apiBase: "https://api.openai.com/v1/",
      baselineApiBase: "https://api.openai.com/v1",
      presets: PRESETS,
      currentValues: {
        preset: "openrouter",
        sendMetadata: false,
        responseFormatMode: "json_object"
      },
      touchedFields: {
        preset: false,
        sendMetadata: false,
        responseFormatMode: false
      }
    });

    expect(result.hasChanges).toBe(false);
    expect(result.nextValues).toEqual({});
    expect(result.recommendedPreset).toBeNull();
  });

  it("applies recommendation only on untouched fields", () => {
    const result = buildAutoRecommendationPatch({
      apiBase: "https://api.openai.com/v1",
      baselineApiBase: "https://gateway.example.com/v1",
      presets: PRESETS,
      currentValues: {
        preset: "externalConservative",
        sendMetadata: false,
        responseFormatMode: "none"
      },
      touchedFields: {
        preset: false,
        sendMetadata: true,
        responseFormatMode: false
      }
    });

    expect(result.detected?.presetKey).toBe("openaiOfficial");
    expect(result.recommendedPreset?.key).toBe("openaiOfficial");
    expect(result.hasChanges).toBe(true);
    expect(result.nextValues).toEqual({
      preset: "openaiOfficial",
      responseFormatMode: "json_schema"
    });
  });

  it("returns no patch when all related fields are touched", () => {
    const result = buildAutoRecommendationPatch({
      apiBase: "https://api.openai.com/v1",
      baselineApiBase: "https://gateway.example.com/v1",
      presets: PRESETS,
      currentValues: {
        preset: "externalConservative",
        sendMetadata: false,
        responseFormatMode: "none"
      },
      touchedFields: {
        preset: true,
        sendMetadata: true,
        responseFormatMode: true
      }
    });

    expect(result.detected?.presetKey).toBe("openaiOfficial");
    expect(result.hasChanges).toBe(false);
    expect(result.nextValues).toEqual({});
  });
});

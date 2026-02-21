import { HealthCheckError } from "@nestjs/terminus";

import type { EnvService } from "../config/config.service";
import type { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";

import { LlmGatewayHealthIndicator } from "./llm-gateway.health";

describe("LlmGatewayHealthIndicator", () => {
  function createIndicator(options?: {
    rerankEnabled?: boolean;
    completionModel?: string | null;
    embeddingModel?: string | null;
    rerankModel?: string | null;
  }) {
    const settingsMock = {
      list: jest.fn().mockResolvedValue({
        activeId: "default",
        embeddingActiveId: null,
        embeddingMode: "follow_completion",
        rerankActiveId: null,
        rerankMode: "follow_completion",
        profiles: [],
      }),
      getActiveConfig: jest.fn().mockResolvedValue(
        options?.completionModel === null
          ? null
          : {
              model: options?.completionModel ?? "openai/gpt-4o-mini",
            },
      ),
      getActiveEmbeddingConfig: jest.fn().mockResolvedValue(
        options?.embeddingModel === null
          ? null
          : {
              embeddingModel:
                options?.embeddingModel ?? "openai/text-embedding-3-small",
            },
      ),
      getActiveRerankConfig: jest.fn().mockResolvedValue(
        options?.rerankModel === null
          ? null
          : {
              rerankModel: options?.rerankModel ?? "cohere/rerank-v3.5",
            },
      ),
    } as unknown as LlmGatewaySettingsService;

    const envMock = {
      itemsSearchRankingConfig: {
        rerankEnabled: options?.rerankEnabled ?? true,
      },
    } as unknown as EnvService;

    return new LlmGatewayHealthIndicator(settingsMock, envMock);
  }

  it("returns healthy status when completion and rerank models are configured", async () => {
    const indicator = createIndicator();
    const result = await indicator.isHealthy("llmGateway");

    expect(result.llmGateway.status).toBe("up");
    expect(result.llmGateway.completionReady).toBe(true);
    expect(result.llmGateway.rerankReady).toBe(true);
    expect(result.llmGateway.rerankRequired).toBe(true);
  });

  it("fails when completion model is missing", async () => {
    const indicator = createIndicator({ completionModel: null });

    await expect(indicator.isHealthy("llmGateway")).rejects.toThrow(
      HealthCheckError,
    );
  });

  it("fails when rerank is enabled but rerank model is missing", async () => {
    const indicator = createIndicator({
      rerankEnabled: true,
      rerankModel: null,
    });

    await expect(indicator.isHealthy("llmGateway")).rejects.toThrow(
      HealthCheckError,
    );
  });

  it("stays healthy when rerank is disabled and rerank model is missing", async () => {
    const indicator = createIndicator({
      rerankEnabled: false,
      rerankModel: null,
    });

    const result = await indicator.isHealthy("llmGateway");
    expect(result.llmGateway.status).toBe("up");
    expect(result.llmGateway.rerankRequired).toBe(false);
    expect(result.llmGateway.rerankReady).toBe(false);
  });
});

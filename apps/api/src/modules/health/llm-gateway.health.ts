import { Injectable } from "@nestjs/common";
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

import { EnvService } from "../config/config.service";
import { LlmGatewaySettingsService } from "../system-settings/llm-gateway-settings.service";

@Injectable()
export class LlmGatewayHealthIndicator extends HealthIndicator {
  constructor(
    private readonly settings: LlmGatewaySettingsService,
    private readonly env: EnvService,
  ) {
    super();
  }

  async isHealthy(key = "llmGateway"): Promise<HealthIndicatorResult> {
    try {
      // Bound the check: the four settings queries are direct DB reads with
      // no timeout of their own, and Terminus waits for the slowest check.
      // When MySQL is wedged this would otherwise hang the whole /healthz
      // probe and make load balancers think the instance is down.
      const [
        settingsState,
        completionCfg,
        embeddingCfg,
        rerankCfg,
      ] = await withTimeout(
        Promise.all([
          this.settings.list(),
          this.settings.getActiveConfig(),
          this.settings.getActiveEmbeddingConfig(),
          this.settings.getActiveRerankConfig(),
        ]),
        2_000,
      );

      const completionReady = Boolean(completionCfg?.model?.trim());
      const embeddingReady = Boolean(embeddingCfg?.embeddingModel?.trim());
      const rerankReady = Boolean(rerankCfg?.rerankModel?.trim());
      const rerankRequired = this.env.itemsSearchRankingConfig.rerankEnabled;

      const detail = {
        completionReady,
        embeddingReady,
        rerankReady,
        rerankRequired,
        activeProfileId: settingsState.activeId,
        embeddingActiveProfileId: settingsState.embeddingActiveId,
        rerankActiveProfileId: settingsState.rerankActiveId,
      };

      if (!completionReady) {
        const result = this.getStatus(key, false, {
          ...detail,
          message:
            "LLM gateway completion model is not configured in MySQL profiles",
        });
        throw new HealthCheckError(
          "LLM gateway completion profile is not ready",
          result,
        );
      }

      if (rerankRequired && !rerankReady) {
        const result = this.getStatus(key, false, {
          ...detail,
          message:
            "LLM gateway rerank model is required but not configured in MySQL profiles",
        });
        throw new HealthCheckError(
          "LLM gateway rerank profile is not ready",
          result,
        );
      }

      return this.getStatus(key, true, detail);
    } catch (error) {
      if (error instanceof HealthCheckError) {
        throw error;
      }
      const result = this.getStatus(key, false, {
        message:
          error instanceof Error
            ? error.message
            : "Unknown LLM gateway health error",
      });
      throw new HealthCheckError("LLM gateway health check failed", result);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`LLM gateway health check timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

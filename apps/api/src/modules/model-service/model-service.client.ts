import { createLogger } from "@modular/utils";
import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import type { AxiosError } from "axios";
import { createHash } from "node:crypto";
import { firstValueFrom } from "rxjs";

import { ModelServiceSettingsService } from "../system-settings/model-service-settings.service";

const logger = createLogger({ name: "model-service-client" });

export type ModelServiceModelKind = "arima" | "ets";

export interface ModelServiceSeriesPoint {
  timestamp: string;
  value: number;
}

export interface ModelServiceForecastHoldoutLastRequest {
  series: ModelServiceSeriesPoint[];
  confidence_level?: number;
  model?: {
    kind: ModelServiceModelKind;
    order?: [number, number, number];
    seasonal_order?: [number, number, number, number];
    seasonal_period?: number;
    trend?: string;
  };
  request_id?: string;
}

export interface ModelServiceForecastHoldoutLastResponse {
  model: {
    kind: ModelServiceModelKind;
    order?: [number, number, number] | null;
    seasonal_order?: [number, number, number, number] | null;
    seasonal_period?: number | null;
    trend?: string | null;
  };
  forecast: {
    timestamp: string;
    expected: number;
    lower: number;
    upper: number;
    sigma: number;
  };
  diagnostics: Record<string, unknown>;
}

@Injectable()
export class ModelServiceClient {
  private consecutiveFailures = 0;
  private unavailableUntilMs = 0;
  private lastIncompleteWarnAtMs = 0;
  private configFingerprint: string | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly settings: ModelServiceSettingsService
  ) {}

  async forecastHoldoutLastOrThrow(input: {
    series: ModelServiceSeriesPoint[];
    model: { kind: ModelServiceModelKind; seasonalPeriod?: number; confidenceLevel?: number };
    requestId?: string;
  }): Promise<ModelServiceForecastHoldoutLastResponse> {
    const cfg = await this.settings.getEffectiveConfig();
    this.refreshFingerprint(cfg);
    if (!cfg.enabled) {
      throw new Error("Model service is disabled");
    }
    if (!cfg.baseUrl) {
      this.warnIncompleteOnce({ baseUrl: cfg.baseUrl, tokenConfigured: Boolean(cfg.internalToken) });
      throw new Error("Model service baseUrl is not configured");
    }
    if (!cfg.internalToken) {
      this.warnIncompleteOnce({ baseUrl: cfg.baseUrl, tokenConfigured: false });
      throw new Error("Model service internal token is not configured");
    }
    if (this.isTemporarilyUnavailable()) {
      throw new Error("Model service is temporarily unavailable");
    }

    const url = `${this.normalizeBaseUrl(cfg.baseUrl)}/v1/forecast/holdout_last`;
    const payload: ModelServiceForecastHoldoutLastRequest = {
      series: input.series,
      confidence_level: input.model.confidenceLevel ?? 0.95,
      model: {
        kind: input.model.kind,
        ...(typeof input.model.seasonalPeriod === "number" && Number.isFinite(input.model.seasonalPeriod)
          ? { seasonal_period: Math.max(0, Math.trunc(input.model.seasonalPeriod)) }
          : {})
      },
      ...(input.requestId ? { request_id: input.requestId } : {})
    };

    const maxRetries = Math.min(Math.max(Math.trunc(cfg.maxRetries), 0), 5);
    const attempts = maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await firstValueFrom(
          this.http.post<ModelServiceForecastHoldoutLastResponse>(url, payload, {
            headers: { "x-internal-token": cfg.internalToken },
            timeout: cfg.timeoutMs
          })
        );
        this.markAvailable();
        return response.data;
      } catch (error) {
        const decision = this.classifyError(error);
        if (decision === "unauthorized") {
          this.markUnavailable(error);
          throw new Error("Model service request unauthorized");
        }
        if (decision === "non_retryable") {
          throw new Error(this.formatError("Model service request failed", error));
        }
        if (attempt >= attempts - 1) {
          this.markUnavailable(error);
          throw new Error(this.formatError("Model service request failed", error));
        }
        const delayMs = this.computeRetryDelayMs(attempt);
        await this.delay(delayMs);
      }
    }

    throw new Error("Model service request failed");
  }

  async forecastHoldoutLastBestEffort(input: {
    series: ModelServiceSeriesPoint[];
    model: { kind: ModelServiceModelKind; seasonalPeriod?: number; confidenceLevel?: number };
    requestId?: string;
  }): Promise<ModelServiceForecastHoldoutLastResponse | null> {
    const cfg = await this.settings.getEffectiveConfig();
    this.refreshFingerprint(cfg);
    if (!cfg.enabled) {
      return null;
    }
    if (!cfg.baseUrl) {
      this.warnIncompleteOnce({ baseUrl: cfg.baseUrl, tokenConfigured: Boolean(cfg.internalToken) });
      return null;
    }
    if (!cfg.internalToken) {
      this.warnIncompleteOnce({ baseUrl: cfg.baseUrl, tokenConfigured: false });
      return null;
    }
    if (this.isTemporarilyUnavailable()) {
      return null;
    }

    const url = `${this.normalizeBaseUrl(cfg.baseUrl)}/v1/forecast/holdout_last`;
    const payload: ModelServiceForecastHoldoutLastRequest = {
      series: input.series,
      confidence_level: input.model.confidenceLevel ?? 0.95,
      model: {
        kind: input.model.kind,
        ...(typeof input.model.seasonalPeriod === "number" && Number.isFinite(input.model.seasonalPeriod)
          ? { seasonal_period: Math.max(0, Math.trunc(input.model.seasonalPeriod)) }
          : {})
      },
      ...(input.requestId ? { request_id: input.requestId } : {})
    };

    const maxRetries = Math.min(Math.max(Math.trunc(cfg.maxRetries), 0), 5);
    const attempts = maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await firstValueFrom(
          this.http.post<ModelServiceForecastHoldoutLastResponse>(url, payload, {
            headers: { "x-internal-token": cfg.internalToken },
            timeout: cfg.timeoutMs
          })
        );
        this.markAvailable();
        return response.data;
      } catch (error) {
        const decision = this.classifyError(error);
        if (decision === "unauthorized") {
          this.markUnavailable(error);
          return null;
        }
        if (decision === "non_retryable") {
          return null;
        }
        if (attempt >= attempts - 1) {
          this.markUnavailable(error);
          return null;
        }
        const delayMs = this.computeRetryDelayMs(attempt);
        await this.delay(delayMs);
      }
    }
    return null;
  }

  private normalizeBaseUrl(baseUrl: string) {
    return baseUrl.trim().replace(/\/+$/, "");
  }

  private warnIncompleteOnce(context: { baseUrl?: string | null; tokenConfigured?: boolean }) {
    const now = Date.now();
    if (now - this.lastIncompleteWarnAtMs < 60_000) {
      return;
    }
    this.lastIncompleteWarnAtMs = now;
    logger.warn(context, "Model service enabled but configuration is incomplete");
  }

  private refreshFingerprint(cfg: { enabled: boolean; baseUrl?: string; internalToken?: string; timeoutMs: number; maxRetries: number }) {
    const tokenHash = cfg.internalToken
      ? createHash("sha256").update(cfg.internalToken).digest("hex").slice(0, 16)
      : "none";
    const fingerprint = `${cfg.enabled ? 1 : 0}|${cfg.baseUrl ?? ""}|${cfg.timeoutMs}|${cfg.maxRetries}|${tokenHash}`;
    if (this.configFingerprint === fingerprint) {
      return;
    }
    this.configFingerprint = fingerprint;
    this.markAvailable();
  }

  private isTemporarilyUnavailable(): boolean {
    return Date.now() < this.unavailableUntilMs;
  }

  private markAvailable() {
    this.consecutiveFailures = 0;
    this.unavailableUntilMs = 0;
  }

  private markUnavailable(error: unknown) {
    const now = Date.now();
    const wasAvailable = now >= this.unavailableUntilMs;

    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 10);
    const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, this.consecutiveFailures - 1));
    this.unavailableUntilMs = now + backoffMs;

    if (!wasAvailable) {
      return;
    }

    logger.warn({ error, backoffMs, consecutiveFailures: this.consecutiveFailures }, "Model service request failed; temporarily disabling");
  }

  private classifyError(error: unknown): "retryable" | "non_retryable" | "unauthorized" {
    const axiosError = error as AxiosError | undefined;
    const status = typeof axiosError?.response?.status === "number" ? axiosError.response.status : null;
    if (status === 401) {
      return "unauthorized";
    }
    if (status !== null) {
      if (status === 408 || status === 429) {
        return "retryable";
      }
      if (status >= 400 && status < 500) {
        return "non_retryable";
      }
      if (status >= 500 && status <= 599) {
        return "retryable";
      }
      return "non_retryable";
    }

    const code = typeof (axiosError as any)?.code === "string" ? (axiosError as any).code : null;
    if (code) {
      return "retryable";
    }
    return "retryable";
  }

  private formatError(prefix: string, error: unknown): string {
    const axiosError = error as AxiosError | undefined;
    const status = typeof axiosError?.response?.status === "number" ? axiosError.response.status : null;

    const responseData = axiosError?.response?.data;
    let detail: string | null = null;
    if (typeof responseData === "string" && responseData.trim()) {
      detail = responseData.trim();
    } else if (responseData && typeof responseData === "object") {
      const rawDetail = (responseData as any)?.detail;
      if (typeof rawDetail === "string" && rawDetail.trim()) {
        detail = rawDetail.trim();
      } else {
        try {
          detail = JSON.stringify(responseData);
        } catch {
          detail = null;
        }
      }
    }

    const base = status !== null ? `${prefix} (status=${status})` : prefix;
    if (detail) {
      return `${base}: ${detail}`;
    }
    const message = axiosError instanceof Error ? axiosError.message : String(error);
    return `${base}: ${message}`;
  }

  private computeRetryDelayMs(attempt: number): number {
    const base = Math.min(5_000, 200 * 2 ** Math.max(0, attempt));
    const jitter = Math.floor(Math.random() * 150);
    return base + jitter;
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

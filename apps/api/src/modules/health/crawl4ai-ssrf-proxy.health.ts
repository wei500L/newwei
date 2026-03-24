import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from "@nestjs/terminus";
import { lastValueFrom } from "rxjs";

import { EnvService } from "../config/config.service";
import { CrawlSettingsService } from "../crawl/crawl-settings.service";

const SSRF_PROXY_PROBE_URL = "https://example.com/";

interface CrawlProbeResponse {
  results?: Array<{
    success?: boolean;
    error_message?: string;
    errorMessage?: string;
    error?: string;
  }>;
  error?: string;
}

interface Crawl4aiSsrfProxyProbe {
  ok: boolean;
  url?: string;
  durationMs: number;
  message?: string;
}

function normalizeErrorMessage(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value instanceof Error && value.message.trim()) {
    return value.message.trim();
  }
  return undefined;
}

@Injectable()
export class Crawl4aiSsrfProxyHealthIndicator extends HealthIndicator {
  private cachedProbe:
    | {
        value: Crawl4aiSsrfProxyProbe;
        expiresAt: number;
      }
    | null = null;
  private inFlightProbe: Promise<Crawl4aiSsrfProxyProbe> | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService,
    private readonly crawlSettings: CrawlSettingsService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const probe = await this.getProbe();
    if (probe.ok) {
      return this.getStatus(key, true, {
        url: probe.url,
        durationMs: probe.durationMs,
      });
    }
    const message = probe.message ?? "crawl4ai SSRF proxy probe failed";
    const result = this.getStatus(key, false, {
      url: probe.url,
      durationMs: probe.durationMs,
      message,
    });
    throw new HealthCheckError(message, result);
  }

  private async getProbe(): Promise<Crawl4aiSsrfProxyProbe> {
    const cached = this.cachedProbe;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (this.inFlightProbe) {
      return this.inFlightProbe;
    }

    this.inFlightProbe = this.runProbe()
      .then(async (probe) => {
        const ttlMs = await this.resolveTtlMs();
        this.cachedProbe = {
          value: probe,
          expiresAt: Date.now() + ttlMs,
        };
        return probe;
      })
      .finally(() => {
        this.inFlightProbe = null;
      });

    return this.inFlightProbe;
  }

  private async runProbe(): Promise<Crawl4aiSsrfProxyProbe> {
    const configuredProxyUrl = (this.env.crawl4aiConfig as {
      ssrfProxyUrl?: string;
    }).ssrfProxyUrl;
    const proxyUrl =
      typeof configuredProxyUrl === "string"
        ? configuredProxyUrl.trim()
        : undefined;
    if (!proxyUrl) {
      return {
        ok: false,
        durationMs: 0,
        message: "crawl4ai SSRF proxy is not configured",
      };
    }

    const startedAt = Date.now();
    const timeout = Math.min(5_000, this.env.crawl4aiConfig.timeoutMs);
    try {
      const response = await lastValueFrom(
        this.http.post<CrawlProbeResponse>(
          "/crawl",
          {
            urls: [SSRF_PROXY_PROBE_URL],
            browser_config: {
              type: "BrowserConfig",
              params: {
                headless: true,
                proxy_config: {
                  server: proxyUrl,
                },
              },
            },
            crawler_config: {
              type: "CrawlerRunConfig",
              params: {
                cache_mode: "bypass",
                only_text: true,
                word_count_threshold: 5,
                exclude_external_links: true,
                remove_overlay_elements: true,
                process_iframes: true,
              },
            },
          },
          { timeout },
        ),
      );

      const first = response.data?.results?.[0];
      if (first?.success === true) {
        return {
          ok: true,
          url: proxyUrl,
          durationMs: Date.now() - startedAt,
        };
      }

      const message =
        normalizeErrorMessage(first?.error_message) ??
        normalizeErrorMessage(first?.errorMessage) ??
        normalizeErrorMessage(first?.error) ??
        normalizeErrorMessage(response.data?.error) ??
        "crawl4ai SSRF proxy probe failed";
      return {
        ok: false,
        url: proxyUrl,
        durationMs: Date.now() - startedAt,
        message,
      };
    } catch (error) {
      const message =
        normalizeErrorMessage(error) ?? "crawl4ai SSRF proxy probe failed";
      return {
        ok: false,
        url: proxyUrl,
        durationMs: Date.now() - startedAt,
        message,
      };
    }
  }

  private async resolveTtlMs(): Promise<number> {
    try {
      const settings = await this.crawlSettings.getSettings();
      if (Number.isFinite(settings.healthCheckTtlMs) && settings.healthCheckTtlMs > 0) {
        return Math.max(1_000, Math.round(settings.healthCheckTtlMs));
      }
    } catch {
      // fall back to env defaults when crawl settings are unavailable
    }
    const fallback = this.env.crawl4aiConfig.healthCheckTtlMs ?? 60_000;
    return Math.max(1_000, Math.round(fallback));
  }
}

import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from "@nestjs/terminus";
import { lastValueFrom } from "rxjs";

import { EnvService } from "../config/config.service";

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
  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const configuredProxyUrl = (this.env.crawl4aiConfig as {
      ssrfProxyUrl?: string;
    }).ssrfProxyUrl;
    const proxyUrl =
      typeof configuredProxyUrl === "string"
        ? configuredProxyUrl.trim()
        : undefined;
    if (!proxyUrl) {
      const result = this.getStatus(key, false, {
        message: "crawl4ai SSRF proxy is not configured",
      });
      throw new HealthCheckError("crawl4ai SSRF proxy is not configured", result);
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
        return this.getStatus(key, true, {
          url: proxyUrl,
          durationMs: Date.now() - startedAt,
        });
      }

      const message =
        normalizeErrorMessage(first?.error_message) ??
        normalizeErrorMessage(first?.errorMessage) ??
        normalizeErrorMessage(first?.error) ??
        normalizeErrorMessage(response.data?.error) ??
        "crawl4ai SSRF proxy probe failed";
      const result = this.getStatus(key, false, {
        url: proxyUrl,
        durationMs: Date.now() - startedAt,
        message,
      });
      throw new HealthCheckError(message, result);
    } catch (error) {
      const message =
        normalizeErrorMessage(error) ?? "crawl4ai SSRF proxy probe failed";
      const result = this.getStatus(key, false, {
        url: proxyUrl,
        durationMs: Date.now() - startedAt,
        message,
      });
      throw new HealthCheckError(message, result);
    }
  }
}

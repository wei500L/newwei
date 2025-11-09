import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import type { AxiosError } from "axios";
import { lastValueFrom } from "rxjs";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import type { CrawlTaskOptions } from "./crawl.types";

export interface Crawl4aiRequest {
  url: string;
  keywords?: string[];
  options?: CrawlTaskOptions;
}

export interface Crawl4aiArticle {
  url?: string;
  markdown?: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Crawl4aiResponse {
  runId?: string | null;
  nextCursor?: string | null;
  warnings?: string[];
  results: Crawl4aiArticle[];
  serverMemoryMb?: number;
  peakMemoryMb?: number;
  memoryEfficiency?: number;
}

interface Crawl4aiHttpPayload {
  urls: string[];
  keywords?: string[];
  browser_config: {
    type: string;
    params: Record<string, unknown>;
  };
  crawler_config: {
    type: string;
    params: Record<string, unknown>;
  };
}

@Injectable()
export class Crawl4aiClient {
  private lastHealthCheck = 0;
  private readonly healthCheckTtlMs = 60_000;

  constructor(private readonly http: HttpService) {}

  async crawl(request: Crawl4aiRequest): Promise<Crawl4aiResponse> {
    await this.ensureHealthy();
    const payload = this.toHttpPayload(request);
    try {
      const response = await lastValueFrom(
        this.http.post<Crawl4aiResponse>("/crawl", payload, {
          headers: {
            "content-type": "application/json"
          }
        })
      );
      return {
        results: response.data?.results ?? [],
        nextCursor: response.data?.nextCursor ?? null,
        runId: response.data?.runId ?? null,
        warnings: response.data?.warnings ?? [],
        serverMemoryMb: response.data?.serverMemoryMb,
        peakMemoryMb: response.data?.peakMemoryMb,
        memoryEfficiency: response.data?.memoryEfficiency
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ message?: string }>;
      const status = axiosError.response?.status;
      const message =
        axiosError.response?.data?.message ||
        axiosError.message ||
        "crawl4ai request failed";
      throw new Crawl4aiRequestException(message, status, error);
    }
  }

  private async ensureHealthy() {
    const now = Date.now();
    if (now - this.lastHealthCheck < this.healthCheckTtlMs) {
      return;
    }
    try {
      await lastValueFrom(this.http.get("/health"));
      this.lastHealthCheck = now;
    } catch (error) {
      throw new Crawl4aiRequestException("crawl4ai health check failed", undefined, error);
    }
  }

  private toHttpPayload(request: Crawl4aiRequest): Crawl4aiHttpPayload {
    const options = request.options ?? {};
    const scrollDelay = typeof options.scrollDelayMs === "number" ? options.scrollDelayMs / 1000 : undefined;
    const headless = options.enableUndetectedBrowser || options.enableStealthMode ? false : true;
    const proxyPayload = this.resolveProxyPayload(options);
    const browserConfig = {
      type: "BrowserConfig",
      params: this.compact({
        headless,
        enable_stealth: options.enableStealthMode ?? undefined,
        browser_type: options.enableUndetectedBrowser ? "undetected" : undefined,
        disable_images: options.includeImages === false ? true : undefined,
        emulate_mobile: false,
        proxy_config: proxyPayload
      })
    };
    const crawlerConfig = {
      type: "CrawlerRunConfig",
      params: this.compact({
        cache_mode: options.cacheMode ?? "bypass",
        only_main_content: options.onlyMainContent ?? true,
        extract_links: options.extractLinks ?? false,
        scan_full_page: options.scanFullPage ?? false,
        scroll_delay: scrollDelay,
        simulate_user: options.simulateUser ?? undefined,
        override_navigator: options.overrideNavigator ?? undefined,
        magic: options.enableStealthMode ?? undefined
      })
    };
    return {
      urls: [request.url],
      keywords: request.keywords && request.keywords.length > 0 ? request.keywords : undefined,
      browser_config: browserConfig,
      crawler_config: crawlerConfig
    };
  }

  private compact(record: Record<string, unknown>) {
    return Object.entries(record).reduce<Record<string, unknown>>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  private resolveProxyPayload(options: CrawlTaskOptions) {
    if (options.proxyConfig) {
      return this.compact({
        server: options.proxyConfig.server,
        username: options.proxyConfig.username ?? undefined,
        password: options.proxyConfig.password ?? undefined
      });
    }
    if (options.proxyUrl) {
      return options.proxyUrl;
    }
    return undefined;
  }
}

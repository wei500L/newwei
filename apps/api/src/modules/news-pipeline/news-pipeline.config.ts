import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import {
  EnvService,
  LiteLlmEnvConfig,
  NewsPipelineEnvConfig,
} from "../config/config.service";
import {
  CrawlCleanMarkdownOptions,
  CrawlMarkdownOptions,
  CrawlTaskOptions,
  CrawlVirtualScrollConfig,
  CrawlVirtualScrollMode,
} from "../crawl/crawl.types";

export interface LiteLlmConfig extends LiteLlmEnvConfig {
  stream: boolean;
  responseFormat: "json_schema" | "text";
}

export interface Crawl4aiPipelineConfig {
  userAgent: string;
  maxConcurrent: number;
  timeoutMs: number;
  keywordMatchThreshold: number;
  markdown?: CrawlMarkdownOptions;
  cleanMarkdown?: CrawlCleanMarkdownOptions;
  crawlerDefaults: CrawlTaskOptions;
  virtualScroll?: CrawlVirtualScrollConfig;
}

export interface PipelineRuntimeConfig
  extends Omit<NewsPipelineEnvConfig, "configPath"> {
  summaryMaxTokens: number;
  rateLimitWindowSeconds: number;
  allowMediaEmbedding: boolean;
  detectLanguage: boolean;
  summaryDedupEnabled: boolean;
  summaryDedupThreshold: number;
  summaryDedupLookbackHours: number;
  summaryDedupMaxCandidates: number;
  summaryDedupMinChars: number;
}

export interface NewsPipelineConfig {
  litellm: LiteLlmConfig;
  crawl4ai: Crawl4aiPipelineConfig;
  pipeline: PipelineRuntimeConfig;
}

interface LiteLlmFileConfig {
  model?: string;
  embedding_model?: string;
  api_base?: string;
  api_key?: string;
  timeout_ms?: number;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  max_retries?: number;
  fallback_models?: string[];
  requests_per_minute?: number;
  stream?: boolean;
  response_format?: "json_schema" | "text";
}

interface Crawl4aiFileConfig {
  user_agent?: string;
  max_concurrent?: number;
  timeout_ms?: number;
  keyword_match_threshold?: number;
  markdown?: CrawlMarkdownOptions;
  clean_markdown?: CrawlCleanMarkdownOptions;
  crawler_defaults?: CrawlTaskOptions;
  virtual_scroll?: CrawlVirtualScrollConfig & {
    enabled?: boolean;
    scroll_by?: CrawlVirtualScrollMode;
  };
}

interface PipelineFileConfig {
  cache_ttl_seconds?: number;
  max_input_characters?: number;
  summary_max_tokens?: number;
  rate_limit_window_seconds?: number;
  allow_media_embedding?: boolean;
  detect_language?: boolean;
  summary_dedup_enabled?: boolean;
  summary_dedup_threshold?: number;
  summary_dedup_lookback_hours?: number;
  summary_dedup_max_candidates?: number;
  summary_dedup_min_chars?: number;
}

interface PipelineConfigFile {
  litellm_config?: LiteLlmFileConfig;
  crawl4ai_config?: Crawl4aiFileConfig;
  pipeline?: PipelineFileConfig;
}

@Injectable()
export class NewsPipelineConfigService implements OnModuleDestroy {
  private readonly logger = new Logger(NewsPipelineConfigService.name);
  private readonly configPath: string;
  private configWatcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private currentConfig: NewsPipelineConfig;

  constructor(private readonly env: EnvService) {
    this.configPath = this.resolveConfigPath(env.newsPipelineEnv.configPath);
    this.currentConfig = this.loadFromDisk();
    this.registerWatcherIfExists();
  }

  onModuleDestroy() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.configWatcher?.close();
    this.configWatcher = undefined;
  }

  get config(): NewsPipelineConfig {
    return this.currentConfig;
  }

  private resolveConfigPath(rawValue: string) {
    if (path.isAbsolute(rawValue)) {
      return rawValue;
    }
    const candidates = [
      path.resolve(process.cwd(), rawValue),
      path.resolve(process.cwd(), "..", rawValue),
      path.resolve(process.cwd(), "..", "..", rawValue),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0];
  }

  private registerWatcherIfExists() {
    const configDir = path.dirname(this.configPath);
    if (!existsSync(configDir)) {
      this.logger.warn(
        `News pipeline config directory missing at ${configDir}; skipping config watch.`,
      );
      return;
    }

    if (!existsSync(this.configPath)) {
      this.logger.warn(
        `News pipeline config file missing at ${this.configPath}; using defaults/ENV overrides.`,
      );
    }

    const targetFile = path.basename(this.configPath);
    this.configWatcher = watch(
      configDir,
      { persistent: false },
      (eventType, filename) => {
        const observed = filename?.toString();
        if (observed) {
          if (observed !== targetFile) {
            return;
          }
        } else if (!existsSync(this.configPath)) {
          return;
        }
        this.scheduleReload(eventType);
      },
    );
    this.configWatcher.on("error", (error) => {
      this.logger.error("News pipeline config watcher error", error as Error);
    });
  }

  private scheduleReload(eventType: string) {
    if (eventType !== "change" && eventType !== "rename") {
      return;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => this.reloadFromDisk(), 200);
  }

  private reloadFromDisk() {
    try {
      this.currentConfig = this.loadFromDisk();
      this.logger.log(`Reloaded news pipeline config from ${this.configPath}`);
    } catch (error) {
      this.logger.error("Failed to reload news pipeline config", error as Error);
    }
  }

  private loadFromDisk(): NewsPipelineConfig {
    let rawConfig: PipelineConfigFile = {};
    if (existsSync(this.configPath)) {
      try {
        const file = readFileSync(this.configPath, "utf8");
        rawConfig = (parse(file) as PipelineConfigFile) ?? {};
      } catch (error) {
        this.logger.warn(
          `Failed parsing news pipeline config at ${this.configPath}: ${(error as Error).message}`,
        );
      }
    }
    return this.normalizeConfig(rawConfig);
  }

  private normalizeConfig(raw: PipelineConfigFile): NewsPipelineConfig {
    return {
      litellm: this.normalizeLiteLlmConfig(raw.litellm_config),
      crawl4ai: this.normalizeCrawlConfig(raw.crawl4ai_config),
      pipeline: this.normalizePipelineConfig(raw.pipeline),
    };
  }

  private normalizeLiteLlmConfig(raw?: LiteLlmFileConfig): LiteLlmConfig {
    const envConfig = this.env.liteLlmConfig;
    const fallbackModels =
      envConfig.fallbackModels.length > 0
        ? envConfig.fallbackModels
        : (raw?.fallback_models?.filter(
            (entry) => typeof entry === "string" && entry.length > 0,
          ) ?? []);
    const apiBase = raw?.api_url ?? raw?.api_base ?? envConfig.apiBase;
    const maxTokens = raw?.max_tokens ?? raw?.max_output_tokens;
    const retryAttempts = raw?.retry_attempts ?? raw?.max_retries;
    return {
      model: raw?.model ?? envConfig.model,
      embeddingModel: raw?.embedding_model ?? envConfig.embeddingModel,
      apiBase,
      apiKey: envConfig.apiKey ?? raw?.api_key,
      timeoutMs: this.ensurePositive(raw?.timeout_ms, envConfig.timeoutMs),
      temperature: this.clamp(raw?.temperature ?? envConfig.temperature, 0, 2),
      topP: this.clamp(raw?.top_p ?? envConfig.topP, 0, 1),
      maxOutputTokens: this.ensurePositive(
        maxTokens,
        envConfig.maxOutputTokens,
      ),
      maxRetries: this.ensurePositiveInt(retryAttempts, envConfig.maxRetries),
      fallbackModels,
      requestsPerMinute: this.ensurePositiveInt(
        raw?.requests_per_minute,
        envConfig.requestsPerMinute,
      ),
      stream: raw?.stream ?? false,
      responseFormat: raw?.response_format ?? "json_schema",
    };
  }

  private normalizeCrawlConfig(
    raw?: Crawl4aiFileConfig,
  ): Crawl4aiPipelineConfig {
    const crawlEnv = this.env.crawl4aiConfig;
    const markdown = raw?.markdown;
    const cleanMarkdown = raw?.clean_markdown;
    const crawlerDefaults = {
      scanFullPage: raw?.crawler_defaults?.scanFullPage ?? true,
      adjustViewportToContent:
        raw?.crawler_defaults?.adjustViewportToContent ?? true,
      waitForImages: raw?.crawler_defaults?.waitForImages ?? true,
      excludeExternalLinks: raw?.crawler_defaults?.excludeExternalLinks ?? true,
      processIframes: raw?.crawler_defaults?.processIframes ?? true,
      cssSelector: raw?.crawler_defaults?.cssSelector,
      excludedTags: raw?.crawler_defaults?.excludedTags,
      scoreLinks: raw?.crawler_defaults?.scoreLinks ?? false,
      wordCountThreshold: raw?.crawler_defaults?.wordCountThreshold ?? 120,
      cleanMarkdown,
      markdownOptions: markdown,
      virtualScroll: raw?.virtual_scroll?.enabled
        ? this.normalizeVirtualScroll(raw.virtual_scroll)
        : undefined,
      captureScreenshot: raw?.crawler_defaults?.captureScreenshot ?? false,
      simulateUser: raw?.crawler_defaults?.simulateUser ?? true,
      overrideNavigator: raw?.crawler_defaults?.overrideNavigator ?? true,
    } satisfies CrawlTaskOptions;

    return {
      userAgent:
        typeof raw?.user_agent === "string" && raw.user_agent.length > 5
          ? raw.user_agent
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      maxConcurrent: this.ensurePositiveInt(
        raw?.max_concurrent,
        crawlEnv.maxConcurrency,
      ),
      timeoutMs: this.ensurePositive(raw?.timeout_ms, crawlEnv.timeoutMs),
      keywordMatchThreshold: this.clamp(
        raw?.keyword_match_threshold ?? 0.55,
        0,
        1,
      ),
      markdown,
      cleanMarkdown,
      crawlerDefaults,
      virtualScroll: crawlerDefaults.virtualScroll,
    };
  }

  private normalizeVirtualScroll(
    config: CrawlVirtualScrollConfig & { scroll_by?: CrawlVirtualScrollMode },
  ) {
    return {
      containerSelector: config.containerSelector ?? "body",
      scrollCount: this.ensurePositiveInt(config.scrollCount, 3),
      scrollBy:
        config.scroll_by ??
        config.scrollBy ??
        ("viewport" as CrawlVirtualScrollMode),
      waitAfterScrollMs: this.ensurePositive(config.waitAfterScrollMs, 600),
    };
  }

  private normalizePipelineConfig(
    raw?: PipelineFileConfig,
  ): PipelineRuntimeConfig {
    const envConfig = this.env.newsPipelineEnv;
    return {
      cacheTtlSeconds: this.ensurePositiveInt(
        raw?.cache_ttl_seconds,
        envConfig.cacheTtlSeconds,
      ),
      maxInputChars: this.ensurePositiveInt(
        raw?.max_input_characters,
        envConfig.maxInputChars,
      ),
      summaryMaxTokens: this.ensurePositiveInt(raw?.summary_max_tokens, 256),
      rateLimitWindowSeconds: this.ensurePositiveInt(
        raw?.rate_limit_window_seconds,
        60,
      ),
      allowMediaEmbedding: raw?.allow_media_embedding ?? true,
      detectLanguage: raw?.detect_language ?? true,
      summaryDedupEnabled: raw?.summary_dedup_enabled ?? true,
      summaryDedupThreshold: this.clamp(raw?.summary_dedup_threshold ?? 0.9, 0, 1),
      summaryDedupLookbackHours: this.ensurePositiveInt(
        raw?.summary_dedup_lookback_hours,
        48,
      ),
      summaryDedupMaxCandidates: this.ensurePositiveInt(
        raw?.summary_dedup_max_candidates,
        100,
      ),
      summaryDedupMinChars: this.ensurePositiveInt(
        raw?.summary_dedup_min_chars,
        40,
      ),
      configPath: envConfig.configPath,
    };
  }

  private ensurePositive(value: number | undefined, fallback: number) {
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
      return fallback;
    }
    return value;
  }

  private ensurePositiveInt(value: number | undefined, fallback: number) {
    return Math.round(this.ensurePositive(value, fallback));
  }

  private clamp(value: number | undefined, min: number, max: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
  }
}

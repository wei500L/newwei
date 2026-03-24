import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from "@nestjs/terminus";
import { lastValueFrom } from "rxjs";

import { EnvService } from "../config/config.service";
import { CrawlSettingsService } from "../crawl/crawl-settings.service";

interface Crawl4aiHealthProbe {
  ok: boolean;
  message?: string;
}

@Injectable()
export class Crawl4aiHealthIndicator extends HealthIndicator {
  private cachedProbe:
    | {
        value: Crawl4aiHealthProbe;
        expiresAt: number;
      }
    | null = null;
  private inFlightProbe: Promise<Crawl4aiHealthProbe> | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService,
    private readonly crawlSettings: CrawlSettingsService
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const probe = await this.getProbe();
    if (probe.ok) {
      return this.getStatus(key, true);
    }
    const message = probe.message ?? "crawl4ai health check failed";
    const result = this.getStatus(key, false, { message });
    throw new HealthCheckError(message, result);
  }

  private async getProbe(): Promise<Crawl4aiHealthProbe> {
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
          expiresAt: Date.now() + ttlMs
        };
        return probe;
      })
      .finally(() => {
        this.inFlightProbe = null;
      });

    return this.inFlightProbe;
  }

  private async runProbe(): Promise<Crawl4aiHealthProbe> {
    const timeout = Math.min(1500, this.env.crawl4aiConfig.timeoutMs);
    try {
      await lastValueFrom(
        this.http.get("/health", {
          timeout
        })
      );
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: "crawl4ai health check failed"
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

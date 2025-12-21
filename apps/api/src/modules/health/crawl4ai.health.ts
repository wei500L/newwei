import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from "@nestjs/terminus";
import { lastValueFrom } from "rxjs";

import { EnvService } from "../config/config.service";

@Injectable()
export class Crawl4aiHealthIndicator extends HealthIndicator {
  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const timeout = Math.min(1500, this.env.crawl4aiConfig.timeoutMs);
    try {
      await lastValueFrom(
        this.http.get("/health", {
          timeout
        })
      );
      return this.getStatus(key, true);
    } catch {
      const result = this.getStatus(key, false, {
        message: "crawl4ai health check failed"
      });
      throw new HealthCheckError("crawl4ai health check failed", result);
    }
  }
}

import { Controller, Get } from "@nestjs/common";
import { DiskHealthIndicator, HealthCheck, HealthCheckService, PrismaHealthIndicator } from "@nestjs/terminus";
import { createRequire } from "node:module";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../config/prisma.service";

import { Crawl4aiSsrfProxyHealthIndicator } from "./crawl4ai-ssrf-proxy.health";
import { Crawl4aiHealthIndicator } from "./crawl4ai.health";
import { LlmGatewayHealthIndicator } from "./llm-gateway.health";
import { MongoHealthIndicator } from "./mongo.health";
import { RedisHealthIndicator } from "./redis.health";

const nodeRequire = createRequire(__filename);
const pkg = nodeRequire("../../../package.json") as { version?: string };

const HEALTHZ_CACHE_TTL_MS = 5_000;

@Controller("healthz")
export class HealthController {
  private cachedHealth: { at: number; value: unknown } | null = null;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly mongoIndicator: MongoHealthIndicator,
    private readonly diskIndicator: DiskHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly crawl4aiIndicator: Crawl4aiHealthIndicator,
    private readonly crawl4aiSsrfProxyIndicator: Crawl4aiSsrfProxyHealthIndicator,
    private readonly llmGatewayIndicator: LlmGatewayHealthIndicator,
    private readonly prisma: PrismaService
  ) {}

  @AllowAuthenticated()
  @Get()
  @HealthCheck()
  async getHealth() {
    // The readiness probe is authenticated and runs real dependency checks
    // (MySQL ping, Redis write probes, Mongo ping, disk stat, LLM gateway DB
    // reads, a real crawl through the SSRF proxy). Cache briefly so health
    // scraper storms cannot amplify load on the dependencies themselves.
    const now = Date.now();
    if (
      this.cachedHealth &&
      now - this.cachedHealth.at < HEALTHZ_CACHE_TTL_MS
    ) {
      return this.cachedHealth.value;
    }

    const result = await this.health.check([
      () => this.prismaIndicator.pingCheck("mysql", this.prisma, { timeout: 1500 }),
      () => this.redisIndicator.isHealthy("redis"),
      () => this.mongoIndicator.isHealthy("mongo"),
      () => this.crawl4aiIndicator.isHealthy("crawl4ai"),
      () => this.crawl4aiSsrfProxyIndicator.isHealthy("crawl4aiSsrfProxy"),
      () => this.llmGatewayIndicator.isHealthy("llmGateway"),
      () =>
        this.diskIndicator.checkStorage("disk", {
          path: process.cwd(),
          thresholdPercent: 0.95
        })
    ]);

    const value = {
      ...result,
      version: pkg.version ?? "0.0.0",
      now: new Date().toISOString()
    };
    this.cachedHealth = { at: Date.now(), value };
    return value;
  }

  @Public()
  @Get("live")
  getLiveness() {
    // Public liveness probe: only reports the process being alive. Version,
    // timestamps and dependency details are withheld from unauthenticated
    // callers to avoid version disclosure.
    return {
      status: "ok"
    };
  }
}

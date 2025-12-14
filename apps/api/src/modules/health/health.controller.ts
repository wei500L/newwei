import { Controller, Get } from "@nestjs/common";
import { DiskHealthIndicator, HealthCheck, HealthCheckService, PrismaHealthIndicator } from "@nestjs/terminus";
import { createRequire } from "node:module";

import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../config/prisma.service";
import { Crawl4aiHealthIndicator } from "./crawl4ai.health";
import { MongoHealthIndicator } from "./mongo.health";
import { RedisHealthIndicator } from "./redis.health";

const nodeRequire = createRequire(__filename);
const pkg = nodeRequire("../../../package.json") as { version?: string };

@Controller("healthz")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly mongoIndicator: MongoHealthIndicator,
    private readonly diskIndicator: DiskHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly crawl4aiIndicator: Crawl4aiHealthIndicator,
    private readonly prisma: PrismaService
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  async getHealth() {
    const result = await this.health.check([
      () => this.prismaIndicator.pingCheck("mysql", this.prisma, { timeout: 1500 }),
      () => this.redisIndicator.isHealthy("redis"),
      () => this.mongoIndicator.isHealthy("mongo"),
      () => this.crawl4aiIndicator.isHealthy("crawl4ai"),
      () =>
        this.diskIndicator.checkStorage("disk", {
          path: process.cwd(),
          thresholdPercent: 0.95
        })
    ]);

    return {
      ...result,
      version: pkg.version ?? "0.0.0",
      now: new Date().toISOString()
    };
  }

  @Public()
  @Get("live")
  getLiveness() {
    return {
      status: "ok",
      version: pkg.version ?? "0.0.0",
      now: new Date().toISOString()
    };
  }
}

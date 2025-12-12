import { Controller, Get, Inject } from "@nestjs/common";
import { DiskHealthIndicator, HealthCheck, HealthCheckService, MongooseHealthIndicator, PrismaHealthIndicator } from "@nestjs/terminus";
import type { MongoConnection } from "@modular/mongo";
import { createRequire } from "node:module";

import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../config/prisma.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { Crawl4aiHealthIndicator } from "./crawl4ai.health";
import { RedisHealthIndicator } from "./redis.health";

const nodeRequire = createRequire(__filename);
const pkg = nodeRequire("../../../package.json") as { version?: string };

@Controller("healthz")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly mongoIndicator: MongooseHealthIndicator,
    private readonly diskIndicator: DiskHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly crawl4aiIndicator: Crawl4aiHealthIndicator,
    private readonly prisma: PrismaService,
    @Inject(MONGO_CONNECTION) private readonly mongo: MongoConnection
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  async getHealth() {
    const result = await this.health.check([
      () => this.prismaIndicator.pingCheck("mysql", this.prisma, { timeout: 1500 }),
      () => this.redisIndicator.isHealthy("redis"),
      () => this.mongoIndicator.pingCheck("mongo", { connection: this.mongo, timeout: 1500 }),
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
}

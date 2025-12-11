import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";
import { HealthController } from "./health.controller";
import { RedisHealthIndicator } from "./redis.health";

@Module({
  imports: [DatabaseModule, CacheModule, TerminusModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator]
})
export class HealthModule {}

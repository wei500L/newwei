import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { ItemsModule } from "../items/items.module";
import { QueueModule } from "../queue/queue.module";

import { DashboardController } from "./dashboard.controller";
import { DashboardDemoMetricsService } from "./dashboard-demo-metrics.service";
import { DashboardService } from "./dashboard.service";

@Module({
  imports: [ItemsModule, QueueModule, DatabaseModule],
  controllers: [DashboardController],
  providers: [DashboardDemoMetricsService, DashboardService],
  exports: [DashboardService]
})
export class DashboardModule {}

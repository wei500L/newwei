import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { GeoModule } from "../geo/geo.module";
import { ItemsModule } from "../items/items.module";
import { QueueModule } from "../queue/queue.module";

import { DashboardController } from "./dashboard.controller";
import { DashboardChartsService } from "./dashboard-charts.service";
import { DashboardDemoMetricsService } from "./dashboard-demo-metrics.service";
import { DashboardService } from "./dashboard.service";

@Module({
  imports: [ItemsModule, QueueModule, DatabaseModule, GeoModule],
  controllers: [DashboardController],
  providers: [DashboardDemoMetricsService, DashboardService, DashboardChartsService],
  exports: [DashboardService]
})
export class DashboardModule {}

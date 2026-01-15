import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { GeoModule } from "../geo/geo.module";
import { ItemsModule } from "../items/items.module";
import { QueueModule } from "../queue/queue.module";

import { DashboardChartsService } from "./dashboard-charts.service";
import { DashboardDemoMetricsService } from "./dashboard-demo-metrics.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { EntityImpactGraphService } from "./entity-impact-graph.service";

@Module({
  imports: [ItemsModule, QueueModule, DatabaseModule, GeoModule],
  controllers: [DashboardController],
  providers: [DashboardDemoMetricsService, DashboardService, DashboardChartsService, EntityImpactGraphService],
  exports: [DashboardService, EntityImpactGraphService]
})
export class DashboardModule {}

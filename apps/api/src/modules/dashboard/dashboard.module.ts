import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { GeoModule } from "../geo/geo.module";
import { ItemsModule } from "../items/items.module";
import { QueueModule } from "../queue/queue.module";
import { SituationMonitorModule } from "../situation-monitor/situation-monitor.module";

import { DashboardChartsService } from "./dashboard-charts.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { EntityImpactGraphService } from "./entity-impact-graph.service";

@Module({
  imports: [ItemsModule, QueueModule, DatabaseModule, GeoModule, SituationMonitorModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardChartsService, EntityImpactGraphService],
  exports: [DashboardService, EntityImpactGraphService]
})
export class DashboardModule {}

import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { ItemsModule } from "../items/items.module";
import { QueueModule } from "../queue/queue.module";
import { DatabaseModule } from "../config/database.module";

@Module({
  imports: [ItemsModule, QueueModule, DatabaseModule],
  controllers: [DashboardController],
  providers: [DashboardService]
})
export class DashboardModule {}

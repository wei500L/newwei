import { Module } from "@nestjs/common";

import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorService } from "./situation-monitor.service";

@Module({
  controllers: [SituationMonitorController],
  providers: [SituationMonitorService],
  exports: [SituationMonitorService],
})
export class SituationMonitorModule {}


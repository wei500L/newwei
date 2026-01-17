import { Module } from "@nestjs/common";

import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorService } from "./situation-monitor.service";

@Module({
  controllers: [SituationMonitorController],
  providers: [SituationMonitorService, SituationMonitorExternalService],
  exports: [SituationMonitorService],
})
export class SituationMonitorModule {}

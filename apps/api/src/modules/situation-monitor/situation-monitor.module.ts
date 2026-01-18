import { Module } from "@nestjs/common";

import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorService } from "./situation-monitor.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";

@Module({
  imports: [NewsPipelineModule],
  controllers: [SituationMonitorController],
  providers: [SituationMonitorService, SituationMonitorExternalService, SituationMonitorTranslationService],
  exports: [SituationMonitorService],
})
export class SituationMonitorModule {}

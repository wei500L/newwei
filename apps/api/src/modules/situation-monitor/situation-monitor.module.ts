import { Module } from "@nestjs/common";

import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";
import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorService } from "./situation-monitor.service";

@Module({
  imports: [NewsPipelineModule],
  controllers: [SituationMonitorController],
  providers: [
    SituationMonitorService,
    SituationMonitorExternalService,
    SituationMonitorTranslationService,
    SituationMonitorFeedbackService,
  ],
  exports: [SituationMonitorService],
})
export class SituationMonitorModule {}

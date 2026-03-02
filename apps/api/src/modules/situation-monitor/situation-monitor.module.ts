import { Module } from "@nestjs/common";

import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorSignalsModule } from "./signals/situation-monitor-signals.module";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";
import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorService } from "./situation-monitor.service";

@Module({
  imports: [SituationMonitorSignalsModule],
  controllers: [SituationMonitorController],
  providers: [
    SituationMonitorService,
    SituationMonitorExternalService,
    SituationMonitorTranslationService,
    SituationMonitorFeedbackService,
  ],
  exports: [SituationMonitorService, SituationMonitorTranslationService],
})
export class SituationMonitorModule {}

import { Module } from "@nestjs/common";

import { GeoModule } from "../geo/geo.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { QueueModule } from "../queue/queue.module";
import { RealtimeSignalsModule } from "../realtime-signals/realtime-signals.module";

import { FinancialMainlineSnapshotService } from "./external/financial-mainline-snapshot.service";
import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorMonitorsService } from "./situation-monitor-monitors.service";
import { SituationMonitorRefreshService } from "./situation-monitor-refresh.service";
import { SituationMonitorSignalsModule } from "./signals/situation-monitor-signals.module";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";
import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorService } from "./situation-monitor.service";

@Module({
  imports: [
    GeoModule,
    NewsPipelineModule,
    QueueModule,
    RealtimeSignalsModule,
    SituationMonitorSignalsModule,
  ],
  controllers: [SituationMonitorController],
  providers: [
    SituationMonitorService,
    SituationMonitorMonitorsService,
    SituationMonitorRefreshService,
    FinancialMainlineSnapshotService,
    SituationMonitorExternalService,
    SituationMonitorTranslationService,
    SituationMonitorFeedbackService,
  ],
  exports: [
    SituationMonitorService,
    SituationMonitorTranslationService,
    SituationMonitorMonitorsService,
    SituationMonitorRefreshService,
  ],
})
export class SituationMonitorModule {}

import { Module, forwardRef } from "@nestjs/common";

import { GeoModule } from "../geo/geo.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { QueueModule } from "../queue/queue.module";
import { RealtimeSignalsModule } from "../realtime-signals/realtime-signals.module";

import { FinancialMainlineSnapshotService } from "./external/financial-mainline-snapshot.service";
import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorSignalsModule } from "./signals/situation-monitor-signals.module";
import { SituationMonitorExternalSnapshotService } from "./situation-monitor-external-snapshot.service";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import { SituationMonitorMonitorsService } from "./situation-monitor-monitors.service";
import { SituationMonitorRefreshService } from "./situation-monitor-refresh.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";
import { SituationMonitorController } from "./situation-monitor.controller";
import { SituationMonitorService } from "./situation-monitor.service";

@Module({
  imports: [
    GeoModule,
    NewsPipelineModule,
    forwardRef(() => QueueModule),
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
    SituationMonitorExternalSnapshotService,
    SituationMonitorTranslationService,
    SituationMonitorFeedbackService,
  ],
  exports: [
    SituationMonitorService,
    SituationMonitorTranslationService,
    SituationMonitorMonitorsService,
    SituationMonitorRefreshService,
    SituationMonitorExternalSnapshotService,
  ],
})
export class SituationMonitorModule {}

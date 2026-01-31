import { Module } from "@nestjs/common";

import { AlertsModule } from "../alerts/alerts.module";
import { AnalysisModule } from "../analysis/analysis.module";
import { AuthModule } from "../auth/auth.module";
import { AssistantModule } from "../assistant/assistant.module";
import { CrawlModule } from "../crawl/crawl.module";
import { QueueModule } from "../queue/queue.module";

import { AdminErrorsController } from "./admin-errors.controller";
import { ExceptionEventsService } from "./exception-events.service";
import { NewsSourceQualityController } from "./news-source-quality.controller";
import { NewsSourceQualityService } from "./news-source-quality.service";
import { OpsGateway } from "./ops.gateway";
import { PipelineQualityController } from "./pipeline-quality.controller";
import { PipelineQualityService } from "./pipeline-quality.service";
import { PipelineRecoveryController } from "./pipeline-recovery.controller";
import { PipelineRecoveryService } from "./pipeline-recovery.service";
import { QualityGateway } from "./quality.gateway";
import { TaskLogsController } from "./task-logs.controller";

@Module({
  imports: [QueueModule, CrawlModule, AnalysisModule, AssistantModule, AlertsModule, AuthModule],
  controllers: [
    AdminErrorsController,
    PipelineQualityController,
    NewsSourceQualityController,
    PipelineRecoveryController,
    TaskLogsController
  ],
  providers: [
    ExceptionEventsService,
    PipelineQualityService,
    NewsSourceQualityService,
    PipelineRecoveryService,
    QualityGateway,
    OpsGateway
  ],
  exports: [
    ExceptionEventsService,
    PipelineQualityService,
    NewsSourceQualityService,
    PipelineRecoveryService
  ]
})
export class ObservabilityModule {}

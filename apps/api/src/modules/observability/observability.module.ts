import { Module } from "@nestjs/common";

import { QueueModule } from "../queue/queue.module";

import { AdminErrorsController } from "./admin-errors.controller";
import { ExceptionEventsService } from "./exception-events.service";
import { NewsSourceQualityController } from "./news-source-quality.controller";
import { NewsSourceQualityService } from "./news-source-quality.service";
import { PipelineQualityController } from "./pipeline-quality.controller";
import { PipelineQualityService } from "./pipeline-quality.service";
import { PipelineRecoveryController } from "./pipeline-recovery.controller";
import { PipelineRecoveryService } from "./pipeline-recovery.service";
import { TaskLogsController } from "./task-logs.controller";

@Module({
  imports: [QueueModule],
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
    PipelineRecoveryService
  ],
  exports: [
    ExceptionEventsService,
    PipelineQualityService,
    NewsSourceQualityService,
    PipelineRecoveryService
  ]
})
export class ObservabilityModule {}

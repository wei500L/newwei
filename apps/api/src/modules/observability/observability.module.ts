import { Module } from "@nestjs/common";

import { AdminErrorsController } from "./admin-errors.controller";
import { ExceptionEventsService } from "./exception-events.service";
import { PipelineQualityController } from "./pipeline-quality.controller";
import { PipelineQualityService } from "./pipeline-quality.service";
import { TaskLogsController } from "./task-logs.controller";

@Module({
  controllers: [AdminErrorsController, PipelineQualityController, TaskLogsController],
  providers: [ExceptionEventsService, PipelineQualityService],
  exports: [ExceptionEventsService, PipelineQualityService]
})
export class ObservabilityModule {}

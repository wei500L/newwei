import { Module } from "@nestjs/common";

import { AdminErrorsController } from "./admin-errors.controller";
import { ExceptionEventsService } from "./exception-events.service";
import { PipelineQualityController } from "./pipeline-quality.controller";
import { PipelineQualityService } from "./pipeline-quality.service";

@Module({
  controllers: [AdminErrorsController, PipelineQualityController],
  providers: [ExceptionEventsService, PipelineQualityService],
  exports: [ExceptionEventsService, PipelineQualityService]
})
export class ObservabilityModule {}

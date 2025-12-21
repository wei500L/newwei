import { Module } from "@nestjs/common";

import { AdminErrorsController } from "./admin-errors.controller";
import { ExceptionEventsService } from "./exception-events.service";

@Module({
  controllers: [AdminErrorsController],
  providers: [ExceptionEventsService],
  exports: [ExceptionEventsService]
})
export class ObservabilityModule {}


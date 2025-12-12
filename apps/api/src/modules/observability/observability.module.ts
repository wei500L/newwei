import { Module } from "@nestjs/common";
import { ExceptionEventsService } from "./exception-events.service";
import { AdminErrorsController } from "./admin-errors.controller";

@Module({
  controllers: [AdminErrorsController],
  providers: [ExceptionEventsService],
  exports: [ExceptionEventsService]
})
export class ObservabilityModule {}


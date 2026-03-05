import { Module } from "@nestjs/common";

import { SearchTelemetryController } from "./search-telemetry.controller";
import { SearchTelemetryService } from "./search-telemetry.service";

@Module({
  controllers: [SearchTelemetryController],
  providers: [SearchTelemetryService],
  exports: [SearchTelemetryService],
})
export class SearchTelemetryModule {}

import { Module } from "@nestjs/common";

import { SearchTelemetryAdminController } from "./search-telemetry-admin.controller";
import { SearchTelemetryController } from "./search-telemetry.controller";
import { SearchTelemetryService } from "./search-telemetry.service";

@Module({
  controllers: [SearchTelemetryController, SearchTelemetryAdminController],
  providers: [SearchTelemetryService],
  exports: [SearchTelemetryService],
})
export class SearchTelemetryModule {}

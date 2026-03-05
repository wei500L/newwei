import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

import { ArchiveVertical } from "../../archive/archive.types";
import {
  SEARCH_TELEMETRY_EVENT_TYPES,
  SEARCH_TELEMETRY_SURFACES,
  type SearchTelemetryEventType,
  type SearchTelemetrySurface,
} from "../search-telemetry.constants";

export class RecordSearchTelemetryDto {
  @IsIn(SEARCH_TELEMETRY_EVENT_TYPES)
  eventType!: SearchTelemetryEventType;

  @IsOptional()
  @IsIn(SEARCH_TELEMETRY_SURFACES)
  surface?: SearchTelemetrySurface;

  @IsOptional()
  @IsEnum(ArchiveVertical)
  vertical?: ArchiveVertical;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  queryLength?: number;
}

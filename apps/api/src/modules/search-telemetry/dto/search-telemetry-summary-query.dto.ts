import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, Matches } from "class-validator";

import {
  SEARCH_TELEMETRY_SURFACES,
  type SearchTelemetrySurface,
} from "../search-telemetry.constants";

export class SearchTelemetrySummaryQueryDto {
  @ApiPropertyOptional({ example: "2026-04-01" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @ApiPropertyOptional({ example: "2026-04-18" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @ApiPropertyOptional({ enum: SEARCH_TELEMETRY_SURFACES })
  @IsOptional()
  @IsIn(SEARCH_TELEMETRY_SURFACES)
  surface?: SearchTelemetrySurface;
}

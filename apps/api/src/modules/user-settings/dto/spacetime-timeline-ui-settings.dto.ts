import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsObject, IsOptional } from "class-validator";

export class UpdateSpacetimeTimelineUiSettingsDto {
  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

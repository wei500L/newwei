import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsObject, IsOptional } from "class-validator";

export class UpdateSituationMonitorUiSettingsDto {
  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  monitors?: unknown[];

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  layout?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

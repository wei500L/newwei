import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class SituationMonitorInsightsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  windowHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  @Max(1000)
  maxItems?: number;

  @IsOptional()
  @IsString()
  sections?: string;

  @IsOptional()
  @IsString()
  gdelt?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @IsString()
  debug?: string;

  @IsOptional()
  @IsString()
  translate?: string;
}

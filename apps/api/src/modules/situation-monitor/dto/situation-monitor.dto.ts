import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

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
}


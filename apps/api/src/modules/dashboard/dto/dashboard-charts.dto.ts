import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsISO8601, IsOptional } from "class-validator";

export class DashboardTimeRangeQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  start?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  end?: string;
}

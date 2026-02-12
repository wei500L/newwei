import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsISO8601, IsOptional, IsString } from "class-validator";

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

export class DashboardWarMapNewsMarkersQueryDto extends DashboardTimeRangeQueryDto {
  @ApiPropertyOptional({
    description: "Optional translation target. Supported: zh-CN",
    example: "zh-CN"
  })
  @IsOptional()
  @IsString()
  translate?: string;
}

export class DashboardSpacetimeGeoHeatmapQueryDto extends DashboardTimeRangeQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  includeBuckets?: string;
}

export class DashboardSpacetimeGeoHeatmapArticlesQueryDto extends DashboardTimeRangeQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  snapshotId?: string;

  @ApiPropertyOptional()
  @IsString()
  pointId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  bucketStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  limit?: string;
}

export class DashboardSpacetimePropagationQueryDto extends DashboardTimeRangeQueryDto {
  @ApiPropertyOptional()
  @IsString()
  eventId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  windowHours?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  maxNodes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  maxEdges?: string;
}

export class DashboardSpacetimePropagationArticlesQueryDto extends DashboardTimeRangeQueryDto {
  @ApiPropertyOptional()
  @IsString()
  eventId!: string;

  @ApiPropertyOptional()
  @IsString()
  source!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  cursorStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  cursorEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  limit?: string;
}

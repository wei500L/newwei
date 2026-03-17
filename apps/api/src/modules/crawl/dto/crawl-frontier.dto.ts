import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const EXECUTION_MODES = ["layered", "native", "hybrid"] as const;
const RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
] as const;

export class ListCrawlSiteProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class CreateCrawlSiteProfileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  matchHost!: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(EXECUTION_MODES)
  executionMode?: (typeof EXECUTION_MODES)[number];

  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateCrawlSiteProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  matchHost?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(EXECUTION_MODES)
  executionMode?: (typeof EXECUTION_MODES)[number];

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class MatchCrawlSiteProfileDto {
  @IsUrl({
    require_tld: false,
    require_protocol: true,
  })
  url!: string;
}

export class ListCrawlFrontierRunDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  profileId?: string;

  @IsOptional()
  @IsString()
  @IsIn(RUN_STATUSES)
  status?: (typeof RUN_STATUSES)[number];
}

export class CreateCrawlFrontierRunDto {
  @IsUrl({
    require_tld: false,
    require_protocol: true,
  })
  seedUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  profileId?: string;

  @IsOptional()
  @IsString()
  @IsIn(EXECUTION_MODES)
  executionMode?: (typeof EXECUTION_MODES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  maxDepth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxPages?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];
}

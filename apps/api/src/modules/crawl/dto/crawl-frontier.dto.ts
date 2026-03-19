import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
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
const SEED_STRATEGIES = [
  "auto",
  "seed_first",
  "frontier_first",
  "frontier_only",
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

export class PreviewCrawlSiteProfileDto {
  @IsUrl({
    require_tld: false,
    require_protocol: true,
  })
  url!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  matchHost!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

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

  @IsOptional()
  @IsString()
  @IsIn(EXECUTION_MODES)
  executionMode?: (typeof EXECUTION_MODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  runRole?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  failureKind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  warningFlag?: string;

  @IsOptional()
  @IsString()
  @IsIn(SEED_STRATEGIES)
  seedStrategy?: (typeof SEED_STRATEGIES)[number];
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

export class BulkCrawlFrontierIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(191, { each: true })
  ids!: string[];
}

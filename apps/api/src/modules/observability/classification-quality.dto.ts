import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import type { ClassifiedSourceType } from "../news-events/news-event-source-classifier";

const QUALITY_WINDOWS = ["1h", "24h", "7d"] as const;
const REVIEW_DECISION_STATUSES = [
  "approved",
  "rejected",
  "corrected",
] as const;
const CONFIDENCE_BANDS = ["low", "medium", "high"] as const;
const SOURCE_TYPES = ["authoritative", "blog", "unknown"] as const;
const MAX_REVIEW_IDS = 500;
const MAX_SOURCE_IDS = 300;
const MAX_METHODS = 100;
const MAX_QUICK_TAGS = 20;

type QualityWindow = (typeof QUALITY_WINDOWS)[number];
type ReviewDecisionStatus = (typeof REVIEW_DECISION_STATUSES)[number];
type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return normalized;
}

function normalizeOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeOptionalInteger(value: unknown) {
  const parsed = normalizeOptionalNumber(value);
  if (typeof parsed !== "number") {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizeStringArray(value: unknown, maxSize: number) {
  if (!Array.isArray(value) && typeof value !== "string") {
    return undefined;
  }
  const entries =
    typeof value === "string"
      ? value.split(",")
      : value;
  const result = Array.from(
    new Set(
      entries
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ).slice(0, maxSize);
  return result.length > 0 ? result : undefined;
}

function normalizeEnumString(value: unknown) {
  return normalizeOptionalString(value);
}

export class ClassificationSummaryQueryDto {
  @ApiPropertyOptional({ enum: QUALITY_WINDOWS })
  @Transform(({ value }) => normalizeEnumString(value))
  @IsOptional()
  @IsIn(QUALITY_WINDOWS)
  window?: QualityWindow;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  categoryPrefix?: string;
}

export class ClassificationSourceItemsParamDto {
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  sourceId!: string;
}

export class ClassificationSourceItemsQueryDto {
  @ApiPropertyOptional({ enum: QUALITY_WINDOWS })
  @Transform(({ value }) => normalizeEnumString(value))
  @IsOptional()
  @IsIn(QUALITY_WINDOWS)
  window?: QualityWindow;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalNumber(value))
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  maxConfidence?: number;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ClassificationReviewQueueQueryDto {
  @ApiPropertyOptional({ enum: QUALITY_WINDOWS })
  @Transform(({ value }) => normalizeEnumString(value))
  @IsOptional()
  @IsIn(QUALITY_WINDOWS)
  window?: QualityWindow;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  onlyUnreviewed?: boolean;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeOptionalNumber(value))
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  maxConfidence?: number;
}

export class ClassificationReviewParamDto {
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  reviewId!: string;
}

export class ClassificationReviewDecisionBodyDto {
  @Transform(({ value }) => normalizeEnumString(value))
  @IsIn(REVIEW_DECISION_STATUSES)
  status!: ReviewDecisionStatus;

  @Transform(({ value }) => normalizeOptionalString(value))
  @ValidateIf((value: ClassificationReviewDecisionBodyDto) => value.status === "corrected")
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  correctedCategoryPath?: string;

  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @Transform(({ value }) => normalizeStringArray(value, MAX_QUICK_TAGS))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_TAGS)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  quickTags?: string[];
}

export class ClassificationBatchReviewDecisionBodyDto extends ClassificationReviewDecisionBodyDto {
  @Transform(({ value }) => normalizeStringArray(value, MAX_REVIEW_IDS))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_REVIEW_IDS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  reviewIds!: string[];
}

export class ClassificationSamplingQueryBodyDto {
  @ApiPropertyOptional({ enum: QUALITY_WINDOWS })
  @Transform(({ value }) => normalizeEnumString(value))
  @IsOptional()
  @IsIn(QUALITY_WINDOWS)
  window?: QualityWindow;

  @ApiPropertyOptional({ enum: SOURCE_TYPES })
  @Transform(({ value }) => normalizeEnumString(value))
  @IsOptional()
  @IsIn(SOURCE_TYPES)
  sourceType?: ClassifiedSourceType;

  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  categoryPrefix?: string;

  @Transform(({ value }) => normalizeStringArray(value, MAX_SOURCE_IDS))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SOURCE_IDS)
  @IsString({ each: true })
  sourceIds?: string[];

  @Transform(({ value }) => normalizeStringArray(value, 10))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(CONFIDENCE_BANDS, { each: true })
  confidenceBands?: ConfidenceBand[];

  @Transform(({ value }) => normalizeStringArray(value, MAX_METHODS))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_METHODS)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  methods?: string[];

  @Type(() => Number)
  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  perStratum?: number;
}

export class ClassificationSamplingAnnotationEntryDto {
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  processedItemId!: string;

  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  humanCategoryPath!: string;

  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @Transform(({ value }) => normalizeStringArray(value, MAX_QUICK_TAGS))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_TAGS)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  quickTags?: string[];
}

export class ClassificationSamplingAnnotationsBodyDto {
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  sampleId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ClassificationSamplingAnnotationEntryDto)
  annotations!: ClassificationSamplingAnnotationEntryDto[];
}

export class ClassificationCreateReportBodyDto {
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  sampleId?: string;
}

export class ClassificationReportJobParamDto {
  @Transform(({ value }) => normalizeOptionalString(value))
  @IsString()
  @MinLength(1)
  jobId!: string;
}

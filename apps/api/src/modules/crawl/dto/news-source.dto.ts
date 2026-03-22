import { NewsSourceType } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
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

const WORKFLOW_BINDING_MODES = ["published", "pinned"] as const;

export class ListNewsSourceDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  group?: string;
}

export class CreateNewsSourceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsUrl()
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsEnum(NewsSourceType)
  siteType?: NewsSourceType;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  crawlTemplateId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  workflowId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  workflowVersionId?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(WORKFLOW_BINDING_MODES)
  workflowBindingMode?: (typeof WORKFLOW_BINDING_MODES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(2_592_000)
  frequencySeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  group?: string | null;
}

export class UpdateNewsSourceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsEnum(NewsSourceType)
  siteType?: NewsSourceType;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  crawlTemplateId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  workflowId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  workflowVersionId?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(WORKFLOW_BINDING_MODES)
  workflowBindingMode?: (typeof WORKFLOW_BINDING_MODES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(2_592_000)
  frequencySeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  group?: string | null;
}

export class ScheduleNewsSourceDto {
  @IsDateString()
  nextRunAt!: string;
}

import { Type } from 'class-transformer';
import {
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
} from 'class-validator';

const WORKFLOW_BINDING_MODES = ['published', 'pinned'] as const;
const WORKFLOW_RUN_KINDS = [
  'trial',
  'profile_preview',
  'news_source_preview',
  'frontier_compile',
] as const;

export class ListCrawlStrategyWorkflowDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class CreateCrawlStrategyWorkflowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsObject()
  draftDefinition?: Record<string, unknown>;
}

export class UpdateCrawlStrategyWorkflowDraftDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsObject()
  draftDefinition!: Record<string, unknown>;
}

export class PublishCrawlStrategyWorkflowDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  versionName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class TrialRunCrawlStrategyWorkflowDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  workflowVersionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  profileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  newsSourceId?: string;

  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
  })
  seedUrl?: string;

  @IsOptional()
  @IsString()
  @IsIn(WORKFLOW_RUN_KINDS)
  runKind?: (typeof WORKFLOW_RUN_KINDS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxCandidates?: number;

  @IsOptional()
  @IsObject()
  runtimeOverrides?: Record<string, unknown>;
}

export class CompareCrawlStrategyWorkflowVersionsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  leftVersionId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  rightVersionId!: string;
}

export class UpdateWorkflowBindingDto {
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
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const SITUATION_MONITOR_MONITOR_KIND_VALUES = [
  'manual',
  'system_sync',
] as const;

class SituationMonitorLocationInputDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  countryCodeAlpha2?: string;
}

class SituationMonitorSuggestionStateDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  approvedTopics?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  approvedEntities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(36)
  @IsString({ each: true })
  approvedLexicalTerms?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  rejectedTopics?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  rejectedEntities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(36)
  @IsString({ each: true })
  rejectedLexicalTerms?: string[];
}

export class SituationMonitorPreviewDto extends SituationMonitorSuggestionStateDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  rawKeywords!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SituationMonitorLocationInputDto)
  location?: SituationMonitorLocationInputDto;
}

export class CreateSituationMonitorDto extends SituationMonitorPreviewDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateSituationMonitorDto extends SituationMonitorSuggestionStateDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  rawKeywords?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SituationMonitorLocationInputDto)
  location?: SituationMonitorLocationInputDto | null;
}

export class SituationMonitorMonitorIdParamDto {
  @IsString()
  id!: string;
}

export class SituationMonitorMonitorKindQueryDto {
  @IsOptional()
  @IsIn(SITUATION_MONITOR_MONITOR_KIND_VALUES)
  kind?: (typeof SITUATION_MONITOR_MONITOR_KIND_VALUES)[number];
}

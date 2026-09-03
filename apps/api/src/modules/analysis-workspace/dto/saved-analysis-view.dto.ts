import {
  AnalysisSubjectType,
  AnalysisTaskLinkedSubjectType,
  AnalysisTaskPriority,
  SavedAnalysisSurface,
  SavedAnalysisVisibility,
} from ".prisma/client";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class ListSavedAnalysisViewsDto {
  @ApiPropertyOptional({
    enum: ["mine", "shared", "all"],
    default: "all",
  })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ enum: SavedAnalysisSurface })
  @IsOptional()
  @IsEnum(SavedAnalysisSurface)
  surface?: SavedAnalysisSurface;
}

export class CreateSavedAnalysisViewDto {
  @ApiProperty({ example: "South China Sea watchlist" })
  @IsString()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ example: "Shared watchlist for the morning shift." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: SavedAnalysisSurface })
  @IsEnum(SavedAnalysisSurface)
  surface!: SavedAnalysisSurface;

  @ApiProperty({ example: "/search" })
  @IsString()
  @MaxLength(255)
  routePath!: string;

  @ApiPropertyOptional({ example: "q=tariff&topic=shipping" })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  queryString?: string;

  @ApiPropertyOptional({
    enum: SavedAnalysisVisibility,
    default: SavedAnalysisVisibility.private,
  })
  @IsOptional()
  @IsEnum(SavedAnalysisVisibility)
  visibility?: SavedAnalysisVisibility;
}

export class UpdateSavedAnalysisViewDto {
  @ApiPropertyOptional({ example: "South China Sea watchlist" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ example: "Shared watchlist for the morning shift." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: "/search" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  routePath?: string;

  @ApiPropertyOptional({ example: "q=tariff&topic=shipping" })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  queryString?: string;

  @ApiPropertyOptional({ enum: SavedAnalysisVisibility })
  @IsOptional()
  @IsEnum(SavedAnalysisVisibility)
  visibility?: SavedAnalysisVisibility;
}

export class UpsertAnalysisThreadDto {
  @ApiPropertyOptional({ example: "## Shared note\n\nWatch the source split." })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  noteMarkdown?: string;
}

export class CreateAnalysisCommentDto {
  @ApiProperty({ example: "Need corroboration from AP or Reuters." })
  @IsString()
  @MaxLength(5000)
  bodyMarkdown!: string;
}

export class UpdateAnalysisCommentDto {
  @ApiProperty({ example: "Need corroboration from AP or Reuters." })
  @IsString()
  @MaxLength(5000)
  bodyMarkdown!: string;
}

export class ExportAnalysisQueryDto {
  @ApiPropertyOptional({ example: "q=tariff&topic=shipping" })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  queryString?: string;
}

export class AnalysisThreadParamsDto {
  @ApiProperty({ enum: AnalysisSubjectType })
  @IsEnum(AnalysisSubjectType)
  subjectType!: AnalysisSubjectType;

  @ApiProperty()
  @IsString()
  @MaxLength(191)
  subjectId!: string;
}

export class CreateAnalysisBoardDto {
  @ApiProperty({ example: "Morning desk" })
  @IsString()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ example: "Shared board for the morning analysis desk." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateAnalysisBoardDto {
  @ApiPropertyOptional({ example: "Morning desk" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ example: "Shared board for the morning analysis desk." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class CreateAnalysisBoardColumnDto {
  @ApiProperty({ example: "Review" })
  @IsString()
  @MaxLength(80)
  title!: string;

  @ApiPropertyOptional({ example: "blue" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDone?: boolean;
}

export class UpdateAnalysisBoardColumnDto {
  @ApiPropertyOptional({ example: "Review" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional({ example: "blue" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDone?: boolean;
}

export class DeleteAnalysisBoardColumnDto {
  @ApiProperty({ example: "column-target" })
  @IsString()
  @MaxLength(191)
  moveCardsToColumnId!: string;
}

export class ReorderAnalysisBoardColumnsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  columnIds!: string[];
}

export class CreateAnalysisTaskDto {
  @ApiProperty({ example: "Corroborate shipping disruption claim" })
  @IsString()
  @MaxLength(160)
  title!: string;

  @ApiPropertyOptional({ example: "Check Reuters/AP and update the saved view." })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  bodyMarkdown?: string;

  @ApiPropertyOptional({ enum: AnalysisTaskPriority })
  @IsOptional()
  @IsEnum(AnalysisTaskPriority)
  priority?: AnalysisTaskPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  columnId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  assigneeId?: string | null;

  @ApiPropertyOptional({ enum: AnalysisTaskLinkedSubjectType })
  @IsOptional()
  @IsEnum(AnalysisTaskLinkedSubjectType)
  linkedSubjectType?: AnalysisTaskLinkedSubjectType | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  linkedSubjectId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dueAt?: string | null;
}

export class UpdateAnalysisTaskDto {
  @ApiPropertyOptional({ example: "Corroborate shipping disruption claim" })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional({ example: "Check Reuters/AP and update the saved view." })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  bodyMarkdown?: string | null;

  @ApiPropertyOptional({ enum: AnalysisTaskPriority })
  @IsOptional()
  @IsEnum(AnalysisTaskPriority)
  priority?: AnalysisTaskPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  assigneeId?: string | null;

  @ApiPropertyOptional({ enum: AnalysisTaskLinkedSubjectType })
  @IsOptional()
  @IsEnum(AnalysisTaskLinkedSubjectType)
  linkedSubjectType?: AnalysisTaskLinkedSubjectType | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  linkedSubjectId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dueAt?: string | null;
}

export class MoveAnalysisTaskDto {
  @ApiProperty({ example: "column-target" })
  @IsString()
  @MaxLength(191)
  targetColumnId!: string;

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  targetIndex!: number;
}

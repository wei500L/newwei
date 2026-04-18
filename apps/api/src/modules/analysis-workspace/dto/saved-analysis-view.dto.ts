import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AnalysisSubjectType,
  SavedAnalysisSurface,
  SavedAnalysisVisibility,
} from ".prisma/client";
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
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

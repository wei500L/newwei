import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class SituationMonitorInsightsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  windowHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  @Max(1000)
  maxItems?: number;

  @IsOptional()
  @IsString()
  sections?: string;

  @IsOptional()
  @IsString()
  gdelt?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @IsString()
  debug?: string;

  @IsOptional()
  @IsString()
  translate?: string;
}

export class SituationMonitorSignalFeedbackDto {
  @IsString()
  @IsIn(["narrative", "correlation"])
  signalType!: "narrative" | "correlation";

  @IsString()
  signalId!: string;

  @IsString()
  @IsIn(["false_positive", "false_negative"])
  label!: "false_positive" | "false_negative";

  @IsOptional()
  @IsString()
  itemMetaId?: string;

  @IsOptional()
  @IsString()
  itemLink?: string;

  @IsOptional()
  @IsString()
  itemTitle?: string;

  @IsOptional()
  @IsString()
  itemSource?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

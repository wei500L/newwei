import { Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class UpdateUserDigestPreferenceDto {
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  focusEntities?: string[];

  @IsOptional()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  focusTopics?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  windowDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  maxEvents?: number;

  @IsOptional()
  @IsBoolean()
  includeIndicators?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  maxIndicatorsPerEvent?: number;
}


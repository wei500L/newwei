import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class BatchUpdateNewsSourceFrequencyDto {
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(2_592_000)
  frequencySeconds!: number;
}

export class NewsSourceIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(191, { each: true })
  ids!: string[];
}

export class BatchUpdateNewsSourceGroupDto extends NewsSourceIdsDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  group?: string | null;
}

export class BatchUpdateNewsSourceActiveDto extends NewsSourceIdsDto {
  @IsBoolean()
  isActive!: boolean;
}

export class BatchDeleteNewsSourcesDto extends NewsSourceIdsDto {}

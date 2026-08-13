import { NewsSourceType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { IsSafeUrl } from '../../../common/validators/is-safe-url.decorator';

export class ImportNewsSourceOpmlEntryDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsUrl()
  @IsSafeUrl()
  @MaxLength(2048)
  url!: string;

  @IsUrl()
  @IsSafeUrl()
  @MaxLength(2048)
  feedUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  language?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(NewsSourceType)
  siteType?: NewsSourceType;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  group?: string | null;
}

export class ImportNewsSourcesFromOpmlDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportNewsSourceOpmlEntryDto)
  entries!: ImportNewsSourceOpmlEntryDto[];

  @IsOptional()
  @IsIn(['skip'])
  conflictPolicy?: 'skip';

  @IsOptional()
  @IsIn(['steady'])
  runtimeProfile?: 'steady';
}

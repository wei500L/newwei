import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested
} from "class-validator";

const SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i;
const SECRET_KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const MAX_SECRET_VALUE_LENGTH = 8192;

export class NewsSourceRuntimeSecretUpsertDto {
  @ApiPropertyOptional()
  @IsString()
  @Matches(SOURCE_ID_PATTERN)
  sourceId!: string;

  @ApiPropertyOptional()
  @IsString()
  @Matches(SECRET_KEY_PATTERN)
  @MaxLength(128)
  key!: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(MAX_SECRET_VALUE_LENGTH)
  value!: string;
}

export class NewsSourceRuntimeSecretRemoveDto {
  @ApiPropertyOptional()
  @IsString()
  @Matches(SOURCE_ID_PATTERN)
  sourceId!: string;

  @ApiPropertyOptional()
  @IsString()
  @Matches(SECRET_KEY_PATTERN)
  @MaxLength(128)
  key!: string;
}

export class UpdateNewsSourceRuntimeSecretsDto {
  @ApiPropertyOptional({
    type: () => [NewsSourceRuntimeSecretUpsertDto]
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => NewsSourceRuntimeSecretUpsertDto)
  upserts?: NewsSourceRuntimeSecretUpsertDto[];

  @ApiPropertyOptional({
    type: () => [NewsSourceRuntimeSecretRemoveDto]
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => NewsSourceRuntimeSecretRemoveDto)
  removes?: NewsSourceRuntimeSecretRemoveDto[];
}

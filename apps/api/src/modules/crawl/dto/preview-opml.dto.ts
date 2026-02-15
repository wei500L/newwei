import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PreviewNewsSourceOpmlDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  presetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  opmlContent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  defaultLanguage?: string;
}

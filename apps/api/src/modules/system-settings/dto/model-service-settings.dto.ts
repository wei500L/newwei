import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class UpdateModelServiceSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  internalToken?: string | null;

  @IsInt()
  @Min(100)
  timeoutMs!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  maxRetries!: number;
}


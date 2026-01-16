import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class UpdateVectorServiceSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  fallbackToMongo!: boolean;

  @IsOptional()
  @IsString()
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  token?: string | null;

  @IsInt()
  @Min(100)
  timeoutMs!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  maxRetries!: number;
}


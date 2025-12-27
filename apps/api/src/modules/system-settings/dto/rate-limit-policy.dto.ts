import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";

const MIN_LIMIT = 0;
const MAX_LIMIT = 100_000;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 86_400;

export class CreateRateLimitPolicyDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.]*$/)
  feature!: string;

  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_LIMIT)
  userLimit!: number;

  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_LIMIT)
  ipLimit!: number;

  @IsInt()
  @Min(MIN_WINDOW_SECONDS)
  @Max(MAX_WINDOW_SECONDS)
  windowSeconds!: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateRateLimitPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_LIMIT)
  userLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_LIMIT)
  ipLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(MIN_WINDOW_SECONDS)
  @Max(MAX_WINDOW_SECONDS)
  windowSeconds?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}

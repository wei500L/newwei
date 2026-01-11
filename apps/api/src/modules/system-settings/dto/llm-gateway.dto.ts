import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min
} from "class-validator";

const MAX_MODEL_LIST = 20;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_TOP_P = 0;
const MAX_TOP_P = 1;
const MIN_OUTPUT_TOKENS = 1;
const MAX_OUTPUT_TOKENS = 100_000;
const MIN_RETRIES = 1;
const MAX_RETRIES = 20;
const MIN_RPM = 1;
const MAX_RPM = 100_000;

export class CreateLlmGatewayDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({
    description: "OpenAI-compatible base URL, e.g. http://localhost:4001 or https://example.com/v1"
  })
  @IsUrl({ require_protocol: true, require_tld: false })
  apiBase!: string;

  @ApiPropertyOptional({
    description:
      "Stored encrypted when SYSTEM_SETTINGS_ENCRYPTION_KEY is configured (falls back to plaintext when missing)."
  })
  @IsOptional()
  @IsString()
  apiKey?: string | null;

  @ApiProperty()
  @IsString()
  model!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  embeddingModel?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_TIMEOUT_MS)
  @Max(MAX_TIMEOUT_MS)
  timeoutMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Min(MIN_TEMPERATURE)
  @Max(MAX_TEMPERATURE)
  temperature?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Min(MIN_TOP_P)
  @Max(MAX_TOP_P)
  topP?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_OUTPUT_TOKENS)
  @Max(MAX_OUTPUT_TOKENS)
  maxOutputTokens?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_RETRIES)
  @Max(MAX_RETRIES)
  maxRetries?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MODEL_LIST)
  @IsString({ each: true })
  fallbackModels?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_RPM)
  @Max(MAX_RPM)
  requestsPerMinute?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateLlmGatewayDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: "OpenAI-compatible base URL, e.g. http://localhost:4001 or https://example.com/v1"
  })
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false })
  apiBase?: string;

  @ApiPropertyOptional({
    description:
      "Provide a non-empty string to update; provide an empty string or null to clear."
  })
  @IsOptional()
  @IsString()
  apiKey?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  embeddingModel?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_TIMEOUT_MS)
  @Max(MAX_TIMEOUT_MS)
  timeoutMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Min(MIN_TEMPERATURE)
  @Max(MAX_TEMPERATURE)
  temperature?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Min(MIN_TOP_P)
  @Max(MAX_TOP_P)
  topP?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_OUTPUT_TOKENS)
  @Max(MAX_OUTPUT_TOKENS)
  maxOutputTokens?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_RETRIES)
  @Max(MAX_RETRIES)
  maxRetries?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MODEL_LIST)
  @IsString({ each: true })
  fallbackModels?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_RPM)
  @Max(MAX_RPM)
  requestsPerMinute?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SetActiveLlmGatewayDto {
  @ApiPropertyOptional({
    description: "Set to null to disable DB overrides and fall back to config file/env."
  })
  @IsOptional()
  @IsString()
  activeId?: string | null;
}

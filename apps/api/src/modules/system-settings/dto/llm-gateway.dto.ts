import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
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
const MAX_OUTPUT_TOKENS = 1_000_000;
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
      "Stored in system settings. Encrypted when secret encryption is enabled (System Settings -> Security) and SYSTEM_SETTINGS_ENCRYPTION_KEY is configured; otherwise stored as plaintext."
  })
  @IsOptional()
  @IsString()
  apiKey?: string | null;

  @ApiPropertyOptional({
    description:
      "Optional chat/completions model; leave empty when configuring an embeddings-only gateway profile."
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  embeddingModel?: string | null;

  @ApiPropertyOptional({
    description:
      "Optional assistant-only chat model override. Used by /assistant calls only and does not affect news pipelines."
  })
  @IsOptional()
  @IsString()
  assistantModel?: string | null;

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

  @ApiPropertyOptional({
    description: "When false, the API runtime will not send metadata to upstream model requests."
  })
  @IsOptional()
  @IsBoolean()
  sendMetadata?: boolean;

  @ApiPropertyOptional({
    description:
      "How to shape response_format for compatibility: json_schema (default), json_object, or none.",
    enum: ["json_schema", "json_object", "none"]
  })
  @IsOptional()
  @IsIn(["json_schema", "json_object", "none"])
  responseFormatMode?: "json_schema" | "json_object" | "none";

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

  @ApiPropertyOptional({
    description:
      "Optional assistant-only chat model override. Used by /assistant calls only and does not affect news pipelines."
  })
  @IsOptional()
  @IsString()
  assistantModel?: string | null;

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

  @ApiPropertyOptional({
    description: "When false, the API runtime will not send metadata to upstream model requests."
  })
  @IsOptional()
  @IsBoolean()
  sendMetadata?: boolean;

  @ApiPropertyOptional({
    description:
      "How to shape response_format for compatibility: json_schema (default), json_object, or none.",
    enum: ["json_schema", "json_object", "none"]
  })
  @IsOptional()
  @IsIn(["json_schema", "json_object", "none"])
  responseFormatMode?: "json_schema" | "json_object" | "none";

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

export class SetEmbeddingActiveLlmGatewayDto {
  @ApiPropertyOptional({
    description:
      "Set to null to use the active completion profile (or config file/env) for embeddings."
  })
  @IsOptional()
  @IsString()
  activeId?: string | null;

  @ApiPropertyOptional({
    description:
      "How to resolve embeddings gateway when activeId is null: follow_completion (default) or use_default (config/env)."
  })
  @IsOptional()
  @IsString()
  @IsIn(["follow_completion", "use_default"])
  mode?: "follow_completion" | "use_default";
}

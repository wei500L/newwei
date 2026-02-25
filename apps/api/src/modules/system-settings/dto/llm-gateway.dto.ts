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
const LLM_GATEWAY_API_SURFACES = ["chat_completions", "responses"] as const;

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
      "Optional rerank model used by /v1/rerank calls. Required when this profile is explicitly activated for reranking."
  })
  @IsOptional()
  @IsString()
  rerankModel?: string | null;

  @ApiPropertyOptional({
    description:
      "Optional backup rerank models (in order) for /v1/rerank calls when primary rerankModel fails."
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MODEL_LIST)
  @IsString({ each: true })
  rerankFallbackModels?: string[];

  @ApiPropertyOptional({
    description:
      "Optional assistant-only chat model override. Used by /assistant calls only and does not affect news pipelines."
  })
  @IsOptional()
  @IsString()
  assistantModel?: string | null;

  @ApiPropertyOptional({
    description:
      "Enable web search capability for /assistant when this profile is active. Requires apiSurface=responses."
  })
  @IsOptional()
  @IsBoolean()
  assistantWebSearchEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Completion API surface: chat_completions (default) or responses.",
    enum: LLM_GATEWAY_API_SURFACES
  })
  @IsOptional()
  @IsIn(LLM_GATEWAY_API_SURFACES)
  apiSurface?: "chat_completions" | "responses";

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
      "Optional rerank model used by /v1/rerank calls. Required when this profile is explicitly activated for reranking."
  })
  @IsOptional()
  @IsString()
  rerankModel?: string | null;

  @ApiPropertyOptional({
    description:
      "Optional backup rerank models (in order) for /v1/rerank calls when primary rerankModel fails."
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MODEL_LIST)
  @IsString({ each: true })
  rerankFallbackModels?: string[];

  @ApiPropertyOptional({
    description:
      "Optional assistant-only chat model override. Used by /assistant calls only and does not affect news pipelines."
  })
  @IsOptional()
  @IsString()
  assistantModel?: string | null;

  @ApiPropertyOptional({
    description:
      "Enable web search capability for /assistant when this profile is active. Requires apiSurface=responses."
  })
  @IsOptional()
  @IsBoolean()
  assistantWebSearchEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Completion API surface: chat_completions (default) or responses.",
    enum: LLM_GATEWAY_API_SURFACES
  })
  @IsOptional()
  @IsIn(LLM_GATEWAY_API_SURFACES)
  apiSurface?: "chat_completions" | "responses";

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
    description:
      "Set to null to clear explicit active selection. Runtime then resolves to MySQL default profile when available."
  })
  @IsOptional()
  @IsString()
  activeId?: string | null;
}

export class SetEmbeddingActiveLlmGatewayDto {
  @ApiPropertyOptional({
    description:
      "Set to null to use the active completion profile (or MySQL default embedding profile in use_default mode)."
  })
  @IsOptional()
  @IsString()
  activeId?: string | null;

  @ApiPropertyOptional({
    description:
      "How to resolve embeddings gateway when activeId is null: follow_completion (default) or use_default (MySQL default profile)."
  })
  @IsOptional()
  @IsString()
  @IsIn(["follow_completion", "use_default"])
  mode?: "follow_completion" | "use_default";
}

export class SetRerankActiveLlmGatewayDto {
  @ApiPropertyOptional({
    description:
      "Set to null to use the active completion profile (or MySQL default rerank profile in use_default mode)."
  })
  @IsOptional()
  @IsString()
  activeId?: string | null;

  @ApiPropertyOptional({
    description:
      "How to resolve rerank gateway when activeId is null: follow_completion (default) or use_default (MySQL default profile)."
  })
  @IsOptional()
  @IsString()
  @IsIn(["follow_completion", "use_default"])
  mode?: "follow_completion" | "use_default";
}

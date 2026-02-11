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

export class LlmGatewayModelsConfigDto {
  @ApiPropertyOptional({
    description:
      "Optional profile id; when apiKey is omitted we will reuse the stored key for this profile."
  })
  @IsOptional()
  @IsString()
  profileId?: string;

  @ApiProperty({
    description:
      "OpenAI-compatible base URL (or a full endpoint URL that can be normalized), e.g. https://api.openai.com/v1"
  })
  @IsUrl({ require_protocol: true, require_tld: false })
  apiBase!: string;

  @ApiPropertyOptional({ description: "Optional API key. Supports pasting a full \"Bearer sk-...\" value." })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(MIN_TIMEOUT_MS)
  @Max(MAX_TIMEOUT_MS)
  timeoutMs?: number;
}

export class LlmGatewayTestConfigDto extends LlmGatewayModelsConfigDto {
  @ApiPropertyOptional({
    description:
      "Optional chat/completions model to use for the test request; required when includeCompletion is true."
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: "When false, skips the chat completion test." })
  @IsOptional()
  @IsBoolean()
  includeCompletion?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  embeddingModel?: string;

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
  @IsArray()
  @ArrayMaxSize(MAX_MODEL_LIST)
  @IsString({ each: true })
  fallbackModels?: string[];

  @ApiPropertyOptional({ description: "Optional prompt override." })
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiPropertyOptional({ description: "Whether to also test embeddings." })
  @IsOptional()
  @IsBoolean()
  includeEmbeddings?: boolean;

  @ApiPropertyOptional({ description: "Optional embedding input override." })
  @IsOptional()
  @IsString()
  embeddingInput?: string;

  @ApiPropertyOptional({
    description: "API surface for completion test: chat_completions (default) or responses."
  })
  @IsOptional()
  @IsIn(["chat_completions", "responses"])
  apiSurface?: "chat_completions" | "responses";

  @ApiPropertyOptional({
    description: "Optional response_format compatibility probe for completion tests."
  })
  @IsOptional()
  @IsIn(["none", "json_object", "json_schema"])
  responseFormatMode?: "none" | "json_object" | "json_schema";

  @ApiPropertyOptional({
    description: "When true, include metadata payload in completion test to verify gateway support."
  })
  @IsOptional()
  @IsBoolean()
  includeMetadataProbe?: boolean;
}

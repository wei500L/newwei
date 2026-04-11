import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

const MAX_MODEL_LENGTH = 256;
const MAX_INPUT_LENGTH = 4_000;
const MAX_RERANK_DOCUMENTS = 20;

export class LlmGatewayTestDto {
  @ApiPropertyOptional({
    description:
      "Authentication mode for the test request. profile_key validates the profile key; managed_runtime_key validates the governed managed runtime key.",
  })
  @IsOptional()
  @IsIn(["profile_key", "managed_runtime_key"])
  authMode?: "profile_key" | "managed_runtime_key";

  @ApiPropertyOptional({
    description: "When false, skips the chat completion test and only runs the embeddings test."
  })
  @IsOptional()
  @IsBoolean()
  includeCompletion?: boolean;

  @ApiPropertyOptional({
    description:
      "Optional override model for the completion test. When omitted, uses the profile default + fallback models."
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_MODEL_LENGTH)
  model?: string;

  @ApiPropertyOptional({
    description: "Prompt used for a chat completion test request."
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_LENGTH)
  prompt?: string;

  @ApiPropertyOptional({
    description: "When true, runs an embeddings request using the embedding model (or model fallback)."
  })
  @IsOptional()
  @IsBoolean()
  includeEmbeddings?: boolean;

  @ApiPropertyOptional({
    description:
      "Optional override model for the embeddings test. When omitted, uses the profile embedding model (or model fallback)."
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_MODEL_LENGTH)
  embeddingModel?: string;

  @ApiPropertyOptional({
    description: "Input used for an embeddings test request."
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_LENGTH)
  embeddingInput?: string;

  @ApiPropertyOptional({
    description:
      "When true, runs a rerank request using the rerank model and backup rerank models."
  })
  @IsOptional()
  @IsBoolean()
  includeRerank?: boolean;

  @ApiPropertyOptional({
    description:
      "Optional override model for the rerank test. When omitted, uses profile rerank model + backup rerank models."
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_MODEL_LENGTH)
  rerankModel?: string;

  @ApiPropertyOptional({
    description: "Query text used for rerank test requests."
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_LENGTH)
  rerankQuery?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Documents used in rerank test requests. When omitted, defaults to built-in test documents."
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RERANK_DOCUMENTS)
  @IsString({ each: true })
  @MaxLength(MAX_INPUT_LENGTH, { each: true })
  rerankDocuments?: string[];

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

import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class LlmGatewayTestDto {
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
  @MaxLength(256)
  model?: string;

  @ApiPropertyOptional({
    description: "Prompt used for a chat completion test request."
  })
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
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
  @MaxLength(256)
  embeddingModel?: string;

  @ApiPropertyOptional({
    description: "Input used for an embeddings test request."
  })
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
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

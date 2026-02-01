import { ArrayMaxSize, IsArray, IsIn, IsString } from "class-validator";

export class ReportLiteLlmOpenAiKeysAppliedDto {
  @IsString()
  @IsIn(["db", "env", "none"])
  source!: "db" | "env" | "none";

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  keyFingerprints!: string[];
}

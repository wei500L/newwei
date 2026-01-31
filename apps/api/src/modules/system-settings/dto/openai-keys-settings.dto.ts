import { ArrayMaxSize, IsArray, IsString } from "class-validator";

export class UpdateOpenAiKeysSettingsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  keys!: string[];
}


import { IsBoolean } from "class-validator";

export class UpdateAssistantSafetySettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  outputModerationEnabled!: boolean;
}


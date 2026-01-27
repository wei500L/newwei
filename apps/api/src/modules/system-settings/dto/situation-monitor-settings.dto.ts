import { IsInt, Max, Min } from "class-validator";

export class UpdateSituationMonitorSettingsDto {
  @IsInt()
  @Min(1)
  @Max(10)
  translationMaxConcurrency!: number;
}


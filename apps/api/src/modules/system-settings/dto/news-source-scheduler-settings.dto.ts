import { IsInt, Max, Min } from "class-validator";

export class UpdateNewsSourceSchedulerSettingsDto {
  @IsInt()
  @Min(1)
  @Max(3_650)
  seedFreshnessWindowDays!: number;
}


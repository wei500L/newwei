import { IsInt, Max, Min } from "class-validator";

export class UpdateTaskLogSettingsDto {
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays!: number;
}

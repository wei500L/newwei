import { IsInt, Max, Min } from "class-validator";

export class UpdateAuditLogRetentionDto {
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays!: number;
}

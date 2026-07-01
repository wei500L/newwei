import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsIn } from "class-validator";

const MFA_POLICIES = ["off", "admins_only", "all_users"] as const;
export type MfaPolicyValue = (typeof MFA_POLICIES)[number];

export class UpdateSystemSecuritySettingsDto {
  @ApiProperty()
  @IsBoolean()
  secretEncryptionEnabled!: boolean;

  @ApiProperty({ enum: MFA_POLICIES })
  @IsIn(MFA_POLICIES)
  mfaPolicy!: MfaPolicyValue;
}

import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class UpdateSystemSecuritySettingsDto {
  @ApiProperty()
  @IsBoolean()
  secretEncryptionEnabled!: boolean;
}


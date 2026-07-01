import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class ChangePasswordDto {
  @ApiProperty({ example: "current-password" })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  currentPassword!: string;

  @ApiProperty({ example: "new-strong-password" })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  newPassword!: string;
}

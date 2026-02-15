import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, Matches } from "class-validator";

export class SendVerificationDto {
  @ApiProperty({ example: "new.email@example.com" })
  @IsEmail()
  email!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ example: "12345678" })
  @IsString()
  @Matches(/^\d{8}$/)
  code!: string;
}

export class EmailCodeSendResponseDto {
  @ApiProperty({ example: true })
  ok!: true;

  @ApiProperty({ example: 90 })
  cooldownSeconds!: number;
}

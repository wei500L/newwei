import { ApiProperty } from "@nestjs/swagger";

import { UpdateAuthEmailCodeSettingsDto } from "./auth-email-code-settings.dto";

export class EmailVerifyStatusDto {
  @ApiProperty({
    description: "Latest SMTP verify result. Null means not checked yet.",
    nullable: true,
    example: true
  })
  ok!: boolean | null;

  @ApiProperty({
    description: "ISO timestamp when SMTP verify was last checked.",
    nullable: true,
    example: "2026-02-15T09:30:00.000Z"
  })
  checkedAt!: string | null;

  @ApiProperty({
    description: "Latest SMTP verify error message, if any.",
    nullable: true,
    example: null
  })
  error!: string | null;
}

export class SmtpConfigStatusDto {
  @ApiProperty({ example: "smtp.example.com" })
  host!: string;

  @ApiProperty({ example: 587 })
  port!: number;

  @ApiProperty({ example: false })
  secure!: boolean;

  @ApiProperty({ example: "noreply@example.com" })
  user!: string;

  @ApiProperty({ example: "Modular <noreply@example.com>" })
  from!: string;

  @ApiProperty({ example: true })
  pool!: boolean;

  @ApiProperty({ example: 5 })
  maxConnections!: number;

  @ApiProperty({ example: 100 })
  maxMessages!: number;

  @ApiProperty({ example: 1000 })
  rateDeltaMs!: number;

  @ApiProperty({ example: 20 })
  rateLimit!: number;

  @ApiProperty({ example: 10000 })
  connectionTimeoutMs!: number;

  @ApiProperty({ example: 10000 })
  greetingTimeoutMs!: number;

  @ApiProperty({ example: 60000 })
  socketTimeoutMs!: number;

  @ApiProperty({ example: true })
  tlsRejectUnauthorized!: boolean;
}

export class EmailSettingsStatusResponseDto {
  @ApiProperty({ type: () => SmtpConfigStatusDto })
  smtp!: SmtpConfigStatusDto;

  @ApiProperty({ type: () => EmailVerifyStatusDto })
  verify!: EmailVerifyStatusDto;

  @ApiProperty({
    type: () => UpdateAuthEmailCodeSettingsDto,
    description: "Effective email verification code settings."
  })
  authCode!: UpdateAuthEmailCodeSettingsDto;
}

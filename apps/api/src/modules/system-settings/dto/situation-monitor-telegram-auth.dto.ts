import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

const E164_PHONE_NUMBER_PATTERN = /^\+[1-9]\d{6,14}$/;

export class StartSituationMonitorTelegramAuthDto {
  @IsOptional()
  @IsString()
  telegramApiId?: string;

  @IsOptional()
  @IsString()
  telegramApiHash?: string;

  @IsString()
  @Matches(E164_PHONE_NUMBER_PATTERN, { message: 'TELEGRAM_AUTH_PHONE_FORMAT_INVALID' })
  phoneNumber!: string;
}

export class CompleteSituationMonitorTelegramAuthDto {
  @IsString()
  requestId!: string;

  @IsString()
  phoneCode!: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsBoolean()
  enableTelegram?: boolean;
}

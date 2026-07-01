import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";

export class VerifyMfaCodeDto {
  @IsString()
  @MinLength(6)
  code!: string;
}

export class CompleteMfaLoginDto extends VerifyMfaCodeDto {
  @IsString()
  challengeId!: string;
}

export class BeginMfaEnrollmentChallengeDto {
  @IsString()
  challengeId!: string;
}

export class CompleteMfaEnrollmentChallengeDto extends VerifyMfaCodeDto {
  @IsString()
  challengeId!: string;
}

export class OidcConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  issuerUrl!: string;

  @IsOptional()
  @IsString()
  discoveryUrl?: string;

  @IsString()
  clientId!: string;

  @IsOptional()
  @IsString()
  clientSecret?: string;

  @IsOptional()
  @IsArray()
  scopes?: string[];

  @IsOptional()
  @IsString()
  buttonLabel?: string;

  @IsOptional()
  @IsBoolean()
  requireEmailVerified?: boolean;
}

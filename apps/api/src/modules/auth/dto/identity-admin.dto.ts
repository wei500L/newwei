import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  lastName?: string;

  @IsString()
  primaryRoleId!: string;

  @IsArray()
  @ArrayNotEmpty()
  roleIds!: string[];
}

export class AcceptInviteDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}

export class SubmitNewOrgApplicationDto {
  @IsEmail()
  email!: string;

  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsString()
  orgName!: string;

  @IsString()
  orgSlug!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class SubmitJoinOrgApplicationDto {
  @IsEmail()
  email!: string;

  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsString()
  orgSlug!: string;
}

export class ApproveJoinApplicationDto {
  @IsString()
  primaryRoleId!: string;

  @IsArray()
  @ArrayNotEmpty()
  roleIds!: string[];
}

export class RejectApplicationDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ExchangeHandoffTokenDto {
  @IsString()
  handoffToken!: string;
}

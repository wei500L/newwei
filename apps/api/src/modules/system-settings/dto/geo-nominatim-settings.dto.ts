import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";

export class UpdateGeoNominatimSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  userAgent?: string | null;

  @IsOptional()
  @IsString()
  @IsEmail()
  email?: string | null;
}


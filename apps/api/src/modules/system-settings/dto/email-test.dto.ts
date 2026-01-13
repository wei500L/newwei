import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class EmailTestDto {
  @IsOptional()
  @IsString()
  @MaxLength(320)
  @IsEmail()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  subject?: string;
}


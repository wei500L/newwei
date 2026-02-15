import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, Matches } from "class-validator";

export class SendLoginCodeDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email!: string;
}

export class LoginWithCodeDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "12345678" })
  @IsString()
  @Matches(/^\d{8}$/)
  code!: string;

  @ApiPropertyOptional({ description: "Organization id or slug to log into" })
  @IsOptional()
  @IsString()
  orgId?: string;
}

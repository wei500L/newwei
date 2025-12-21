import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "Change_me123!" })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ description: "Organization id or slug to log into" })
  @IsOptional()
  @IsString()
  orgId?: string;
}

export class LoginResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: "bearer" })
  tokenType = "bearer";

  @ApiProperty()
  expiresIn!: number;
}

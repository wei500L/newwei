import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MinLength } from "class-validator";

export class LogoutDto {
  @ApiPropertyOptional({ description: "Refresh token for the current session" })
  @IsOptional()
  @IsString()
  @MinLength(20)
  refreshToken?: string;

  @ApiPropertyOptional({
    description: "Revoke refresh tokens for all sessions belonging to the user"
  })
  @IsOptional()
  @IsBoolean()
  logoutAll?: boolean;
}

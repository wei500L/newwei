import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MinLength(20)
  refreshToken!: string;

  @ApiPropertyOptional({ description: "Organization to refresh session for" })
  @IsOptional()
  @IsString()
  orgId?: string;
}

import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: "https://cdn.example.com/avatars/user.png" })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  avatarUrl?: string;
}

import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Max, Min } from "class-validator";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export class AvatarPresignRequestDto {
  @ApiProperty({ example: "image/png" })
  @IsString()
  @IsIn(["image/jpeg", "image/png", "image/webp"])
  contentType!: string;

  @ApiProperty({ example: 102400 })
  @IsInt()
  @Min(1)
  @Max(MAX_AVATAR_BYTES)
  contentLength!: number;
}

export class AvatarPresignResponseDto {
  @ApiProperty()
  uploadUrl!: string;

  @ApiProperty()
  publicUrl!: string;

  @ApiProperty()
  objectKey!: string;
}

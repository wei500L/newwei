import { ApiProperty } from "@nestjs/swagger";
import { ArrayNotEmpty, IsArray, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateRoleDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  name!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  permissions!: string[];
}

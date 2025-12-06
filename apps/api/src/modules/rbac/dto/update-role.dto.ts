import { ApiProperty } from "@nestjs/swagger";
import { ArrayNotEmpty, IsArray, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateRoleDto {
  @ApiProperty()
  @IsString()
  id!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  permissions!: string[];
}

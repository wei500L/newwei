import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class AssignRoleDto {
  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiProperty()
  @IsString()
  roleId!: string;
}

import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsNumberString, IsOptional, IsString } from "class-validator";

export class ListItemsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  page?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  pageSize?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}

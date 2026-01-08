import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNumberString, IsOptional, IsString } from "class-validator";

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

  @ApiPropertyOptional({ enum: ["CREATED_DESC", "PUBLISHED_DESC"] })
  @IsOptional()
  @IsIn(["CREATED_DESC", "PUBLISHED_DESC"])
  orderBy?: string;
}

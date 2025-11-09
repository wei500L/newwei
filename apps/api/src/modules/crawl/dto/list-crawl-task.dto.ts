import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { CrawlTaskStatus } from "@prisma/client";

export class ListCrawlTaskDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(CrawlTaskStatus)
  status?: CrawlTaskStatus;
}

export class CrawlTaskDetailQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  resultLimit?: number;

  @IsOptional()
  @IsString()
  resultSearch?: string;
}

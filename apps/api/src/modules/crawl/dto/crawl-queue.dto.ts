import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";

export class UpdateCrawlQueueConcurrencyDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxConcurrency!: number;
}

import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";

export class BatchUpdateNewsSourceFrequencyDto {
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(2_592_000)
  frequencySeconds!: number;
}

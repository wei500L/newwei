import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 100;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

export class UpdateArchivePreparationSettingsDto {
  @ApiProperty({ minimum: MIN_BATCH_SIZE, maximum: MAX_BATCH_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_BATCH_SIZE)
  @Max(MAX_BATCH_SIZE)
  jobBatchSize!: number;

  @ApiProperty({ minimum: MIN_BATCH_SIZE, maximum: MAX_BATCH_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_BATCH_SIZE)
  @Max(MAX_BATCH_SIZE)
  embeddingBatchSize!: number;

  @ApiProperty({ minimum: MIN_CONCURRENCY, maximum: MAX_CONCURRENCY })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CONCURRENCY)
  @Max(MAX_CONCURRENCY)
  embeddingMaxConcurrency!: number;

  @ApiProperty({ minimum: MIN_CONCURRENCY, maximum: MAX_CONCURRENCY })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CONCURRENCY)
  @Max(MAX_CONCURRENCY)
  rerankMaxConcurrency!: number;
}

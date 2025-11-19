import { Type } from "class-transformer";
import { IsInt, Max, Min, ValidateNested } from "class-validator";

export class RateLimitBucketDto {
  @IsInt()
  @Min(1)
  @Max(1_000)
  limit!: number;

  @IsInt()
  @Min(5)
  @Max(86_400)
  windowSeconds!: number;
}

export class UpdateRateLimitSettingsDto {
  @ValidateNested()
  @Type(() => RateLimitBucketDto)
  login!: RateLimitBucketDto;

  @ValidateNested()
  @Type(() => RateLimitBucketDto)
  crawlCreate!: RateLimitBucketDto;

  @ValidateNested()
  @Type(() => RateLimitBucketDto)
  rbacWrite!: RateLimitBucketDto;
}

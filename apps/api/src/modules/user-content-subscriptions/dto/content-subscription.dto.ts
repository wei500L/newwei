import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const CONTENT_SUBSCRIPTION_KIND_VALUES = [
  'topic',
  'entity',
  'source',
  'keyword',
  'geo',
] as const;
export const CONTENT_SUBSCRIPTION_SOURCE_VALUES = [
  'manual',
  'recommendation',
  'related',
  'legacy',
] as const;

export class ContentSubscriptionInputDto {
  @IsIn(CONTENT_SUBSCRIPTION_KIND_VALUES)
  kind!: (typeof CONTENT_SUBSCRIPTION_KIND_VALUES)[number];

  @IsString()
  @MaxLength(128)
  value!: string;

  @IsOptional()
  @IsIn(CONTENT_SUBSCRIPTION_SOURCE_VALUES)
  source?: (typeof CONTENT_SUBSCRIPTION_SOURCE_VALUES)[number];
}

export class BatchUpsertUserContentSubscriptionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ContentSubscriptionInputDto)
  subscriptions!: ContentSubscriptionInputDto[];
}

export class BatchDeleteUserContentSubscriptionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ContentSubscriptionInputDto)
  subscriptions!: ContentSubscriptionInputDto[];
}

export class ListContentSubscriptionCatalogDto {
  @IsOptional()
  @IsIn(CONTENT_SUBSCRIPTION_KIND_VALUES)
  kind?: (typeof CONTENT_SUBSCRIPTION_KIND_VALUES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  taxonomyPath?: string;

  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class LookupContentSubscriptionCatalogDto {
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => ContentSubscriptionInputDto)
  entries!: ContentSubscriptionInputDto[];
}

export class ContentSubscriptionLimitQueryDto {
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class RelatedTopicsQueryDto {
  @IsString()
  @MaxLength(128)
  topic!: string;

  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

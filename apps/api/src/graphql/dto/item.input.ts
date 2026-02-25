import { ArgsType, Field, GraphQLISODateTime, InputType, Int, registerEnumType } from "@nestjs/graphql";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength
} from "class-validator";

export enum ItemsOrderBy {
  CREATED_DESC = "CREATED_DESC",
  PUBLISHED_DESC = "PUBLISHED_DESC"
}

registerEnumType(ItemsOrderBy, { name: "ItemsOrderBy" });

export enum ItemsRankingMode {
  RECENCY = "RECENCY",
  RELEVANCE = "RELEVANCE"
}

registerEnumType(ItemsRankingMode, { name: "ItemsRankingMode" });

export enum RssTranslationProvider {
  deeplx = "deeplx",
  llm = "llm"
}

registerEnumType(RssTranslationProvider, { name: "RssTranslationProvider" });

export enum RssTranslationField {
  title = "title",
  summary = "summary",
  key_points = "key_points",
  cleaned_markdown = "cleaned_markdown"
}

registerEnumType(RssTranslationField, { name: "RssTranslationField" });

@InputType()
export class CreateItemInput {
  @Field()
  @IsString()
  @MinLength(3)
  title!: string;

  @Field()
  @IsString()
  @MinLength(3)
  externalId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  status?: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  payload!: string;
}

@InputType()
export class UpdateItemInput {
  @Field()
  @IsString()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  status?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  payload?: string;
}

@InputType()
export class ItemsDateRangeInput {
  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  start?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  end?: Date;
}

@InputType()
export class ItemsFiltersInput {
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceIds?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  regions?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topics?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sentiments?: string[];

  @Field(() => Boolean, { nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  excludeDuplicates?: boolean;

  @Field(() => ItemsDateRangeInput, { nullable: true })
  @IsOptional()
  dateRange?: ItemsDateRangeInput;
}

@InputType()
export class TranslateRssItemsInput {
  @Field(() => [String])
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  itemIds!: string[];

  @Field(() => RssTranslationProvider, { defaultValue: RssTranslationProvider.deeplx })
  @IsEnum(RssTranslationProvider)
  provider: RssTranslationProvider = RssTranslationProvider.deeplx;

  @Field(() => [RssTranslationField], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsEnum(RssTranslationField, { each: true })
  fields?: RssTranslationField[];

  @Field(() => String, { defaultValue: "zh-CN" })
  @IsString()
  @MaxLength(16)
  targetLanguage = "zh-CN";
}

@ArgsType()
export class ItemsQueryArgs {
  @Field(() => Int, { defaultValue: 10 })
  @IsInt()
  @Min(1)
  first = 10;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  after?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => ItemsFiltersInput, { nullable: true })
  @IsOptional()
  filters?: ItemsFiltersInput;

  @Field(() => ItemsOrderBy, { defaultValue: ItemsOrderBy.CREATED_DESC })
  @IsOptional()
  orderBy: ItemsOrderBy = ItemsOrderBy.CREATED_DESC;

  @Field(() => ItemsRankingMode, { nullable: true })
  @IsOptional()
  @IsEnum(ItemsRankingMode)
  rankingMode?: ItemsRankingMode;
}

@ArgsType()
export class ItemsFacetsArgs {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => ItemsFiltersInput, { nullable: true })
  @IsOptional()
  filters?: ItemsFiltersInput;
}

import { Field, GraphQLISODateTime, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class NewsEventBriefPointModel {
  @Field()
  text!: string;

  @Field(() => [Int])
  citations!: number[];
}

@ObjectType()
export class NewsEventBriefComparisonModel {
  @Field(() => [NewsEventBriefPointModel])
  consensus!: NewsEventBriefPointModel[];

  @Field(() => [NewsEventBriefPointModel])
  divergence!: NewsEventBriefPointModel[];
}

@ObjectType()
export class NewsEventBriefSourceModel {
  @Field(() => Int)
  index!: number;

  @Field()
  url!: string;

  @Field(() => String, { nullable: true })
  sourceLabel?: string | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt?: Date | null;

  @Field(() => String, { nullable: true })
  processedItemId?: string | null;

  @Field(() => String, { nullable: true })
  processedArticleId?: string | null;
}

@ObjectType()
export class NewsEventBriefModel {
  @Field(() => Int)
  version!: number;

  @Field(() => GraphQLISODateTime)
  generatedAt!: Date;

  @Field()
  language!: string;

  @Field()
  detailedSummary!: string;

  @Field()
  tldr!: string;

  @Field(() => [NewsEventBriefPointModel])
  keyPoints!: NewsEventBriefPointModel[];

  @Field(() => [NewsEventBriefPointModel])
  whyItMatters!: NewsEventBriefPointModel[];

  @Field(() => NewsEventBriefPointModel, { nullable: true })
  latestUpdate?: NewsEventBriefPointModel | null;

  @Field(() => [NewsEventBriefPointModel])
  whatToWatch!: NewsEventBriefPointModel[];

  @Field(() => NewsEventBriefComparisonModel, { nullable: true })
  comparison?: NewsEventBriefComparisonModel | null;

  @Field(() => String, { nullable: true })
  limitations?: string | null;

  @Field(() => [NewsEventBriefSourceModel])
  sources!: NewsEventBriefSourceModel[];
}

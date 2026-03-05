import {
  Field,
  Float,
  GraphQLISODateTime,
  Int,
  ObjectType,
  registerEnumType,
} from "@nestjs/graphql";

import {
  ArchiveMatchOrigin,
  ArchiveRegion,
  ArchiveVertical,
  ArchiveWeight,
} from "../../modules/archive/archive.types";

registerEnumType(ArchiveRegion, { name: "ArchiveRegion" });
registerEnumType(ArchiveVertical, { name: "ArchiveVertical" });
registerEnumType(ArchiveWeight, { name: "ArchiveWeight" });
registerEnumType(ArchiveMatchOrigin, { name: "ArchiveMatchOrigin" });

@ObjectType()
export class ArchiveEventItemModel {
  @Field()
  processedArticleId!: string;

  @Field(() => String, { nullable: true })
  eventId?: string | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => String, { nullable: true })
  countryLabel?: string | null;

  @Field(() => ArchiveRegion)
  region!: ArchiveRegion;

  @Field(() => ArchiveVertical)
  vertical!: ArchiveVertical;

  @Field(() => Int)
  weight!: number;

  @Field(() => Float, { nullable: true })
  qualityScore?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt?: Date | null;

  @Field(() => GraphQLISODateTime)
  sortAt!: Date;

  @Field(() => String, { nullable: true })
  sourceLabel?: string | null;

  @Field(() => String, { nullable: true })
  sourceUrl?: string | null;

  @Field(() => [String])
  entityTags!: string[];

  @Field(() => [String])
  keywordHighlights!: string[];

  @Field(() => ArchiveMatchOrigin, { nullable: true })
  matchOrigin?: ArchiveMatchOrigin | null;

  @Field(() => Float, { nullable: true })
  relevanceScore?: number | null;
}

@ObjectType()
export class ArchiveVerticalGroupModel {
  @Field(() => ArchiveVertical)
  vertical!: ArchiveVertical;

  @Field()
  displayName!: string;

  @Field(() => Int)
  totalCount!: number;

  @Field(() => [ArchiveEventItemModel])
  items!: ArchiveEventItemModel[];

  @Field(() => ArchiveVerticalPageInfoModel)
  pageInfo!: ArchiveVerticalPageInfoModel;
}

@ObjectType()
export class ArchiveVerticalPageInfoModel {
  @Field(() => Boolean)
  hasMore!: boolean;

  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
}

@ObjectType()
export class ArchiveDigestModel {
  @Field(() => GraphQLISODateTime)
  anchorDate!: Date;

  @Field(() => ArchiveRegion)
  region!: ArchiveRegion;

  @Field(() => Int)
  totalCount!: number;

  @Field(() => [ArchiveVerticalGroupModel])
  groups!: ArchiveVerticalGroupModel[];
}

@ObjectType()
export class ArchiveCalendarDayModel {
  @Field()
  date!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType()
export class ArchiveTimelineEntryModel {
  @Field()
  id!: string;

  @Field(() => GraphQLISODateTime)
  bucketStart!: Date;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;
}

@ObjectType()
export class ArchiveRelatedArticleModel {
  @Field()
  processedArticleId!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt?: Date | null;

  @Field(() => String, { nullable: true })
  sourceLabel?: string | null;

  @Field(() => String, { nullable: true })
  sourceUrl?: string | null;
}

@ObjectType()
export class ArchiveDetailModel {
  @Field()
  processedArticleId!: string;

  @Field(() => String, { nullable: true })
  eventId?: string | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => [String])
  fullEntities!: string[];

  @Field(() => String, { nullable: true })
  sourceUrl?: string | null;

  @Field(() => String, { nullable: true })
  sourceLabel?: string | null;

  @Field(() => [ArchiveTimelineEntryModel])
  timeline!: ArchiveTimelineEntryModel[];

  @Field(() => [ArchiveRelatedArticleModel])
  relatedArticles!: ArchiveRelatedArticleModel[];
}

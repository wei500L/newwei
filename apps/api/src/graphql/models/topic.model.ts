import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TopicItemModel {
  @Field(() => ID)
  id!: string;

  @Field()
  itemMetaId!: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  summary?: string;

  @Field({ nullable: true })
  source?: string;

  @Field({ nullable: true })
  publishedAt?: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class TopicGroupModel {
  @Field()
  topic!: string;

  @Field(() => Int)
  count!: number;

  @Field(() => GraphQLISODateTime)
  latestAt!: Date;

  @Field(() => [TopicItemModel])
  items!: TopicItemModel[];
}

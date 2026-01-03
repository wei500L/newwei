import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class EventGroupItemModel {
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
export class EventGroupModel {
  @Field()
  eventId!: string;

  @Field(() => Int)
  count!: number;

  @Field(() => GraphQLISODateTime)
  latestAt!: Date;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  summary?: string;

  @Field({ nullable: true })
  source?: string;

  @Field({ nullable: true })
  publishedAt?: string;

  @Field(() => [String])
  topics!: string[];

  @Field(() => [String])
  entities!: string[];

  @Field(() => [EventGroupItemModel])
  items!: EventGroupItemModel[];
}

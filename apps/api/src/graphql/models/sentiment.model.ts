import { Field, Float, GraphQLISODateTime, Int, ObjectType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

@ObjectType()
export class EntitySentimentSnapshotModel {
  @Field(() => String)
  entityName!: string;

  @Field(() => String)
  entityType!: string;

  @Field(() => GraphQLISODateTime)
  bucketStart!: Date;

  @Field(() => Int)
  totalDocs!: number;

  @Field(() => Int)
  negativeDocs!: number;

  @Field(() => Int)
  positiveDocs!: number;

  @Field(() => Int)
  neutralDocs!: number;

  @Field(() => Int)
  scoreSum!: number;

  @Field(() => Float)
  avgScore!: number;

  @Field(() => Float)
  negativeRatio!: number;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  evidenceProcessedItemIds?: unknown;
}

@ObjectType()
export class TopicSentimentSnapshotModel {
  @Field(() => String)
  topic!: string;

  @Field(() => GraphQLISODateTime)
  bucketStart!: Date;

  @Field(() => Int)
  totalDocs!: number;

  @Field(() => Int)
  negativeDocs!: number;

  @Field(() => Int)
  positiveDocs!: number;

  @Field(() => Int)
  neutralDocs!: number;

  @Field(() => Int)
  scoreSum!: number;

  @Field(() => Float)
  avgScore!: number;

  @Field(() => Float)
  negativeRatio!: number;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  evidenceProcessedItemIds?: unknown;
}


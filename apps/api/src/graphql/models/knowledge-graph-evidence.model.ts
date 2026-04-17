import { Field, Float, GraphQLISODateTime, ObjectType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

@ObjectType()
export class KnowledgeGraphEdgeEvidenceArticleModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  url!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => String, { nullable: true })
  language?: string | null;

  @Field(() => GraphQLISODateTime)
  crawlAt!: Date;
}

@ObjectType()
export class KnowledgeGraphEdgeEvidenceItemModel {
  @Field(() => String)
  id!: string;

  @Field(() => Float, { nullable: true })
  confidence?: number | null;

  @Field(() => String, { nullable: true })
  extractorVersion?: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  evidence?: Record<string, unknown> | null;

  @Field(() => KnowledgeGraphEdgeEvidenceArticleModel)
  article!: KnowledgeGraphEdgeEvidenceArticleModel;
}

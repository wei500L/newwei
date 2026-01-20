import { Field, Float, GraphQLISODateTime, ObjectType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

import { KnowledgeGraphNodeModel } from "./knowledge-graph.model";

@ObjectType()
export class KnowledgeGraphReviewArticleModel {
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
export class KnowledgeGraphReviewEdgeModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  type!: string;

  @Field(() => Float)
  confidence!: number;

  @Field(() => Float)
  weight!: number;

  @Field(() => KnowledgeGraphNodeModel)
  fromEntity!: KnowledgeGraphNodeModel;

  @Field(() => KnowledgeGraphNodeModel)
  toEntity!: KnowledgeGraphNodeModel;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  properties?: Record<string, unknown> | null;
}

@ObjectType()
export class KnowledgeGraphEvidenceReviewItemModel {
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

  @Field(() => KnowledgeGraphReviewEdgeModel)
  edge!: KnowledgeGraphReviewEdgeModel;

  @Field(() => KnowledgeGraphReviewArticleModel)
  article!: KnowledgeGraphReviewArticleModel;
}


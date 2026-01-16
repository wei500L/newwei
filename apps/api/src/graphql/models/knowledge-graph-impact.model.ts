import { Field, Float, GraphQLISODateTime, InputType, Int, ObjectType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

import { KnowledgeGraphEdgeModel, KnowledgeGraphNodeModel } from "./knowledge-graph.model";

@ObjectType()
export class KnowledgeGraphExplainChainModel {
  @Field(() => String)
  reason!: string;

  @Field(() => [KnowledgeGraphNodeModel])
  nodes!: KnowledgeGraphNodeModel[];

  @Field(() => [KnowledgeGraphEdgeModel])
  edges!: KnowledgeGraphEdgeModel[];
}

@ObjectType()
export class KnowledgeGraphImpactCandidateModel {
  @Field(() => KnowledgeGraphNodeModel)
  entity!: KnowledgeGraphNodeModel;

  @Field(() => Float)
  score!: number;

  @Field(() => String)
  kind!: string;

  @Field(() => [KnowledgeGraphExplainChainModel])
  chains!: KnowledgeGraphExplainChainModel[];
}

@ObjectType()
export class KnowledgeGraphImpactAnalysisModel {
  @Field(() => String)
  scenario!: string;

  @Field(() => KnowledgeGraphNodeModel)
  seed!: KnowledgeGraphNodeModel;

  @Field(() => [KnowledgeGraphImpactCandidateModel])
  candidates!: KnowledgeGraphImpactCandidateModel[];

  @Field(() => GraphQLJSONScalar, { nullable: true })
  metadata?: Record<string, unknown> | null;

  @Field(() => GraphQLISODateTime)
  generatedAt!: Date;
}

@InputType()
export class ExecutiveChangeImpactInput {
  @Field(() => String)
  companyName!: string;

  @Field(() => Int, { nullable: true })
  maxCandidates?: number;
}

@InputType()
export class CommodityMoveImpactInput {
  @Field(() => String)
  commodityName!: string;

  @Field(() => Int, { nullable: true })
  maxCandidates?: number;
}

@InputType()
export class PolicyEventImpactInput {
  @Field(() => String)
  policyName!: string;

  @Field(() => Int, { nullable: true })
  maxCandidates?: number;

  @Field(() => Boolean, { nullable: true })
  includeLprSnapshot?: boolean;
}


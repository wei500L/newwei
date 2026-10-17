import { Field, Float, GraphQLISODateTime, InputType, Int, ObjectType } from "@nestjs/graphql";
import { Allow } from "class-validator";
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
  @Allow()
  @Field(() => String)
  companyName!: string;

  @Allow()
  @Field(() => Int, { nullable: true })
  maxCandidates?: number;
}

@InputType()
export class CommodityMoveImpactInput {
  @Allow()
  @Field(() => String)
  commodityName!: string;

  @Allow()
  @Field(() => Int, { nullable: true })
  maxCandidates?: number;
}

@InputType()
export class PolicyEventImpactInput {
  @Allow()
  @Field(() => String)
  policyName!: string;

  @Allow()
  @Field(() => Int, { nullable: true })
  maxCandidates?: number;

  @Allow()
  @Field(() => Boolean, { nullable: true })
  includeLprSnapshot?: boolean;
}


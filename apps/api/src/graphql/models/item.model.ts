import { Field, Float, GraphQLISODateTime, HideField, ID, Int, ObjectType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

import { HasPermission } from "../decorators/has-permission.decorator";

import { PageInfo } from "./page-info.model";

@ObjectType()
export class ItemMetaModel {
  @Field(() => ID)
  id!: string;

  @Field()
  externalId!: string;

  @Field()
  name!: string;

  @Field()
  status!: string;

  @Field()
  mongoRef!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class RawItemModelGraph {
  @Field(() => ID)
  id!: string;

  @Field()
  itemMetaId!: string;

  @Field(() => String, { description: "Raw payload JSON string" })
  payload!: string;

  @Field({ nullable: true })
  source?: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class ProcessedItemModelGraph {
  @Field(() => ID)
  id!: string;

  @Field()
  itemMetaId!: string;

  @Field()
  status!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => String, { nullable: true })
  result?: string;

  @Field(() => GraphQLJSONScalar, { nullable: true, description: "Processed result JSON object" })
  resultJson?: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  duplicateOf?: string | null;

  @Field(() => Float, { nullable: true })
  duplicateSimilarity?: number | null;

  @Field(() => ProcessedItemLlmModel, { nullable: true })
  llm?: ProcessedItemLlmModel | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class ProcessedItemLlmModel {
  @Field({ nullable: true })
  model?: string | null;

  @Field({ nullable: true })
  promptVersion?: string | null;

  @Field(() => Float, { nullable: true })
  promptTokens?: number | null;

  @Field(() => Float, { nullable: true })
  completionTokens?: number | null;

  @Field(() => Float, { nullable: true })
  totalTokens?: number | null;

  @Field(() => Float, { nullable: true })
  costUsd?: number | null;

  @Field(() => Float, { nullable: true })
  latencyMs?: number | null;
}

@ObjectType()
export class ItemModel {
  @Field(() => ID)
  id!: string;

  @HideField()
  metaId!: string;

  @Field()
  title!: string;

  @Field()
  status!: string;

  @Field(() => GraphQLISODateTime, { description: "Item ingested time (record createdAt)" })
  ingestedAt!: Date;

  @Field({ nullable: true, description: "Content published time (ISO8601)" })
  publishedAt?: string | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field()
  orgId!: string;

  @HasPermission("items.read")
  @Field(() => ItemMetaModel)
  meta!: ItemMetaModel;

  @HasPermission("items.read")
  @Field(() => RawItemModelGraph, { nullable: true })
  raw?: RawItemModelGraph | null;

  @HasPermission("items.read")
  @Field(() => ProcessedItemModelGraph, { nullable: true })
  processed?: ProcessedItemModelGraph | null;
}

@ObjectType()
export class ItemEdge {
  @Field()
  cursor!: string;

  @Field(() => ItemModel)
  node!: ItemModel;
}

@ObjectType()
export class ItemConnection {
  @Field(() => [ItemEdge])
  edges!: ItemEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}

@ObjectType()
export class ItemFacetOption {
  @Field()
  value!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType()
export class ItemFacets {
  @Field(() => [ItemFacetOption])
  regions!: ItemFacetOption[];

  @Field(() => [ItemFacetOption])
  topics!: ItemFacetOption[];

  @Field(() => [ItemFacetOption])
  sentiments!: ItemFacetOption[];
}

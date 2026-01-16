import { Field, Float, GraphQLISODateTime, InputType, Int, ObjectType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

@ObjectType()
export class KnowledgeGraphNodeModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  type!: string;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  properties?: Record<string, unknown> | null;
}

@ObjectType()
export class KnowledgeGraphEdgeModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  from!: string;

  @Field(() => String)
  to!: string;

  @Field(() => String)
  type!: string;

  @Field(() => Float)
  weight!: number;

  @Field(() => Float)
  confidence!: number;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  properties?: Record<string, unknown> | null;
}

@ObjectType()
export class KnowledgeGraphMetadataModel {
  @Field(() => Int)
  totalNodes!: number;

  @Field(() => Int)
  totalEdges!: number;

  @Field(() => GraphQLISODateTime)
  generatedAt!: Date;
}

@ObjectType()
export class KnowledgeGraphModel {
  @Field(() => KnowledgeGraphNodeModel)
  seed!: KnowledgeGraphNodeModel;

  @Field(() => [KnowledgeGraphNodeModel])
  nodes!: KnowledgeGraphNodeModel[];

  @Field(() => [KnowledgeGraphEdgeModel])
  edges!: KnowledgeGraphEdgeModel[];

  @Field(() => KnowledgeGraphMetadataModel)
  metadata!: KnowledgeGraphMetadataModel;
}

@InputType()
export class KnowledgeGraphSubgraphInput {
  @Field(() => String, { description: "Seed entity name" })
  seedName!: string;

  @Field(() => String, { nullable: true, description: "Optional seed entity type override" })
  seedType?: string;

  @Field(() => Int, { nullable: true, description: "Max BFS depth" })
  maxDepth?: number;

  @Field(() => Int, { nullable: true, description: "Max nodes returned" })
  maxNodes?: number;

  @Field(() => [String], { nullable: true, description: "Restrict edge types" })
  relationTypes?: string[];
}

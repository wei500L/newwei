import { Field, Float, GraphQLISODateTime, InputType, Int, ObjectType } from "@nestjs/graphql";
import {
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min
} from "class-validator";

/**
 * Entity model representing a named entity extracted from news content
 * with type classification and confidence score
 */
@ObjectType()
export class EntityModel {
  @Field(() => String, { description: "Entity name" })
  name!: string;

  @Field(() => String, { description: "Entity type (e.g., PERSON, ORG, LOCATION)" })
  type!: string;

  @Field(() => Float, { description: "Confidence score (0-1)" })
  confidence!: number;
}

/**
 * Node in the entity impact graph representing an entity or financial instrument
 */
@ObjectType()
export class EntityImpactNodeModel {
  @Field(() => String, { description: "Unique node identifier" })
  id!: string;

  @Field(() => String, { description: "Display name of the node" })
  name!: string;

  @Field(() => String, { description: "Node category (e.g., entity, financial)" })
  category!: string;

  @Field(() => String, { description: "Node type (e.g., PERSON, ORG, STOCK, COMMODITY)" })
  type!: string;

  @Field(() => Float, { description: "Node value/weight for visualization sizing" })
  value!: number;
}

/**
 * Link/edge in the entity impact graph representing relationship between nodes
 */
@ObjectType()
export class EntityImpactLinkModel {
  @Field(() => String, { description: "Source node ID" })
  source!: string;

  @Field(() => String, { description: "Target node ID" })
  target!: string;

  @Field(() => Float, { description: "Link strength/weight" })
  value!: number;

  @Field(() => String, { description: "Relationship type (e.g., co-occurrence, correlation)" })
  type!: string;
}

/**
 * Metadata about the generated entity impact graph
 */
@ObjectType()
export class EntityImpactMetadataModel {
  @Field(() => Int, { description: "Total number of nodes in the graph" })
  totalNodes!: number;

  @Field(() => Int, { description: "Total number of links in the graph" })
  totalLinks!: number;

  @Field(() => GraphQLISODateTime, { description: "Timestamp when the graph was generated" })
  generatedAt!: Date;
}

/**
 * Complete entity impact graph with nodes, links, and metadata
 */
@ObjectType()
export class EntityImpactGraphModel {
  @Field(() => [EntityImpactNodeModel], { description: "Graph nodes (entities and financial instruments)" })
  nodes!: EntityImpactNodeModel[];

  @Field(() => [EntityImpactLinkModel], { description: "Graph links/edges representing relationships" })
  links!: EntityImpactLinkModel[];

  @Field(() => EntityImpactMetadataModel, { description: "Graph metadata" })
  metadata!: EntityImpactMetadataModel;
}

/**
 * Input parameters for querying entity impact graph
 */
@InputType()
export class EntityImpactGraphInput {
  @Field(() => GraphQLISODateTime, { nullable: true, description: "Start date for data range" })
  @IsOptional()
  @IsDate()
  startDate?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true, description: "End date for data range" })
  @IsOptional()
  @IsDate()
  endDate?: Date;

  @Field(() => Float, { nullable: true, description: "Minimum entity confidence threshold (0-1)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidence?: number;

  @Field(() => Float, { nullable: true, description: "Minimum absolute correlation threshold (0-1)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minCorrelation?: number;

  @Field(() => Int, { nullable: true, description: "Minimum co-occurrence count between entities" })
  @IsOptional()
  @IsInt()
  @Min(1)
  minCoOccurrence?: number;

  @Field(() => Int, { nullable: true, description: "Maximum number of nodes to return" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxNodes?: number;

  @Field(() => [String], {
    nullable: true,
    description: "Restrict graph to categories (person, organization, stock, commodity)"
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(["person", "organization", "stock", "commodity"], { each: true })
  categories?: string[];
}

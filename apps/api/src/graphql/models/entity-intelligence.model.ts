import {
  Field,
  Float,
  GraphQLISODateTime,
  InputType,
  Int,
  ObjectType,
} from "@nestjs/graphql";

import {
  KnowledgeGraphEdgeModel,
  KnowledgeGraphModel,
  KnowledgeGraphNodeModel,
} from "./knowledge-graph.model";
import { EntitySentimentSnapshotModel } from "./sentiment.model";

@InputType()
export class EntityIntelligenceCardInput {
  @Field(() => String)
  entityId!: string;

  @Field(() => Int, { nullable: true })
  windowDays?: number;

  @Field(() => Int, { nullable: true })
  relatedLimit?: number;
}

@InputType()
export class EntityIntelligenceEvidenceInput {
  @Field(() => String)
  entityId!: string;

  @Field(() => Int, { nullable: true })
  windowDays?: number;

  @Field(() => Int, { nullable: true })
  eventsLimit?: number;

  @Field(() => Int, { nullable: true })
  evidenceLimit?: number;
}

@ObjectType()
export class EntityIntelligenceMetricsModel {
  @Field(() => Int)
  relationshipCount!: number;

  @Field(() => Int)
  incomingEdgeCount!: number;

  @Field(() => Int)
  outgoingEdgeCount!: number;

  @Field(() => Int)
  mentionedArticleCount!: number;

  @Field(() => Int)
  recentEventCount!: number;

  @Field(() => Float, { nullable: true })
  avgSentiment?: number | null;

  @Field(() => Float, { nullable: true })
  negativeRatio?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  latestMentionAt?: Date | null;
}

@ObjectType()
export class EntityIntelligenceRelationshipModel {
  @Field(() => String)
  direction!: "incoming" | "outgoing";

  @Field(() => KnowledgeGraphEdgeModel)
  edge!: KnowledgeGraphEdgeModel;

  @Field(() => KnowledgeGraphNodeModel)
  neighbor!: KnowledgeGraphNodeModel;

  @Field(() => Int)
  evidenceCount!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  latestEvidenceAt?: Date | null;
}

@ObjectType()
export class EntityIntelligenceCardModel {
  @Field(() => KnowledgeGraphNodeModel)
  entity!: KnowledgeGraphNodeModel;

  @Field(() => [String])
  aliases!: string[];

  @Field(() => EntityIntelligenceMetricsModel)
  metrics!: EntityIntelligenceMetricsModel;

  @Field(() => [EntityIntelligenceRelationshipModel])
  relationships!: EntityIntelligenceRelationshipModel[];

  @Field(() => [EntitySentimentSnapshotModel])
  sentimentSeries!: EntitySentimentSnapshotModel[];

  @Field(() => KnowledgeGraphModel)
  neighborhood!: KnowledgeGraphModel;

  @Field(() => GraphQLISODateTime)
  generatedAt!: Date;
}

@ObjectType()
export class EntityIntelligenceEventModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  status!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => String, { nullable: true })
  primaryTopic?: string | null;

  @Field(() => String, { nullable: true })
  primaryEntity?: string | null;

  @Field(() => GraphQLISODateTime)
  startAt!: Date;

  @Field(() => GraphQLISODateTime)
  lastAt!: Date;

  @Field(() => Int)
  itemCount!: number;
}

@ObjectType()
export class EntityIntelligenceArticleModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  url!: string;

  @Field(() => String, { nullable: true })
  sourceLabel?: string | null;

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
export class EntityIntelligenceEvidenceArticleModel {
  @Field(() => EntityIntelligenceArticleModel)
  article!: EntityIntelligenceArticleModel;

  @Field(() => String, { nullable: true })
  mention?: string | null;

  @Field(() => Float, { nullable: true })
  confidence?: number | null;

  @Field(() => GraphQLISODateTime)
  linkedAt!: Date;
}

@ObjectType()
export class EntityIntelligenceEvidenceModel {
  @Field(() => Boolean)
  restricted!: boolean;

  @Field(() => [EntityIntelligenceEventModel])
  events!: EntityIntelligenceEventModel[];

  @Field(() => [EntityIntelligenceEvidenceArticleModel])
  articles!: EntityIntelligenceEvidenceArticleModel[];

  @Field(() => GraphQLISODateTime)
  generatedAt!: Date;
}

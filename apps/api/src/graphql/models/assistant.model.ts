import { Field, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

export enum AssistantRunType {
  query = "query",
  report = "report",
  forecast = "forecast"
}

export enum AssistantRunStatus {
  pending = "pending",
  running = "running",
  completed = "completed",
  failed = "failed"
}

registerEnumType(AssistantRunType, { name: "AssistantRunType" });
registerEnumType(AssistantRunStatus, { name: "AssistantRunStatus" });

@ObjectType()
export class AssistantRunModel {
  @Field()
  id!: string;

  @Field(() => AssistantRunType)
  type!: AssistantRunType;

  @Field(() => AssistantRunStatus)
  status!: AssistantRunStatus;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => String, { nullable: true })
  error?: string | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  input?: Record<string, unknown> | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  output?: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  conversationId?: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType("EconomicSeriesSuggestion")
export class EconomicSeriesSuggestionModel {
  @Field()
  slug!: string;

  @Field()
  displayName!: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => String, { nullable: true })
  docUrl?: string | null;
}

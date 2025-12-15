import { Field, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import GraphQLJSON from "graphql-type-json";

export enum AnalysisType {
  correlation = "correlation",
  anomaly = "anomaly"
}

export enum AnalysisStatus {
  pending = "pending",
  running = "running",
  completed = "completed",
  failed = "failed"
}

registerEnumType(AnalysisType, { name: "AnalysisType" });
registerEnumType(AnalysisStatus, { name: "AnalysisStatus" });

@ObjectType()
export class AnalysisResultModel {
  @Field()
  id!: string;

  @Field(() => AnalysisType)
  type!: AnalysisType;

  @Field(() => AnalysisStatus)
  status!: AnalysisStatus;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => String, { nullable: true })
  error?: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  input?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  output?: Record<string, unknown>;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

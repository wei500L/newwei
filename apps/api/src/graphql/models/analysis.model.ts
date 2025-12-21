import { Field, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import GraphQLJSONScalar from "graphql-type-json";

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

  @Field(() => GraphQLJSONScalar, { nullable: true })
  input?: Record<string, unknown>;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  output?: Record<string, unknown>;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

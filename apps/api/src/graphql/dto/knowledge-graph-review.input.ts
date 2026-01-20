import { Field, InputType } from "@nestjs/graphql";
import { IsIn, IsOptional, MaxLength } from "class-validator";
import GraphQLJSONScalar from "graphql-type-json";

@InputType()
export class ReviewKnowledgeGraphEvidenceInput {
  @Field(() => String)
  evidenceId!: string;

  @Field(() => String)
  @IsIn(["approved", "rejected", "corrected"])
  status!: "approved" | "rejected" | "corrected";

  @Field(() => String, { nullable: true })
  @IsOptional()
  @MaxLength(500)
  note?: string | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  correctedRelation?: Record<string, unknown> | null;
}

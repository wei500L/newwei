import { Field, Float, GraphQLISODateTime, ObjectType } from "@nestjs/graphql";

import { KnowledgeGraphNodeModel } from "./knowledge-graph.model";

@ObjectType()
export class ArticleEntityLinkModel {
  @Field(() => String)
  articleId!: string;

  @Field(() => KnowledgeGraphNodeModel)
  entity!: KnowledgeGraphNodeModel;

  @Field(() => String, { nullable: true })
  mention?: string | null;

  @Field(() => Float, { nullable: true })
  confidence?: number | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}


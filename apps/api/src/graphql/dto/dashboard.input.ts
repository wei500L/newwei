import { Field, InputType, Int } from "@nestjs/graphql";
import { DashboardWidgetType } from "@prisma/client";
import GraphQLJSON from "graphql-type-json";

@InputType()
export class DashboardWidgetInput {
  @Field({ nullable: true })
  id?: string;

  @Field({ nullable: true })
  title?: string;

  @Field(() => DashboardWidgetType)
  type!: DashboardWidgetType;

  @Field()
  dataSource!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  dataConfig?: Record<string, unknown>;

  @Field(() => Int)
  layoutX!: number;

  @Field(() => Int)
  layoutY!: number;

  @Field(() => Int)
  layoutW!: number;

  @Field(() => Int)
  layoutH!: number;

  @Field(() => Int, { nullable: true })
  sortOrder?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  options?: Record<string, unknown>;
}

@InputType()
export class UpsertDashboardInput {
  @Field({ nullable: true })
  id?: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  theme?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  config?: Record<string, unknown>;

  @Field(() => [DashboardWidgetInput])
  widgets!: DashboardWidgetInput[];
}

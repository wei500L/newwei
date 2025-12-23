import { Field, InputType, Int } from "@nestjs/graphql";
import { DashboardWidgetType } from "@prisma/client";
import { IsArray, IsEnum, IsInt, IsObject, IsOptional, IsString, Min } from "class-validator";
import GraphQLJSONScalar from "graphql-type-json";

@InputType()
export class DashboardWidgetInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  id?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  title?: string;

  @Field(() => DashboardWidgetType)
  @IsEnum(DashboardWidgetType)
  type!: DashboardWidgetType;

  @Field()
  @IsString()
  dataSource!: string;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  @IsObject()
  dataConfig?: Record<string, unknown>;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  layoutX!: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  layoutY!: number;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  layoutW!: number;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  layoutH!: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

@InputType()
export class UpsertDashboardInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  id?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;

  @Field()
  @IsString()
  name!: string;

  @Field()
  @IsString()
  slug!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  theme?: string;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @Field(() => [DashboardWidgetInput])
  @IsArray()
  widgets!: DashboardWidgetInput[];
}

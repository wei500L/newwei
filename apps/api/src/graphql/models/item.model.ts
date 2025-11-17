import { Field, GraphQLISODateTime, HideField, ID, Int, ObjectType } from "@nestjs/graphql";
import { PageInfo } from "./page-info.model";
import { HasPermission } from "../decorators/has-permission.decorator";

@ObjectType()
export class ItemMetaModel {
  @Field(() => ID)
  id!: string;

  @Field()
  externalId!: string;

  @Field()
  name!: string;

  @Field()
  status!: string;

  @Field()
  mongoRef!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class RawItemModelGraph {
  @Field(() => ID)
  id!: string;

  @Field()
  itemMetaId!: string;

  @Field(() => String, { description: "Raw payload JSON string" })
  payload!: string;

  @Field({ nullable: true })
  source?: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class ProcessedItemModelGraph {
  @Field(() => ID)
  id!: string;

  @Field()
  itemMetaId!: string;

  @Field()
  status!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => String, { nullable: true })
  result?: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class ItemModel {
  @Field(() => ID)
  id!: string;

  @HideField()
  metaId!: string;

  @Field()
  title!: string;

  @Field()
  status!: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field()
  orgId!: string;

  @HasPermission("items.read")
  @Field(() => ItemMetaModel)
  meta!: ItemMetaModel;

  @HasPermission("items.read")
  @Field(() => RawItemModelGraph, { nullable: true })
  raw?: RawItemModelGraph | null;

  @HasPermission("items.read")
  @Field(() => ProcessedItemModelGraph, { nullable: true })
  processed?: ProcessedItemModelGraph | null;
}

@ObjectType()
export class ItemEdge {
  @Field()
  cursor!: string;

  @Field(() => ItemModel)
  node!: ItemModel;
}

@ObjectType()
export class ItemConnection {
  @Field(() => [ItemEdge])
  edges!: ItemEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}

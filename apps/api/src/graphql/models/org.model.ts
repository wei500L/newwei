import { Field, ObjectType, GraphQLISODateTime } from "@nestjs/graphql";

@ObjectType()
export class OrgModel {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field({ nullable: true })
  description?: string;

  @Field()
  isActive!: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}


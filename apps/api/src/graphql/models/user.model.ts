import { Field, ObjectType } from "@nestjs/graphql";

import { HasPermission } from "../decorators/has-permission.decorator";

@ObjectType()
export class UserModel {
  @Field()
  id!: string;

  @Field()
  email!: string;

  @Field()
  firstName!: string;

  @Field()
  lastName!: string;

  @Field({ nullable: true })
  avatarUrl?: string;

  @Field({ nullable: true })
  planTier?: string;

  @Field({ nullable: true })
  subscriptionStatus?: string;

  @Field()
  orgId!: string;

  @HasPermission("users.read")
  @Field(() => [String])
  roleIds!: string[];

  @Field(() => [String])
  permissions!: string[];
}

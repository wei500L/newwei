import { Field, GraphQLISODateTime, ObjectType } from "@nestjs/graphql";

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
  @Field({ nullable: true })
  primaryRoleId?: string;

  @HasPermission("users.read")
  @Field()
  isActive!: boolean;

  @HasPermission("users.read")
  @Field(() => GraphQLISODateTime, { nullable: true })
  emailVerified?: Date | null;

  @HasPermission("users.read")
  @Field(() => GraphQLISODateTime, { nullable: true })
  lastLoginAt?: Date | null;

  @HasPermission("users.read")
  @Field(() => [String])
  roleIds!: string[];

  @Field(() => [String])
  permissions!: string[];
}

@ObjectType()
export class UserLoginRecordModel {
  @Field()
  id!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => String, { nullable: true })
  ipAddress?: string | null;

  @Field(() => String, { nullable: true })
  userAgent?: string | null;

  @Field()
  method!: string;
}

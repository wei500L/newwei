import { Field, HideField, ObjectType } from "@nestjs/graphql";
import { HasPermission } from "../decorators/has-permission.decorator";
import { UserModel } from "./user.model";

@ObjectType()
export class PermissionModel {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string | null;
}

@ObjectType()
export class RoleModel {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string | null;

  @Field()
  isSystem!: boolean;

  @HasPermission("roles.read")
  @Field(() => [PermissionModel])
  permissions!: PermissionModel[];
}

@ObjectType()
export class MembershipModel {
  @Field()
  id!: string;

  @Field()
  orgId!: string;

  @HideField()
  userId!: string;

  @HasPermission("users.read")
  @Field(() => RoleModel)
  role!: RoleModel;

  @HasPermission("users.read")
  @Field(() => [RoleModel])
  roles!: RoleModel[];

  @HasPermission("users.read")
  @Field(() => UserModel)
  user!: UserModel;
}

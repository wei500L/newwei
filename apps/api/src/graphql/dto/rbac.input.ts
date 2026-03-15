import { Field, InputType } from "@nestjs/graphql";
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

@InputType()
export class CreateRoleInput {
  @Field()
  @IsString()
  @MaxLength(64)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => [String])
  @IsArray()
  @ArrayNotEmpty()
  permissions!: string[];
}

@InputType()
export class AssignRoleInput {
  @Field()
  @IsString()
  userId!: string;

  @Field()
  @IsString()
  roleId!: string;
}

@InputType()
export class UpdateRoleInput {
  @Field()
  @IsString()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @Field(() => [String])
  @IsArray()
  @ArrayNotEmpty()
  permissions!: string[];
}

@InputType()
export class UpdateMembershipRolesInput {
  @Field()
  @IsString()
  userId!: string;

  @Field()
  @IsString()
  primaryRoleId!: string;

  @Field(() => [String])
  @IsArray()
  @ArrayNotEmpty()
  roleIds!: string[];
}

@InputType()
export class SetUserActiveInput {
  @Field()
  @IsString()
  userId!: string;

  @Field()
  @IsBoolean()
  isActive!: boolean;
}

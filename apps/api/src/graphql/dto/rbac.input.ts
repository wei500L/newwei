import { Field, InputType } from "@nestjs/graphql";
import { ArrayNotEmpty, IsArray, IsOptional, IsString, MaxLength } from "class-validator";

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

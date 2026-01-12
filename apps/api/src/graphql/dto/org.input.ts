import { Field, InputType } from "@nestjs/graphql";
import { IsBoolean, IsOptional, IsString, MaxLength, Matches } from "class-validator";

@InputType()
export class CreateOrgInput {
  @Field()
  @IsString()
  @MaxLength(120)
  name!: string;

  @Field()
  @IsString()
  @MaxLength(64)
  @Matches(/^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$/u, {
    message: "Slug must contain letters, numbers, and hyphens (e.g. acme-corp)"
  })
  slug!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

@InputType()
export class UpdateOrgInput {
  @Field()
  @IsString()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[\p{L}\p{N}][\p{L}\p{N}-]{1,62}[\p{L}\p{N}]$/u, {
    message: "Slug must contain letters, numbers, and hyphens (e.g. acme-corp)"
  })
  slug?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

@InputType()
export class SetOrgActiveInput {
  @Field()
  @IsString()
  id!: string;

  @Field()
  @IsBoolean()
  isActive!: boolean;
}

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
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, {
    message: "Slug must be lowercase and hyphenated (e.g. acme-corp)"
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
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, {
    message: "Slug must be lowercase and hyphenated (e.g. acme-corp)"
  })
  slug?: string;

  @Field({ nullable: true })
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


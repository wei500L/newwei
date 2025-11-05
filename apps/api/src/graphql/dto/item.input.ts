import { ArgsType, Field, InputType, Int } from "@nestjs/graphql";
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";

@InputType()
export class CreateItemInput {
  @Field()
  @IsString()
  @MinLength(3)
  title!: string;

  @Field()
  @IsString()
  @MinLength(3)
  externalId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  status?: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  payload!: string;
}

@InputType()
export class UpdateItemInput {
  @Field()
  @IsString()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  status?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  payload?: string;
}

@ArgsType()
export class ItemsQueryArgs {
  @Field(() => Int, { defaultValue: 10 })
  @IsInt()
  @Min(1)
  first = 10;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  after?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}

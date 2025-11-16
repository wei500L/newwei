import { Field, GraphQLISODateTime, InputType } from "@nestjs/graphql";
import { IsArray, IsDate, IsOptional, IsString, MinLength } from "class-validator";

@InputType()
export class DateRangeInput {
  @Field(() => GraphQLISODateTime)
  @IsDate()
  start!: Date;

  @Field(() => GraphQLISODateTime)
  @IsDate()
  end!: Date;
}

@InputType()
export class TriggerDataFetchInput {
  @Field(() => [String])
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  slugs!: string[];
}

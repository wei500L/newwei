import { Field, GraphQLISODateTime, InputType, Int } from "@nestjs/graphql";
import { IsArray, IsDate, IsInt, IsOptional, IsString, Max, Min, MinLength } from "class-validator";

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

@InputType()
export class PaginationInput {
  @Field(() => String, { nullable: true, description: "Cursor for pagination" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @Field(() => Int, { nullable: true, description: "Number of items to return (default: 100, max: 1000)" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

import { ArgsType, Field, ID, InputType, Int, registerEnumType } from "@nestjs/graphql";
import { CrawlTaskStatus } from "@prisma/client";

@InputType()
export class CrawlTimeRangeInput {
  @Field({ nullable: true })
  from?: string;

  @Field({ nullable: true })
  to?: string;
}

@InputType()
export class CrawlOptionsInput {
  @Field(() => Boolean, { nullable: true })
  includeImages?: boolean;

  @Field(() => Boolean, { nullable: true })
  onlyMainContent?: boolean;

  @Field(() => Boolean, { nullable: true })
  extractLinks?: boolean;
}

@InputType()
export class CreateCrawlTaskInput {
  @Field()
  url!: string;

  @Field({ nullable: true })
  displayName?: string;

  @Field(() => CrawlTimeRangeInput, { nullable: true })
  timeRange?: CrawlTimeRangeInput;

  @Field(() => Int, { nullable: true })
  concurrency?: number;

  @Field(() => [String], { nullable: true })
  keywords?: string[];

  @Field(() => CrawlOptionsInput, { nullable: true })
  options?: CrawlOptionsInput;
}

@ArgsType()
export class CrawlTasksQueryArgs {
  @Field(() => Int, { defaultValue: 20 })
  first!: number;

  @Field({ nullable: true })
  after?: string;

  @Field({ nullable: true })
  search?: string;

  @Field(() => CrawlTaskStatus, { nullable: true })
  status?: CrawlTaskStatus;
}

@ArgsType()
export class CrawlTaskDetailArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  resultLimit?: number;

  @Field({ nullable: true })
  resultSearch?: string;
}

registerEnumType(CrawlTaskStatus, {
  name: "CrawlTaskStatus"
});

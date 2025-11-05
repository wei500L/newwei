import { Field, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class PageInfo {
  @Field()
  hasNextPage!: boolean;

  @Field({ nullable: true })
  endCursor?: string | null;
}

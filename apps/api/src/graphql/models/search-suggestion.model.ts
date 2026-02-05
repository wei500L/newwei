import { Field, ID, ObjectType, registerEnumType } from "@nestjs/graphql";

export enum SearchSuggestionType {
  TOPIC = "TOPIC",
  REGION = "REGION",
  SOURCE = "SOURCE",
  SENTIMENT = "SENTIMENT"
}

registerEnumType(SearchSuggestionType, {
  name: "SearchSuggestionType",
  description: "Type of search suggestion"
});

@ObjectType()
export class SearchSuggestionModel {
  @Field(() => SearchSuggestionType)
  type!: SearchSuggestionType;

  @Field()
  value!: string;
}

import { Field, ObjectType, registerEnumType } from "@nestjs/graphql";

export enum SearchSuggestionType {
  TOPIC = "TOPIC",
  REGION = "REGION",
  SOURCE = "SOURCE",
  SENTIMENT = "SENTIMENT"
}

export enum SearchSuggestionOrigin {
  LEXICAL = "LEXICAL",
  SEMANTIC = "SEMANTIC",
  HYBRID = "HYBRID"
}

registerEnumType(SearchSuggestionType, {
  name: "SearchSuggestionType",
  description: "Type of search suggestion"
});

registerEnumType(SearchSuggestionOrigin, {
  name: "SearchSuggestionOrigin",
  description: "How the suggestion was produced"
});

@ObjectType()
export class SearchSuggestionModel {
  @Field(() => SearchSuggestionType)
  type!: SearchSuggestionType;

  @Field()
  value!: string;

  @Field(() => SearchSuggestionOrigin)
  origin!: SearchSuggestionOrigin;
}

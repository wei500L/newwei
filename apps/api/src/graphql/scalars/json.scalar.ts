import { Scalar } from "@nestjs/graphql";
import GraphQLJSON from "graphql-type-json";
import type { ValueNode } from "graphql";

@Scalar("JSON", () => GraphQLJSON)
export class GraphQLJSONScalar {
  description = "Arbitrary JSON value";

  parseValue(value: unknown) {
    return GraphQLJSON.parseValue(value);
  }

  serialize(value: unknown) {
    return GraphQLJSON.serialize(value);
  }

  parseLiteral(ast: ValueNode, variables?: Record<string, unknown>) {
    return (GraphQLJSON.parseLiteral as (astNode: ValueNode, vars?: Record<string, unknown>) => unknown)(
      ast,
      variables
    );
  }
}

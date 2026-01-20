import "reflect-metadata";

import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from "@nestjs/graphql";
import { NestFactory } from "@nestjs/core";
import {
  DirectiveLocation,
  GraphQLDirective,
  GraphQLNonNull,
  GraphQLString,
  lexicographicSortSchema,
  printSchema
} from "graphql";
import { createComplexityDirective } from "graphql-query-complexity";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AlertsResolver } from "../src/graphql/resolvers/alerts.resolver";
import { AnalysisResolver } from "../src/graphql/resolvers/analysis.resolver";
import { AssistantResolver } from "../src/graphql/resolvers/assistant.resolver";
import { CrawlResolver } from "../src/graphql/resolvers/crawl.resolver";
import { DashboardResolver } from "../src/graphql/resolvers/dashboard.resolver";
import { EconomicDataResolver } from "../src/graphql/resolvers/economic-data.resolver";
import { EntityImpactGraphResolver } from "../src/graphql/resolvers/entity-impact-graph.resolver";
import { ItemsResolver } from "../src/graphql/resolvers/items.resolver";
import { KnowledgeGraphImpactResolver } from "../src/graphql/resolvers/knowledge-graph-impact.resolver";
import { KnowledgeGraphResolver } from "../src/graphql/resolvers/knowledge-graph.resolver";
import { KnowledgeGraphReviewResolver } from "../src/graphql/resolvers/knowledge-graph-review.resolver";
import { NewsEventsResolver } from "../src/graphql/resolvers/news-events.resolver";
import { NewsIndicatorResolver } from "../src/graphql/resolvers/news-indicator.resolver";
import { NotificationResolver } from "../src/graphql/resolvers/notification.resolver";
import { OrgResolver } from "../src/graphql/resolvers/org.resolver";
import { RbacResolver } from "../src/graphql/resolvers/rbac.resolver";
import { SentimentResolver } from "../src/graphql/resolvers/sentiment.resolver";
import { SettingsResolver } from "../src/graphql/resolvers/settings.resolver";
import { TopicsResolver } from "../src/graphql/resolvers/topics.resolver";
import { UsersResolver } from "../src/graphql/resolvers/user.resolver";

const resolvers = [
  UsersResolver,
  ItemsResolver,
  TopicsResolver,
  NewsEventsResolver,
  NewsIndicatorResolver,
  RbacResolver,
  DashboardResolver,
  CrawlResolver,
  EconomicDataResolver,
  EntityImpactGraphResolver,
  KnowledgeGraphResolver,
  KnowledgeGraphImpactResolver,
  KnowledgeGraphReviewResolver,
  AlertsResolver,
  AnalysisResolver,
  AssistantResolver,
  NotificationResolver,
  SettingsResolver,
  SentimentResolver,
  OrgResolver
];

async function main() {
  const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false
  });
  const schemaFactory = app.get(GraphQLSchemaFactory);

  const hasPermissionDirective = new GraphQLDirective({
    name: "hasPermission",
    locations: [DirectiveLocation.FIELD_DEFINITION, DirectiveLocation.OBJECT],
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) }
    }
  });
  const complexityDirective = createComplexityDirective();

  const schema = await schemaFactory.create(resolvers, {
    directives: [hasPermissionDirective, complexityDirective]
  });

  const sorted = lexicographicSortSchema(schema);
  const printed = printSchema(sorted);

  const header = [
    "# ------------------------------------------------------",
    "# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)",
    "# ------------------------------------------------------",
    "",
  ].join("\n");

  const outputPath = join(__dirname, "..", "schema.gql");
  writeFileSync(outputPath, `${header}\n${printed}\n`, "utf8");

  await app.close();
}

void main();

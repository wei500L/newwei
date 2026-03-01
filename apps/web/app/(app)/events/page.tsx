import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { fetchGraphql } from "@/lib/server-graphql";

import type { NewsEventListItem } from "./events-content";
import { EventsContent } from "./events-content";

const NEWS_EVENTS_QUERY = `
  query NewsEvents(
    $limit: Int
    $windowDays: Int
    $status: NewsEventStatus
    $entity: String
    $sourceType: NewsEventSourceType
    $minHeatScore: Float
    $minCredibilityScore: Float
    $sortBy: NewsEventSortBy
  ) {
    newsEvents(
      limit: $limit
      windowDays: $windowDays
      status: $status
      entity: $entity
      sourceType: $sourceType
      minHeatScore: $minHeatScore
      minCredibilityScore: $minCredibilityScore
      sortBy: $sortBy
    ) {
      id
      status
      language
      primaryTopic
      primaryEntity
      title
      summary
      startAt
      lastAt
      itemCount
      breaking
      heatScore
      credibilityScore
      sourceType
      sourceEvidence {
        uniqueSourceCount
        authoritativeSourceCount
        blogSourceCount
        corroborated
      }
      representativeProcessedArticleId
      representativeProcessedItemId
      createdAt
      updatedAt
    }
  }
`;

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_SORT_BY = "latest";
const DEFAULT_SOURCE_TYPE = "all";

const parseNonNegativeFloat = (value: string | string[] | undefined, fallback: number) => {
  if (!value || Array.isArray(value)) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

const parsePositiveInt = (value: string | string[] | undefined, fallback: number) => {
  if (!value || Array.isArray(value)) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

export default async function EventsPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const windowDays = parsePositiveInt(searchParams?.window, DEFAULT_WINDOW_DAYS);
  const limit = parsePositiveInt(searchParams?.limit, DEFAULT_LIMIT);
  const status = typeof searchParams?.status === "string" ? searchParams?.status : undefined;
  const entity =
    typeof searchParams?.entity === "string" ? searchParams.entity.trim().slice(0, 120) : undefined;
  const sortBy = typeof searchParams?.sort === "string" ? searchParams.sort : undefined;
  const sourceType =
    typeof searchParams?.sourceType === "string" ? searchParams.sourceType : undefined;
  const minHeatScore = parseNonNegativeFloat(searchParams?.minHeat, 0);
  const minCredibilityScore = parseNonNegativeFloat(searchParams?.minCredibility, 0);

  const initialData = await fetchGraphql<{
    newsEvents: NewsEventListItem[];
  }>({
    query: NEWS_EVENTS_QUERY,
    variables: {
      limit,
      windowDays,
      status: status && ["active", "archived"].includes(status) ? status : undefined,
      entity: entity && entity.length > 0 ? entity : undefined,
      sourceType:
        sourceType && ["authoritative", "mixed", "blog", "unknown"].includes(sourceType)
          ? sourceType
          : undefined,
      minHeatScore: minHeatScore > 0 ? minHeatScore : undefined,
      minCredibilityScore: minCredibilityScore > 0 ? minCredibilityScore : undefined,
      sortBy:
        sortBy && ["latest", "heat", "credibility"].includes(sortBy)
          ? sortBy === DEFAULT_SORT_BY
            ? undefined
            : sortBy
          : undefined
    },
    accessToken: session.accessToken
  });

  return <EventsContent initialData={initialData ?? null} />;
}

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { fetchGraphql } from "@/lib/server-graphql";

import type { NewsEventListItem } from "./events-content";
import { EventsContent } from "./events-content";

const NEWS_EVENTS_QUERY = `
  query NewsEvents($limit: Int, $windowDays: Int, $status: NewsEventStatus) {
    newsEvents(limit: $limit, windowDays: $windowDays, status: $status) {
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
      representativeProcessedArticleId
      representativeProcessedItemId
      createdAt
      updatedAt
    }
  }
`;

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_DAYS = 30;

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

  const initialData = await fetchGraphql<{
    newsEvents: NewsEventListItem[];
  }>({
    query: NEWS_EVENTS_QUERY,
    variables: {
      limit,
      windowDays,
      status: status && ["active", "archived"].includes(status) ? status : undefined
    },
    accessToken: session.accessToken
  });

  return <EventsContent initialData={initialData ?? null} />;
}


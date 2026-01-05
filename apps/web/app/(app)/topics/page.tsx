import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { fetchGraphql } from '@/lib/server-graphql';

import type { EventGroup, TopicGroup } from './topics-content';
import { TopicsContent } from './topics-content';

const TOPIC_GROUPS_QUERY = `
  query TopicGroups(
    $limit: Int
    $itemsPerGroup: Int
    $windowDays: Int
    $eventLimit: Int
    $eventItemsPerGroup: Int
    $eventWindowDays: Int
    $eventMinGroupSize: Int
  ) {
    topicGroups(limit: $limit, itemsPerGroup: $itemsPerGroup, windowDays: $windowDays) {
      topic
      count
      latestAt
      items {
        id
        itemMetaId
        title
        summary
        source
        publishedAt
        createdAt
      }
    }
    eventGroups(
      limit: $eventLimit
      itemsPerGroup: $eventItemsPerGroup
      windowDays: $eventWindowDays
      minGroupSize: $eventMinGroupSize
    ) {
      eventId
      count
      latestAt
      title
      summary
      source
      publishedAt
      topics
      entities
      items {
        id
        itemMetaId
        title
        summary
        source
        publishedAt
        createdAt
      }
    }
  }
`;

const DEFAULT_LIMIT = 12;
const DEFAULT_ITEMS_PER_GROUP = 4;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_EVENT_LIMIT = 8;
const DEFAULT_EVENT_ITEMS_PER_GROUP = 4;
const DEFAULT_EVENT_MIN_GROUP_SIZE = 2;

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

export default async function TopicsPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const windowDays = parsePositiveInt(searchParams?.window, DEFAULT_WINDOW_DAYS);
  const minGroupSize = parsePositiveInt(searchParams?.minGroup, DEFAULT_EVENT_MIN_GROUP_SIZE);

  const initialData = await fetchGraphql<{
    topicGroups: TopicGroup[];
    eventGroups: EventGroup[];
  }>({
    query: TOPIC_GROUPS_QUERY,
    variables: {
      limit: DEFAULT_LIMIT,
      itemsPerGroup: DEFAULT_ITEMS_PER_GROUP,
      windowDays,
      eventLimit: DEFAULT_EVENT_LIMIT,
      eventItemsPerGroup: DEFAULT_EVENT_ITEMS_PER_GROUP,
      eventWindowDays: windowDays,
      eventMinGroupSize: minGroupSize
    },
    accessToken: session.accessToken
  });

  return <TopicsContent initialData={initialData ?? null} />;
}

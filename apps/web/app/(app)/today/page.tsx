import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import type { ItemsQuery } from "@/graphql/generated";
import { fetchGraphql } from "@/lib/server-graphql";
import { TodayContent } from "./today-content";

const ITEMS_QUERY = `
  query Items($first: Int!, $after: String, $search: String, $filters: ItemsFiltersInput) {
    items(first: $first, after: $after, search: $search, filters: $filters) {
      edges {
        node {
          id
          title
          status
          createdAt
          processed {
            result
            tags
            duplicateOf
            duplicateSimilarity
            llm {
              model
              promptVersion
              promptTokens
              completionTokens
              totalTokens
              costUsd
              latencyMs
            }
          }
          raw {
            payload
            source
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      totalCount
    }
  }
`;

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

export default async function TodayPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const current = parsePositiveInt(searchParams?.page, 1);
  const pageSize = parsePositiveInt(searchParams?.pageSize, 10);
  const search = typeof searchParams?.q === "string" ? searchParams.q.trim() : "";

  let accumulatedEdges: ItemsQuery["items"]["edges"] = [];
  let endCursor: string | null = null;
  let hasNextPage = false;
  let totalCount = 0;

  while (accumulatedEdges.length < current * pageSize) {
    const data = await fetchGraphql<ItemsQuery>({
      query: ITEMS_QUERY,
      variables: {
        first: pageSize,
        after: endCursor,
        search: search || null,
        filters: null
      },
      accessToken: session.accessToken
    });

    const items = data?.items;
    if (!items) {
      break;
    }

    accumulatedEdges = [...accumulatedEdges, ...items.edges];
    endCursor = items.pageInfo.endCursor ?? null;
    hasNextPage = items.pageInfo.hasNextPage;
    totalCount = items.totalCount ?? totalCount;

    if (!hasNextPage || !endCursor) {
      break;
    }
  }

  const initialData: ItemsQuery | null =
    accumulatedEdges.length > 0
      ? {
          items: {
            edges: accumulatedEdges,
            pageInfo: {
              hasNextPage,
              endCursor
            },
            totalCount
          }
        }
      : null;

  return <TodayContent initialData={initialData} />;
}

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import type { ItemsQuery } from "@/graphql/generated";
import { fetchGraphql } from "@/lib/server-graphql";
import { TodayContent } from "./today-content";

const ITEMS_QUERY = `
  query Items($first: Int!, $after: String, $page: Int, $search: String, $filters: ItemsFiltersInput, $orderBy: ItemsOrderBy) {
    items(first: $first, after: $after, page: $page, search: $search, filters: $filters, orderBy: $orderBy) {
      edges {
        node {
          id
          title
          status
          createdAt
          ingestedAt
          publishedAt
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
  const pageSize = Math.min(parsePositiveInt(searchParams?.pageSize, 10), 50);
  const search = typeof searchParams?.q === "string" ? searchParams.q.trim() : "";

  const data = await fetchGraphql<ItemsQuery>({
    query: ITEMS_QUERY,
    variables: {
      first: pageSize,
      after: null,
      page: current,
      search: search || null,
      filters: null,
      orderBy: "PUBLISHED_DESC"
    },
    accessToken: session.accessToken
  });

  const initialData = data?.items ? data : null;

  return <TodayContent initialData={initialData} />;
}

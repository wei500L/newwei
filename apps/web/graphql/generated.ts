/* eslint-disable */
import { gql } from "@apollo/client";
import * as Apollo from "@apollo/client";

export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
const defaultOptions = {} as const;

export type MeQueryVariables = Exact<{ [key: string]: never }>;

export type MeQuery = {
  me: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    orgId: string;
    permissions: Array<string>;
  };
};

export type ItemsQueryVariables = Exact<{
  first: number;
  after?: InputMaybe<string>;
  search?: InputMaybe<string>;
}>;

export type ItemsQuery = {
  items: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    edges: Array<{ cursor: string; node: { id: string; title: string; status: string; createdAt: any } }>;
  };
};

export type QueueStatsQueryVariables = Exact<{ [key: string]: never }>;

export type QueueStatsQuery = {
  queueStats: {
    processedCount: number;
    itemCount: number;
    counts: { waiting: number; active: number; completed: number; failed: number; delayed: number };
    recentLogs: Array<{ event: string; jobId: string; data?: string | null; timestamp: string }>;
  };
};

export const MeDocument = gql`
  query Me {
    me {
      id
      email
      firstName
      lastName
      orgId
      permissions
    }
  }
`;

export function useMeQuery(baseOptions?: Apollo.QueryHookOptions<MeQuery, MeQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<MeQuery, MeQueryVariables>(MeDocument, options);
}

export function useMeLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<MeQuery, MeQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<MeQuery, MeQueryVariables>(MeDocument, options);
}

export type MeQueryHookResult = ReturnType<typeof useMeQuery>;
export type MeLazyQueryHookResult = ReturnType<typeof useMeLazyQuery>;
export type MeQueryResult = Apollo.QueryResult<MeQuery, MeQueryVariables>;
export const ItemsDocument = gql`
  query Items($first: Int!, $after: String, $search: String) {
    items(first: $first, after: $after, search: $search) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          title
          status
          createdAt
        }
      }
    }
  }
`;

export function useItemsQuery(baseOptions: Apollo.QueryHookOptions<ItemsQuery, ItemsQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
}

export function useItemsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<ItemsQuery, ItemsQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
}

export type ItemsQueryHookResult = ReturnType<typeof useItemsQuery>;
export type ItemsLazyQueryHookResult = ReturnType<typeof useItemsLazyQuery>;
export type ItemsQueryResult = Apollo.QueryResult<ItemsQuery, ItemsQueryVariables>;
export const QueueStatsDocument = gql`
  query QueueStats {
    queueStats {
      counts {
        waiting
        active
        completed
        failed
        delayed
      }
      processedCount
      itemCount
      recentLogs {
        event
        jobId
        data
        timestamp
      }
    }
  }
`;

export function useQueueStatsQuery(
  baseOptions?: Apollo.QueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
}

export function useQueueStatsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
}
export type QueueStatsQueryHookResult = ReturnType<typeof useQueueStatsQuery>;
export type QueueStatsLazyQueryHookResult = ReturnType<typeof useQueueStatsLazyQuery>;
export type QueueStatsQueryResult = Apollo.QueryResult<QueueStatsQuery, QueueStatsQueryVariables>;
export type RbacOverviewQueryVariables = Exact<{ [key: string]: never }>;

export type RbacOverviewQuery = {
  roles: Array<{
    id: string;
    name: string;
    description?: string | null;
    permissions: Array<{ id: string; name: string; description?: string | null }>;
  }>;
  permissions: Array<{ id: string; name: string; description?: string | null }>;
  memberships: Array<{
    id: string;
    orgId: string;
    role: { id: string; name: string };
    user: { id: string; email: string; firstName: string; lastName: string };
  }>;
};

export const RbacOverviewDocument = gql`
  query RbacOverview {
    roles {
      id
      name
      description
      permissions {
        id
        name
        description
      }
    }
    permissions {
      id
      name
      description
    }
    memberships {
      id
      orgId
      role {
        id
        name
      }
      user {
        id
        email
        firstName
        lastName
      }
    }
  }
`;

export function useRbacOverviewQuery(
  baseOptions?: Apollo.QueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
}

export function useRbacOverviewLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
}

export type RbacOverviewQueryHookResult = ReturnType<typeof useRbacOverviewQuery>;
export type RbacOverviewLazyQueryHookResult = ReturnType<typeof useRbacOverviewLazyQuery>;
export type RbacOverviewQueryResult = Apollo.QueryResult<RbacOverviewQuery, RbacOverviewQueryVariables>;

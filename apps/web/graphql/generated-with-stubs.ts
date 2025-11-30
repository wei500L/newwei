import {
  gql,
  useMutation,
  useQuery,
  useSubscription,
  type MutationHookOptions,
  type QueryHookOptions,
  type SubscriptionHookOptions,
} from "@apollo/client";
import type { DocumentNode } from "graphql";

export * from "./generated";

// Shared enums and types that align with the API schema
export const TimeGranularity = {
  year: "year",
  quarter: "quarter",
  month: "month",
  week: "week",
  day: "day",
} as const;

export type TimeGranularity =
  (typeof TimeGranularity)[keyof typeof TimeGranularity];

export type AnalysisType = "correlation" | "anomaly";
export type AnalysisStatus = "pending" | "running" | "completed" | "failed";

export interface AnalysisResult {
  id: string;
  type: AnalysisType;
  status: AnalysisStatus;
  summary?: string | null;
  createdAt: string;
}

export interface AnalysisResultsQuery {
  analysisResults: AnalysisResult[];
}

export interface AnalysisResultsQueryVariables {
  limit?: number | null;
}

export interface AnalysisEventsSubscriptionResult {
  analysisEvents: AnalysisResult;
}

export type CorrelationAnalysisInput = {
  indicatorName: string;
  value: number;
  changePercent: number;
  startDate: string;
  endDate: string;
  newsSummaries: string[];
};

export type AnomalyAnalysisInput = {
  metric: string;
  timestamp: string;
  value: number;
  deviationPercent: number;
  newsList: string[];
  policyList: string[];
};

const AnalysisResultsDocument = gql`
  query AnalysisResults($limit: Int) {
    analysisResults(limit: $limit) {
      id
      type
      status
      summary
      createdAt
    }
  }
`;

export const AnalysisEventsDocument: DocumentNode = gql`
  subscription AnalysisEvents {
    analysisEvents {
      id
      type
      status
      summary
      createdAt
    }
  }
`;

const RequestCorrelationDocument = gql`
  mutation RequestCorrelation($input: CorrelationAnalysisInput!) {
    requestCorrelationAnalysis(input: $input) {
      id
      status
      type
    }
  }
`;

const RequestAnomalyDocument = gql`
  mutation RequestAnomaly($input: AnomalyAnalysisInput!) {
    requestAnomalyExplanation(input: $input) {
      id
      status
      type
    }
  }
`;

export function useAnalysisResultsQuery(
  options?: QueryHookOptions<
    AnalysisResultsQuery,
    AnalysisResultsQueryVariables
  >,
) {
  return useQuery(AnalysisResultsDocument, options as any);
}

export function useAnalysisEventsSubscription(
  options?: SubscriptionHookOptions<
    AnalysisEventsSubscriptionResult,
    Record<string, never>
  >,
) {
  return useSubscription<AnalysisEventsSubscriptionResult>(
    AnalysisEventsDocument,
    options as any,
  );
}

export function useRequestAnomalyMutation(
  options?: MutationHookOptions<
    { requestAnomalyExplanation: AnalysisResult },
    { input: AnomalyAnalysisInput }
  >,
) {
  return useMutation(RequestAnomalyDocument, options as any);
}

export function useRequestCorrelationMutation(
  options?: MutationHookOptions<
    { requestCorrelationAnalysis: AnalysisResult },
    { input: CorrelationAnalysisInput }
  >,
) {
  return useMutation(RequestCorrelationDocument, options as any);
}

// Dashboards + queue stats
export type DashboardWidget = {
  id?: string;
  title?: string | null;
  type: string;
  dataSource: string;
  dataConfig?: Record<string, unknown> | null;
  layoutX: number;
  layoutY: number;
  layoutW: number;
  layoutH: number;
  sortOrder?: number | null;
  options?: Record<string, unknown> | null;
};

export type Dashboard = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  theme?: string | null;
  config?: Record<string, unknown> | null;
  widgets: DashboardWidget[];
};

export interface DashboardsQuery {
  dashboards: Dashboard[];
}

export interface UpsertDashboardInput {
  id?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  theme?: string | null;
  config?: Record<string, unknown> | null;
  widgets: DashboardWidget[];
}

export const DashboardsDocument = gql`
  query Dashboards {
    dashboards {
      id
      name
      slug
      description
      theme
      config
      widgets {
        id
        title
        type
        dataSource
        dataConfig
        layoutX
        layoutY
        layoutW
        layoutH
        sortOrder
        options
      }
    }
  }
`;

const UpsertDashboardDocument = gql`
  mutation UpsertDashboard($input: UpsertDashboardInput!) {
    upsertDashboard(input: $input) {
      id
      name
      slug
    }
  }
`;

const DeleteDashboardDocument = gql`
  mutation DeleteDashboard($id: String!) {
    deleteDashboard(id: $id)
  }
`;

export function useDashboardsQuery(
  options?: QueryHookOptions<DashboardsQuery, Record<string, never>>,
) {
  return useQuery(DashboardsDocument, options as any);
}

export function useUpsertDashboardMutation(
  options?: MutationHookOptions<
    { upsertDashboard: { id: string; name: string; slug: string } },
    { input: UpsertDashboardInput }
  >,
) {
  return useMutation(UpsertDashboardDocument, options as any);
}

export function useDeleteDashboardMutation(
  options?: MutationHookOptions<{ deleteDashboard: boolean }, { id: string }>,
) {
  return useMutation(DeleteDashboardDocument, options as any);
}

export type QueueEvent = {
  event: string;
  jobId: string;
  data?: string | null;
  timestamp: string;
};
export type QueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
};
export interface QueueStatsQuery {
  queueStats: {
    counts: QueueCounts;
    processedCount: number;
    itemCount: number;
    recentLogs: QueueEvent[];
  };
}

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
  options?: QueryHookOptions<QueueStatsQuery, Record<string, never>>,
) {
  return useQuery(QueueStatsDocument, options as any);
}

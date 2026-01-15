import { useMemo } from "react";

import {
  useGetEntityImpactGraphQuery,
  type EntityImpactNodeModel,
  type EntityImpactLinkModel,
  type EntityImpactMetadataModel
} from "@/graphql/generated";
import { useDashboardRangeStore } from "@/store/time-range";

/**
 * Options for configuring the entity impact graph query
 */
export interface EntityImpactGraphOptions {
  /** Minimum confidence threshold for entities (0-1), defaults to 0.5 */
  minConfidence?: number;
  /** Minimum absolute correlation threshold (0-1), defaults to 0.3 */
  minCorrelation?: number;
  /** Minimum co-occurrence count between entities, defaults to 2 */
  minCoOccurrence?: number;
  /** Restrict graph to categories (person, organization, stock, commodity) */
  categories?: string[];
  /** Maximum number of nodes to return, defaults to 100 */
  maxNodes?: number;
  /** Poll interval in milliseconds for auto-refresh */
  pollInterval?: number;
  /** Skip the query execution */
  skip?: boolean;
}

/**
 * Node in the entity impact graph
 */
export interface EntityImpactNode {
  id: string;
  name: string;
  category: string;
  type: string;
  value: number;
}

/**
 * Link/edge in the entity impact graph
 */
export interface EntityImpactLink {
  source: string;
  target: string;
  value: number;
  type: string;
}

/**
 * Metadata about the entity impact graph
 */
export interface EntityImpactMetadata {
  totalNodes: number;
  totalLinks: number;
  generatedAt: Date;
}

/**
 * Complete entity impact graph data structure
 */
export interface EntityImpactGraphData {
  nodes: EntityImpactNode[];
  links: EntityImpactLink[];
  metadata: EntityImpactMetadata | null;
  loading: boolean;
  error: Error | undefined;
}

/**
 * Result returned by the useEntityImpactGraph hook
 */
export interface EntityImpactGraphResult extends EntityImpactGraphData {
  refetch: () => void;
  hasData: boolean;
}

/**
 * Transform GraphQL node model to local node type
 */
function transformNode(node: EntityImpactNodeModel): EntityImpactNode {
  return {
    id: node.id,
    name: node.name,
    category: node.category,
    type: node.type,
    value: node.value
  };
}

/**
 * Transform GraphQL link model to local link type
 */
function transformLink(link: EntityImpactLinkModel): EntityImpactLink {
  return {
    source: link.source,
    target: link.target,
    value: link.value,
    type: link.type
  };
}

/**
 * Transform GraphQL metadata model to local metadata type
 */
function transformMetadata(metadata: EntityImpactMetadataModel): EntityImpactMetadata {
  return {
    totalNodes: metadata.totalNodes,
    totalLinks: metadata.totalLinks,
    generatedAt: new Date(metadata.generatedAt)
  };
}

/**
 * Hook for fetching and managing entity impact graph data
 *
 * Integrates with dashboard range store for date filtering and provides
 * transformed graph data suitable for ECharts visualization.
 *
 * @param options - Configuration options for the graph query
 * @returns Entity impact graph data with loading/error states
 *
 * @example
 * ```tsx
 * const { nodes, links, metadata, loading, error } = useEntityImpactGraph({
 *   minConfidence: 0.7,
 *   maxNodes: 50
 * });
 * ```
 */
export function useEntityImpactGraph(options: EntityImpactGraphOptions = {}): EntityImpactGraphResult {
  const { minConfidence, minCorrelation, minCoOccurrence, maxNodes, categories, pollInterval, skip } = options;
  const { start, end } = useDashboardRangeStore();

  const { data, loading, error, refetch } = useGetEntityImpactGraphQuery({
    variables: {
      input: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        minConfidence,
        minCorrelation,
        minCoOccurrence,
        maxNodes,
        categories
      }
    },
    pollInterval,
    skip
  });

  const graphData = data?.getEntityImpactGraph;

  const nodes: EntityImpactNode[] = useMemo(() => {
    if (!graphData?.nodes) {
      return [];
    }
    return graphData.nodes.map(transformNode);
  }, [graphData?.nodes]);

  const links: EntityImpactLink[] = useMemo(() => {
    if (!graphData?.links) {
      return [];
    }
    return graphData.links.map(transformLink);
  }, [graphData?.links]);

  const metadata: EntityImpactMetadata | null = useMemo(() => {
    if (!graphData?.metadata) {
      return null;
    }
    return transformMetadata(graphData.metadata);
  }, [graphData?.metadata]);

  const hasData = nodes.length > 0;

  return {
    nodes,
    links,
    metadata,
    loading,
    error,
    refetch,
    hasData
  };
}

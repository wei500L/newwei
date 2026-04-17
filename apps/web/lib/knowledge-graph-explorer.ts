import type { ReadonlyURLSearchParams } from "next/navigation";

const KNOWLEDGE_GRAPH_NODE_TYPES = [
  "company",
  "industry",
  "person",
  "policy",
  "commodity",
  "instrument",
  "organization"
] as const;

export const KNOWLEDGE_GRAPH_RELATION_TYPES = [
  "belongs_to_industry",
  "supplies",
  "customer_of",
  "competes_with",
  "holds_position",
  "affects_industry",
  "affects_company",
  "upstream_of",
  "downstream_of",
  "has_ticker"
] as const;

export const KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH = 2;
export const KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES = 200;
export const KNOWLEDGE_GRAPH_MIN_DEPTH = 1;
export const KNOWLEDGE_GRAPH_MAX_DEPTH = 5;
export const KNOWLEDGE_GRAPH_MIN_NODES = 50;
export const KNOWLEDGE_GRAPH_MAX_NODES = 500;
export const KNOWLEDGE_GRAPH_DEFAULT_EVIDENCE_LIMIT = 12;

export type KnowledgeGraphSeedType = (typeof KNOWLEDGE_GRAPH_NODE_TYPES)[number];
export type KnowledgeGraphRelationType = (typeof KNOWLEDGE_GRAPH_RELATION_TYPES)[number];

export interface KnowledgeGraphExplorerRouteState {
  seedName: string;
  seedType?: KnowledgeGraphSeedType;
  maxDepth: number;
  maxNodes: number;
  relationTypes: KnowledgeGraphRelationType[];
}

function clampInteger(value: string | null, minimum: number, maximum: number, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeSeedType(value: string | null): KnowledgeGraphSeedType | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return KNOWLEDGE_GRAPH_NODE_TYPES.find((entry) => entry === normalized);
}

export function normalizeKnowledgeGraphRelationTypes(
  values: readonly string[] | null | undefined
): KnowledgeGraphRelationType[] {
  if (!values || values.length === 0) {
    return [];
  }
  const allowed = new Set<string>(KNOWLEDGE_GRAPH_RELATION_TYPES);
  return Array.from(
    new Set(
      values
        .flatMap((entry) => entry.split(","))
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry): entry is KnowledgeGraphRelationType => allowed.has(entry))
    )
  );
}

export function parseKnowledgeGraphExplorerParams(
  searchParams: URLSearchParams | ReadonlyURLSearchParams
): KnowledgeGraphExplorerRouteState {
  const relationParam = searchParams.getAll("relations");
  const seedName = searchParams.get("seed")?.trim() ?? "";

  return {
    seedName,
    seedType: normalizeSeedType(searchParams.get("seedType")),
    maxDepth: clampInteger(
      searchParams.get("depth"),
      KNOWLEDGE_GRAPH_MIN_DEPTH,
      KNOWLEDGE_GRAPH_MAX_DEPTH,
      KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH
    ),
    maxNodes: clampInteger(
      searchParams.get("maxNodes"),
      KNOWLEDGE_GRAPH_MIN_NODES,
      KNOWLEDGE_GRAPH_MAX_NODES,
      KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES
    ),
    relationTypes: normalizeKnowledgeGraphRelationTypes(relationParam)
  };
}

export function buildKnowledgeGraphExplorerHref(
  input: Partial<KnowledgeGraphExplorerRouteState> = {}
): string {
  const params = new URLSearchParams();
  const seedName = input.seedName?.trim() ?? "";
  const seedType = input.seedType;
  const maxDepth = input.maxDepth ?? KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH;
  const maxNodes = input.maxNodes ?? KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES;
  const relationTypes = normalizeKnowledgeGraphRelationTypes(input.relationTypes);

  if (seedName) {
    params.set("seed", seedName);
  }
  if (seedType) {
    params.set("seedType", seedType);
  }
  if (maxDepth !== KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH) {
    params.set("depth", String(maxDepth));
  }
  if (maxNodes !== KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES) {
    params.set("maxNodes", String(maxNodes));
  }
  if (relationTypes.length > 0) {
    params.set("relations", relationTypes.join(","));
  }

  const query = params.toString();
  return query ? `/knowledge-graph?${query}` : "/knowledge-graph";
}

export function formatKnowledgeGraphLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

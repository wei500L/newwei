export type EntityGraphLabelDensity = "compact" | "standard";
export type EntityGraphEdgeType = "coOccurrence" | "correlation";

export interface EntityGraphNodeLike {
  id: string;
  category: string;
  value: number;
}

export interface EntityGraphLinkLike {
  source: string;
  target: string;
  type: string;
  value: number;
}

export interface EntityGraphLinkResolutionInput {
  nodeIds: Set<string>;
  nodeIdByNormalizedName: Map<string, string>;
}

export interface EntityGraphForceConfig {
  repulsion: number;
  gravity: number;
  edgeLength: [number, number];
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const ENTITY_GRAPH_DEFAULT_CATEGORIES = [
  "person",
  "organization",
  "stock",
  "commodity",
];

export function normalizeEntityGraphCategory(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeEntityGraphEdgeType(
  value: string,
): EntityGraphEdgeType {
  const normalized = value.trim().toLowerCase();
  return normalized === "correlation" ? "correlation" : "coOccurrence";
}

export function resolveEntityGraphForce(
  nodeCount: number,
): EntityGraphForceConfig {
  if (nodeCount <= 25) {
    return { repulsion: 460, gravity: 0.08, edgeLength: [72, 170] };
  }
  if (nodeCount <= 60) {
    return { repulsion: 620, gravity: 0.1, edgeLength: [84, 220] };
  }
  if (nodeCount <= 110) {
    return { repulsion: 780, gravity: 0.12, edgeLength: [96, 260] };
  }
  return { repulsion: 920, gravity: 0.14, edgeLength: [110, 300] };
}

export function resolveEntityGraphNodeSize(
  value: number,
  selected = false,
): number {
  const base = clamp(16 + Math.sqrt(Math.max(0, value)) * 5.5, 18, 52);
  if (!selected) {
    return base;
  }
  return clamp(base * 1.15, 20, 60);
}

export function buildEntityGraphConnectionMap<
  T extends { source: string; target: string },
>(links: T[]): Map<string, string[]> {
  const connectionMap = new Map<string, string[]>();

  for (const link of links) {
    const sourceConnections = connectionMap.get(link.source) ?? [];
    if (!sourceConnections.includes(link.target)) {
      sourceConnections.push(link.target);
    }
    connectionMap.set(link.source, sourceConnections);

    const targetConnections = connectionMap.get(link.target) ?? [];
    if (!targetConnections.includes(link.source)) {
      targetConnections.push(link.source);
    }
    connectionMap.set(link.target, targetConnections);
  }

  return connectionMap;
}

export function selectEntityGraphLabelNodeIds<T extends EntityGraphNodeLike>(
  nodes: T[],
  density: EntityGraphLabelDensity,
  selectedNodeId: string | null,
  connectionMap: Map<string, string[]>,
): Set<string> {
  const limit = density === "compact" ? 8 : 14;
  const topNodes = [...nodes].sort(
    (a, b) => b.value - a.value || a.id.localeCompare(b.id),
  );
  const labelNodeIds = new Set(topNodes.slice(0, limit).map((node) => node.id));

  if (selectedNodeId) {
    labelNodeIds.add(selectedNodeId);
    for (const connectedId of connectionMap.get(selectedNodeId) ?? []) {
      labelNodeIds.add(connectedId);
    }
  }

  return labelNodeIds;
}

export function filterEntityGraphData<
  TNode extends EntityGraphNodeLike,
  TLink extends EntityGraphLinkLike,
>(
  nodes: TNode[],
  links: TLink[],
  selectedCategories: string[],
  selectedEdgeTypes: EntityGraphEdgeType[],
): { nodes: TNode[]; links: TLink[] } {
  const categorySet = new Set(
    selectedCategories.map(normalizeEntityGraphCategory),
  );
  const edgeTypeSet = new Set(selectedEdgeTypes);

  const categoryNodes = nodes.filter((node) =>
    categorySet.has(normalizeEntityGraphCategory(node.category)),
  );
  if (categoryNodes.length === 0) {
    return { nodes: [], links: [] };
  }

  const categoryNodeIds = new Set(categoryNodes.map((node) => node.id));
  const filteredLinks = links.filter((link) => {
    if (
      !categoryNodeIds.has(link.source) ||
      !categoryNodeIds.has(link.target)
    ) {
      return false;
    }
    return edgeTypeSet.has(normalizeEntityGraphEdgeType(link.type));
  });

  if (filteredLinks.length === 0) {
    return { nodes: categoryNodes, links: [] };
  }

  const activeNodeIds = new Set<string>();
  for (const link of filteredLinks) {
    activeNodeIds.add(link.source);
    activeNodeIds.add(link.target);
  }

  return {
    nodes: categoryNodes.filter((node) => activeNodeIds.has(node.id)),
    links: filteredLinks,
  };
}

export function sanitizeEntityGraphLinks<TLink extends EntityGraphLinkLike>(
  links: TLink[],
  input: EntityGraphLinkResolutionInput,
): TLink[] {
  const dedupe = new Map<string, number>();
  const sanitized: TLink[] = [];

  for (const link of links) {
    const sourceRaw = String(link.source ?? "").trim();
    const targetRaw = String(link.target ?? "").trim();
    if (!sourceRaw || !targetRaw) {
      continue;
    }

    const sourceId = input.nodeIds.has(sourceRaw)
      ? sourceRaw
      : (input.nodeIdByNormalizedName.get(sourceRaw.toLowerCase()) ?? null);
    const targetId = input.nodeIds.has(targetRaw)
      ? targetRaw
      : (input.nodeIdByNormalizedName.get(targetRaw.toLowerCase()) ?? null);

    if (!sourceId || !targetId || sourceId === targetId) {
      continue;
    }
    if (!input.nodeIds.has(sourceId) || !input.nodeIds.has(targetId)) {
      continue;
    }

    const edgeType = normalizeEntityGraphEdgeType(link.type);
    const edgeValue = Number(link.value);
    if (!Number.isFinite(edgeValue) || edgeValue <= 0) {
      continue;
    }

    const normalizedSource = sourceId < targetId ? sourceId : targetId;
    const normalizedTarget = sourceId < targetId ? targetId : sourceId;
    const edgeKey = `${normalizedSource}|${normalizedTarget}|${edgeType}`;
    const normalizedLink = {
      ...link,
      source: normalizedSource,
      target: normalizedTarget,
      value: edgeValue,
    };

    const existingIndex = dedupe.get(edgeKey);
    if (existingIndex === undefined) {
      dedupe.set(edgeKey, sanitized.length);
      sanitized.push(normalizedLink);
      continue;
    }

    if (edgeValue > sanitized[existingIndex]!.value) {
      sanitized[existingIndex] = normalizedLink;
    }
  }

  return sanitized;
}

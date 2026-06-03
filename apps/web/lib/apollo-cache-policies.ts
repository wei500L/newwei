import { InMemoryCache, type Reference } from "@apollo/client";

interface ItemConnectionLike {
  __typename?: string;
  edges?: unknown[];
  pageInfo?: unknown;
  totalCount?: number | null;
  pageInfoByPage?: Record<string, unknown>;
}

type ReadField = (fieldName: string, value: unknown) => unknown;

const toPositiveInt = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
};

const toPageNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null;
};

const defaultReadField: ReadField = (fieldName, value) => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[fieldName];
};

export function mergeItemsConnection(
  existing: ItemConnectionLike | undefined,
  incoming: ItemConnectionLike,
  args: Record<string, unknown> | null | undefined,
): ItemConnectionLike {
  const incomingEdges = incoming.edges ?? [];
  const first = toPositiveInt(args?.first) ?? incomingEdges.length;
  const page = toPageNumber(args?.page);
  const after = typeof args?.after === "string" ? args.after : null;
  const edges = existing?.edges ? existing.edges.slice() : [];
  const pageInfoByPage = { ...(existing?.pageInfoByPage ?? {}) };

  if (page) {
    const offset = (page - 1) * first;
    incomingEdges.forEach((edge, index) => {
      edges[offset + index] = edge;
    });
    pageInfoByPage[String(page)] = incoming.pageInfo;
  } else if (after) {
    const afterIndex = edges.findIndex((edge) => {
      return defaultReadField("cursor", edge) === after;
    });
    const offset = afterIndex >= 0 ? afterIndex + 1 : edges.length;
    incomingEdges.forEach((edge, index) => {
      edges[offset + index] = edge;
    });
  } else {
    return {
      ...incoming,
      edges: incomingEdges.slice(),
      pageInfoByPage,
    };
  }

  return {
    ...incoming,
    edges,
    pageInfoByPage,
  };
}

export function readItemsConnection(
  existing: ItemConnectionLike | undefined,
  args: Record<string, unknown> | null | undefined,
): ItemConnectionLike | undefined {
  if (!existing) {
    return undefined;
  }

  const first = toPositiveInt(args?.first);
  const page = toPageNumber(args?.page);
  if (!first || !page) {
    return existing;
  }

  const offset = (page - 1) * first;
  const totalCount =
    typeof existing.totalCount === "number" && Number.isFinite(existing.totalCount)
      ? existing.totalCount
      : null;
  const expected =
    totalCount === null ? first : Math.min(first, Math.max(totalCount - offset, 0));
  const slice = (existing.edges ?? []).slice(offset, offset + expected);

  if (slice.length < expected || slice.some((edge) => typeof edge === "undefined")) {
    return undefined;
  }

  return {
    ...existing,
    edges: slice,
    pageInfo: existing.pageInfoByPage?.[String(page)] ?? existing.pageInfo,
  };
}

function readEventId(event: unknown, readField: ReadField): string | null {
  const id = readField("id", event);
  return typeof id === "string" && id.trim() ? id : null;
}

function readTriggeredAt(event: unknown, readField: ReadField): number {
  const value = readField("triggeredAt", event);
  const timestamp =
    typeof value === "string" || typeof value === "number"
      ? new Date(value).getTime()
      : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeAlertEventLists(
  existing: readonly unknown[] | undefined,
  incoming: readonly unknown[],
  readField: ReadField = defaultReadField,
): unknown[] {
  const byId = new Map<string, unknown>();
  for (const event of existing ?? []) {
    const id = readEventId(event, readField);
    if (id) {
      byId.set(id, event);
    }
  }
  for (const event of incoming) {
    const id = readEventId(event, readField);
    if (id) {
      byId.set(id, event);
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => readTriggeredAt(b, readField) - readTriggeredAt(a, readField),
  );
}

export function readAlertEventList(
  existing: readonly unknown[] | undefined,
  args: Record<string, unknown> | null | undefined,
): readonly unknown[] | undefined {
  if (!existing) {
    return undefined;
  }
  const limit = toPositiveInt(args?.limit);
  if (!limit) {
    return existing;
  }
  if (existing.length < limit) {
    return undefined;
  }
  return existing.slice(0, limit);
}

export function createApolloCache(): InMemoryCache {
  return new InMemoryCache({
    typePolicies: {
      AlertDeliveryModel: {
        keyFields: ["id"],
      },
      AlertEventModel: {
        keyFields: ["id"],
      },
      ItemEdge: {
        keyFields: false,
      },
      ItemModel: {
        keyFields: ["id"],
      },
      Query: {
        fields: {
          alertEvents: {
            keyArgs: ["metricSlug"],
            merge(existing: readonly Reference[] | undefined, incoming: readonly Reference[], options) {
              const merged = mergeAlertEventLists(
                existing,
                incoming,
                options.readField as ReadField,
              );
              const limit = toPositiveInt(options.args?.limit);
              const keep = Math.max(limit ?? 0, existing?.length ?? 0, incoming.length);
              return keep > 0 ? merged.slice(0, keep) : merged;
            },
            read(existing: readonly Reference[] | undefined, options) {
              return readAlertEventList(existing, options.args);
            },
          },
          items: {
            keyArgs: ["search", "filters", "orderBy", "rankingMode"],
            merge(existing: ItemConnectionLike | undefined, incoming: ItemConnectionLike, options) {
              return mergeItemsConnection(existing, incoming, options.args);
            },
            read(existing: ItemConnectionLike | undefined, options) {
              return readItemsConnection(existing, options.args);
            },
          },
        },
      },
    },
  });
}

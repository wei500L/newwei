import type { GraphQLResolveInfo } from "graphql";

export type CacheableResolveInfo = GraphQLResolveInfo & {
  cacheControl?: {
    setCacheHint(hint: { maxAge: number; scope: "PRIVATE" }): void;
  };
};

export function getGraphqlResponseCacheMaxAgeSeconds(): number {
  const parsed = Number.parseInt(
    process.env.GRAPHQL_RESPONSE_CACHE_MAX_AGE_SECONDS ?? "30",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export function setPrivateResponseCacheHint(
  info: CacheableResolveInfo | undefined,
  maxAgeSeconds = getGraphqlResponseCacheMaxAgeSeconds(),
) {
  info?.cacheControl?.setCacheHint({
    maxAge: Math.max(1, Math.floor(maxAgeSeconds)),
    scope: "PRIVATE",
  });
}

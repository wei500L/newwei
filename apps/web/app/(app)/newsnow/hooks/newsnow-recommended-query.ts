export const NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX = 'newsnow-recommended';

export function buildNewsnowRecommendedQueryKey(input: {
  orgId?: string | null;
  userId?: string | null;
  limit: number;
}) {
  return [
    NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX,
    input.orgId ?? 'anonymous-org',
    input.userId ?? 'anonymous-user',
    input.limit,
  ] as const;
}

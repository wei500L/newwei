export const USER_NEWS_BEHAVIOR_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS = 95 * 24 * 60 * 60;
export const USER_NEWS_BEHAVIOR_V2_WINDOW_DAYS = 90;
export const USER_NEWS_BEHAVIOR_PROFILE_CACHE_TTL_SECONDS = 30;

export type UserNewsBehaviorHashKind =
  | "actions"
  | "sources"
  | "topics"
  | "entities"
  | "items"
  | "events"
  | "domains";

export const USER_NEWS_BEHAVIOR_HASH_KINDS: readonly UserNewsBehaviorHashKind[] = [
  "actions",
  "sources",
  "topics",
  "entities",
  "items",
  "events",
  "domains",
];

export type UserNewsBehaviorDimension = UserNewsBehaviorHashKind;

export const USER_NEWS_BEHAVIOR_DIMENSIONS: readonly UserNewsBehaviorDimension[] =
  USER_NEWS_BEHAVIOR_HASH_KINDS;

export interface UserNewsBehaviorBandDefinition {
  key: "1d" | "7d" | "30d" | "90d";
  startDayOffset: number;
  endDayOffset: number;
  weight: number;
}

export const USER_NEWS_BEHAVIOR_BANDS: readonly UserNewsBehaviorBandDefinition[] = [
  {
    key: "1d",
    startDayOffset: 0,
    endDayOffset: 0,
    weight: 0.45,
  },
  {
    key: "7d",
    startDayOffset: 1,
    endDayOffset: 6,
    weight: 0.3,
  },
  {
    key: "30d",
    startDayOffset: 7,
    endDayOffset: 29,
    weight: 0.17,
  },
  {
    key: "90d",
    startDayOffset: 30,
    endDayOffset: 89,
    weight: 0.08,
  },
] as const;

export function buildUserNewsBehaviorHashKey(input: {
  orgId: string;
  userId: string;
  kind: UserNewsBehaviorHashKind;
}): string {
  return `user-news-behavior:${input.orgId}:${input.userId}:${input.kind}`;
}

export function buildUserNewsBehaviorDayKey(input: {
  orgId: string;
  userId: string;
  dayKey: string;
}): string {
  return `user-news-behavior:v2:${input.orgId}:${input.userId}:day:${input.dayKey}`;
}

export function buildUserNewsBehaviorProfileCacheKey(input: {
  orgId: string;
  userId: string;
}): string {
  return `user-news-behavior:v2:${input.orgId}:${input.userId}:profile`;
}

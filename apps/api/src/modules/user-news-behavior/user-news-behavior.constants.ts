export const USER_NEWS_BEHAVIOR_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS = 95 * 24 * 60 * 60;
export const USER_NEWS_BEHAVIOR_V2_WINDOW_DAYS = 90;
export const USER_NEWS_BEHAVIOR_PROFILE_CACHE_TTL_SECONDS = 30;
export const USER_NEWS_BEHAVIOR_DECAY_HALF_LIFE_DAYS = 90;

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
}

export const USER_NEWS_BEHAVIOR_BANDS: readonly UserNewsBehaviorBandDefinition[] = [
  {
    key: "1d",
    startDayOffset: 0,
    endDayOffset: 0,
  },
  {
    key: "7d",
    startDayOffset: 1,
    endDayOffset: 6,
  },
  {
    key: "30d",
    startDayOffset: 7,
    endDayOffset: 29,
  },
  {
    key: "90d",
    startDayOffset: 30,
    endDayOffset: 89,
  },
] as const;

export function computeUserNewsBehaviorDecayWeight(ageDays: number): number {
  const normalizedAgeDays = Number.isFinite(ageDays)
    ? Math.max(0, ageDays)
    : 0;
  return Math.pow(
    0.5,
    normalizedAgeDays / USER_NEWS_BEHAVIOR_DECAY_HALF_LIFE_DAYS,
  );
}

export function computeUserNewsBehaviorBandAverageDecayWeight(
  band: UserNewsBehaviorBandDefinition,
): number {
  const startDayOffset = Math.max(0, Math.floor(band.startDayOffset));
  const endDayOffset = Math.max(
    startDayOffset,
    Math.floor(band.endDayOffset),
  );
  let total = 0;
  for (
    let dayOffset = startDayOffset;
    dayOffset <= endDayOffset;
    dayOffset += 1
  ) {
    total += computeUserNewsBehaviorDecayWeight(dayOffset);
  }
  const days = endDayOffset - startDayOffset + 1;
  return Number((total / days).toFixed(4));
}

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

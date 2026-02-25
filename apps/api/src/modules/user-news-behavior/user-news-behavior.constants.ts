export const USER_NEWS_BEHAVIOR_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export type UserNewsBehaviorHashKind =
  | "actions"
  | "sources"
  | "topics"
  | "entities"
  | "items"
  | "events"
  | "domains";

export const USER_NEWS_BEHAVIOR_HASH_KINDS: ReadonlyArray<UserNewsBehaviorHashKind> = [
  "actions",
  "sources",
  "topics",
  "entities",
  "items",
  "events",
  "domains",
];

export function buildUserNewsBehaviorHashKey(input: {
  orgId: string;
  userId: string;
  kind: UserNewsBehaviorHashKind;
}): string {
  return `user-news-behavior:${input.orgId}:${input.userId}:${input.kind}`;
}

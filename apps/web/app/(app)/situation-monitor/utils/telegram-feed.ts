export interface TelegramFeedFilterState {
  channel: string;
  topic: string;
}

export interface TelegramFeedQueryParams {
  channel?: string;
  limit: number;
  topic?: string;
}

export function buildTelegramFeedQueryParams(
  filters: TelegramFeedFilterState,
  options?: { limit?: number },
): TelegramFeedQueryParams {
  const limit = Number.isFinite(Number(options?.limit))
    ? Math.min(200, Math.max(1, Math.floor(Number(options?.limit))))
    : 80;

  const topic =
    typeof filters.topic === "string" && filters.topic.trim() && filters.topic !== "all"
      ? filters.topic.trim()
      : undefined;
  const channel =
    typeof filters.channel === "string" &&
    filters.channel.trim() &&
    filters.channel !== "all"
      ? filters.channel.trim()
      : undefined;

  return { limit, topic, channel };
}

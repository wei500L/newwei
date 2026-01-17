export const SITUATION_MONITOR_CATEGORIES = ["politics", "tech", "finance", "gov", "ai", "intel"] as const;

export type SituationMonitorCategory = (typeof SITUATION_MONITOR_CATEGORIES)[number];

export const CATEGORY_TAG_PREFIX = "sm:";
export const SOURCE_TAG = "situation-monitor";

export const ALERT_KEYWORDS = [
  "war",
  "invasion",
  "military",
  "nuclear",
  "sanctions",
  "missile",
  "attack",
  "troops",
  "conflict",
  "strike",
  "bomb",
  "casualties",
  "ceasefire",
  "treaty",
  "nato",
  "coup",
  "martial law",
  "emergency",
  "assassination",
  "terrorist",
  "hostage",
  "evacuation",
] as const;


import {
  type SeedSchedulerRuntimeSettings,
  normalizeSeedMode,
  normalizeSeedRssAdaptiveState,
  resolveSeedCacheTtlPolicy,
  resolveSeedRssAdaptiveDiscoveryCacheTtlSeconds,
  resolveSeedRssAdaptiveHitRate,
  resolveSeedRssAdaptiveIntervalSeconds,
  resolveSeedRssAdaptiveTier,
  resolveSeedSchedulerRuntimeSettings,
} from "./news-source-seed";

export interface RssAdaptiveListUiModel {
  tier: "hot" | "warm" | "normal" | "cold";
  hitRate: number | null;
  effectiveIntervalSeconds: number;
  effectiveDiscoveryCacheTtlSeconds: number;
  consecutiveNoHit: number;
  updatedAt: string | null;
  hasHistory: boolean;
}

export interface ResolveRssAdaptiveListUiModelInput {
  config: unknown;
  frequencySeconds: number;
  priority?: number;
  rssAdaptiveState: unknown;
  runtimeSettings?: Partial<SeedSchedulerRuntimeSettings>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toRoundedSeedCacheTtlSeconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
};

const isCronScheduleEnabled = (config: unknown): boolean => {
  if (!isRecord(config) || !isRecord(config.schedule)) {
    return false;
  }
  const modeRaw =
    typeof config.schedule.mode === "string"
      ? config.schedule.mode.trim().toLowerCase()
      : "";
  return modeRaw === "cron";
};

const isRssAdaptiveEnabled = (config: unknown): boolean => {
  if (!isRecord(config) || !isRecord(config.seed) || config.seed.enabled !== true) {
    return false;
  }
  if (normalizeSeedMode(config.seed.mode) !== "rss") {
    return false;
  }
  if (isCronScheduleEnabled(config)) {
    return false;
  }
  const adaptive = isRecord(config.seed.rssAdaptive)
    ? config.seed.rssAdaptive
    : null;
  return adaptive?.enabled === true;
};

export const resolveRssAdaptiveListUiModel = (
  input: ResolveRssAdaptiveListUiModelInput,
): RssAdaptiveListUiModel | null => {
  if (!isRssAdaptiveEnabled(input.config)) {
    return null;
  }
  const runtimeSettings = resolveSeedSchedulerRuntimeSettings(
    input.runtimeSettings,
  );
  const seed = isRecord(input.config) && isRecord(input.config.seed)
    ? input.config.seed
    : null;
  const sourceSeedCacheTtlSeconds = toRoundedSeedCacheTtlSeconds(
    seed?.cacheTtlSeconds,
  );
  const ttlPolicy = resolveSeedCacheTtlPolicy(
    "rss",
    sourceSeedCacheTtlSeconds,
    runtimeSettings,
  );
  const normalizedState = normalizeSeedRssAdaptiveState(input.rssAdaptiveState);
  const hasHistory =
    normalizedState.outcomes.length > 0 || normalizedState.consecutiveNoHit > 0;
  const tier = resolveSeedRssAdaptiveTier(
    normalizedState,
    runtimeSettings,
    input.priority,
  );

  return {
    tier,
    hitRate: resolveSeedRssAdaptiveHitRate(normalizedState),
    effectiveIntervalSeconds: resolveSeedRssAdaptiveIntervalSeconds(
      input.frequencySeconds,
      tier,
      runtimeSettings,
    ),
    effectiveDiscoveryCacheTtlSeconds:
      resolveSeedRssAdaptiveDiscoveryCacheTtlSeconds(
        ttlPolicy.effectiveCacheTtlSeconds,
        tier,
        runtimeSettings,
      ),
    consecutiveNoHit: normalizedState.consecutiveNoHit,
    updatedAt: hasHistory ? normalizedState.updatedAt : null,
    hasHistory,
  };
};

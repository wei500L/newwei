export interface QueueHealthSnapshot {
  active: number;
  failed: number;
  delayed: number;
  waiting: number;
  tracked: number;
}

export interface SystemHealthMetricSaturation {
  abs: number;
  share: number;
  minTracked: number;
}

export interface SystemHealthConfig {
  weights: {
    failed: number;
    active: number;
    delayed: number;
    waiting: number;
  };
  saturation: {
    failed: SystemHealthMetricSaturation;
    active: SystemHealthMetricSaturation;
    delayed: SystemHealthMetricSaturation;
    waiting: SystemHealthMetricSaturation;
  };
  bands: {
    healthyMin: number;
    warningMin: number;
  };
  guardrails: {
    failedCritical: number;
    delayedCritical: number;
  };
}

export type SystemHealthState =
  | "healthy"
  | "warning"
  | "critical"
  | "loading"
  | "unauthorized"
  | "unavailable"
  | "unknown";

export interface SystemHealthMetricBreakdown {
  count: number;
  pressure: number;
  weightedRisk: number;
  share: number;
}

export type SystemHealthMetricKey = "failed" | "active" | "delayed" | "waiting";

export interface SystemHealthAssessment {
  state: SystemHealthState;
  score: number | null;
  risk: number | null;
  counts: QueueHealthSnapshot | null;
  breakdown: {
    failed: SystemHealthMetricBreakdown;
    active: SystemHealthMetricBreakdown;
    delayed: SystemHealthMetricBreakdown;
    waiting: SystemHealthMetricBreakdown;
  } | null;
}

export interface SystemHealthPrimaryPressure {
  metric: SystemHealthMetricKey;
  contributionPercent: number;
  pressurePercent: number;
}

export interface ResolveSystemHealthAssessmentOptions {
  canManageQueue: boolean;
  loading?: boolean;
  error?: unknown;
  counts?: Partial<
    Record<"active" | "failed" | "delayed" | "waiting", number | null>
  > | null;
  config?: SystemHealthConfig;
}

export const SYSTEM_HEALTH_DEFAULT_CONFIG: SystemHealthConfig = {
  weights: {
    failed: 0.4,
    active: 0.3,
    delayed: 0.2,
    waiting: 0.1,
  },
  saturation: {
    failed: { abs: 8, share: 0.2, minTracked: 1 },
    active: { abs: 80, share: 0.85, minTracked: 60 },
    delayed: { abs: 25, share: 0.15, minTracked: 1 },
    waiting: { abs: 120, share: 0.6, minTracked: 1 },
  },
  bands: {
    healthyMin: 80,
    warningMin: 55,
  },
  guardrails: {
    failedCritical: 8,
    delayedCritical: 25,
  },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizeCount = (value: number | null | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
};

export const createQueueHealthSnapshot = (
  counts?: ResolveSystemHealthAssessmentOptions["counts"],
): QueueHealthSnapshot | null => {
  if (!counts) {
    return null;
  }

  const active = normalizeCount(counts.active);
  const failed = normalizeCount(counts.failed);
  const delayed = normalizeCount(counts.delayed);
  const waiting = normalizeCount(counts.waiting);

  return {
    active,
    failed,
    delayed,
    waiting,
    tracked: active + failed + delayed + waiting,
  };
};

const computeMetricPressure = (
  count: number,
  tracked: number,
  saturation: SystemHealthMetricSaturation,
): number => {
  const absolutePressure = count / saturation.abs;
  const trackedBase = Math.max(tracked, saturation.minTracked);
  const sharePressure = count / trackedBase / saturation.share;

  return clamp(absolutePressure * 0.65 + sharePressure * 0.35, 0, 1);
};

const METRIC_KEYS: SystemHealthMetricKey[] = [
  "failed",
  "active",
  "delayed",
  "waiting",
];

export const evaluateSystemHealth = (
  snapshot: QueueHealthSnapshot,
  config: SystemHealthConfig = SYSTEM_HEALTH_DEFAULT_CONFIG,
): SystemHealthAssessment => {
  const failedPressure = computeMetricPressure(
    snapshot.failed,
    snapshot.tracked,
    config.saturation.failed,
  );
  const activePressure = computeMetricPressure(
    snapshot.active,
    snapshot.tracked,
    config.saturation.active,
  );
  const delayedPressure = computeMetricPressure(
    snapshot.delayed,
    snapshot.tracked,
    config.saturation.delayed,
  );
  const waitingPressure = computeMetricPressure(
    snapshot.waiting,
    snapshot.tracked,
    config.saturation.waiting,
  );

  const failedWeightedRisk = failedPressure * config.weights.failed;
  const activeWeightedRisk = activePressure * config.weights.active;
  const delayedWeightedRisk = delayedPressure * config.weights.delayed;
  const waitingWeightedRisk = waitingPressure * config.weights.waiting;
  const risk = clamp(
    failedWeightedRisk +
      activeWeightedRisk +
      delayedWeightedRisk +
      waitingWeightedRisk,
    0,
    1,
  );
  const score = Math.round((1 - risk) * 100);

  const state: SystemHealthState =
    score < config.bands.warningMin ||
    snapshot.failed >= config.guardrails.failedCritical ||
    snapshot.delayed >= config.guardrails.delayedCritical
      ? "critical"
      : score < config.bands.healthyMin
        ? "warning"
        : "healthy";

  return {
    state,
    score,
    risk,
    counts: snapshot,
    breakdown: {
      failed: {
        count: snapshot.failed,
        pressure: failedPressure,
        weightedRisk: failedWeightedRisk,
        share: snapshot.tracked > 0 ? snapshot.failed / snapshot.tracked : 0,
      },
      active: {
        count: snapshot.active,
        pressure: activePressure,
        weightedRisk: activeWeightedRisk,
        share: snapshot.tracked > 0 ? snapshot.active / snapshot.tracked : 0,
      },
      delayed: {
        count: snapshot.delayed,
        pressure: delayedPressure,
        weightedRisk: delayedWeightedRisk,
        share: snapshot.tracked > 0 ? snapshot.delayed / snapshot.tracked : 0,
      },
      waiting: {
        count: snapshot.waiting,
        pressure: waitingPressure,
        weightedRisk: waitingWeightedRisk,
        share: snapshot.tracked > 0 ? snapshot.waiting / snapshot.tracked : 0,
      },
    },
  };
};

export const getPrimarySystemPressure = (
  assessment: SystemHealthAssessment,
): SystemHealthPrimaryPressure | null => {
  if (
    assessment.score === null ||
    assessment.risk === null ||
    assessment.risk <= 0 ||
    !assessment.breakdown
  ) {
    return null;
  }

  const metric = METRIC_KEYS.reduce<SystemHealthMetricKey>(
    (current, candidate) =>
      assessment.breakdown![candidate].weightedRisk >
      assessment.breakdown![current].weightedRisk
        ? candidate
        : current,
    "failed",
  );
  const metricBreakdown = assessment.breakdown[metric];

  return {
    metric,
    contributionPercent: Math.round(
      (metricBreakdown.weightedRisk / assessment.risk) * 100,
    ),
    pressurePercent: Math.round(metricBreakdown.pressure * 100),
  };
};

export const resolveSystemHealthAssessment = ({
  canManageQueue,
  loading = false,
  error,
  counts,
  config = SYSTEM_HEALTH_DEFAULT_CONFIG,
}: ResolveSystemHealthAssessmentOptions): SystemHealthAssessment => {
  if (!canManageQueue) {
    return {
      state: "unauthorized",
      score: null,
      risk: null,
      counts: null,
      breakdown: null,
    };
  }

  const snapshot = createQueueHealthSnapshot(counts);
  if (snapshot) {
    return evaluateSystemHealth(snapshot, config);
  }

  if (loading) {
    return {
      state: "loading",
      score: null,
      risk: null,
      counts: null,
      breakdown: null,
    };
  }

  if (error) {
    return {
      state: "unavailable",
      score: null,
      risk: null,
      counts: null,
      breakdown: null,
    };
  }

  return {
    state: "unknown",
    score: null,
    risk: null,
    counts: null,
    breakdown: null,
  };
};

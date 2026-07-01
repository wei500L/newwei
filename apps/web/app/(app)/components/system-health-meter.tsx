"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  SystemHealthAssessment,
  SystemHealthState,
} from "./system-health";
import styles from "./system-health-meter.module.css";

interface SystemHealthMeterProps {
  assessment: SystemHealthAssessment;
  compact?: boolean;
  showLabel?: boolean;
  className?: string;
  ariaLabel?: string;
}

interface SystemHealthTone {
  dotClassName: string;
  fillClassName: string;
  badgeClassName: string;
  labelClassName: string;
  animationClassName: string | null;
  glowClassName: string | null;
}

const buildStateLabel = (
  state: SystemHealthState,
  t: ReturnType<typeof useTranslation>["t"],
): string => {
  switch (state) {
    case "healthy":
      return t("dashboard.systemStatus.states.healthy");
    case "warning":
      return t("dashboard.systemStatus.states.warning");
    case "critical":
      return t("dashboard.systemStatus.states.critical");
    case "loading":
      return t("dashboard.systemStatus.states.loading");
    case "unauthorized":
      return t("dashboard.systemStatus.states.unauthorized");
    case "unavailable":
      return t("dashboard.systemStatus.states.unavailable");
    case "unknown":
    default:
      return t("dashboard.systemStatus.states.unknown");
  }
};

const buildStateTone = (state: SystemHealthState): SystemHealthTone => {
  switch (state) {
    case "healthy":
      return {
        dotClassName: "bg-emerald-500",
        fillClassName: "bg-[linear-gradient(90deg,#34d399,#10b981)]",
        badgeClassName:
          "border-emerald-200/80 dark:border-emerald-400/35 bg-emerald-50/85 dark:bg-emerald-400/12 text-emerald-700 dark:text-emerald-200",
        labelClassName: "text-emerald-700",
        animationClassName: null,
        glowClassName: null,
      };
    case "warning":
      return {
        dotClassName: "bg-amber-500",
        fillClassName: "bg-[linear-gradient(90deg,#fbbf24,#f59e0b)]",
        badgeClassName:
          "border-amber-200/80 dark:border-amber-400/35 bg-amber-50/90 dark:bg-amber-400/12 text-amber-700 dark:text-amber-200",
        labelClassName: "text-amber-700",
        animationClassName: styles.warningPulse ?? null,
        glowClassName: styles.warningGlow ?? null,
      };
    case "critical":
      return {
        dotClassName: "bg-rose-500",
        fillClassName: "bg-[linear-gradient(90deg,#fb7185,#e11d48)]",
        badgeClassName:
          "border-rose-200/80 dark:border-rose-400/35 bg-rose-50/90 dark:bg-rose-400/12 text-rose-700 dark:text-rose-200",
        labelClassName: "text-rose-700",
        animationClassName: styles.criticalBlink ?? null,
        glowClassName: styles.criticalGlow ?? null,
      };
    default:
      return {
        dotClassName: "bg-slate-400",
        fillClassName: "bg-[linear-gradient(90deg,#cbd5e1,#94a3b8)]",
        badgeClassName:
          "border-slate-200/80 dark:border-slate-700 bg-slate-50/90 dark:bg-slate-800 text-slate-600 dark:text-slate-400",
        labelClassName: "text-slate-600",
        animationClassName: null,
        glowClassName: null,
      };
  }
};

export function SystemHealthMeter({
  assessment,
  compact = false,
  showLabel = true,
  className = "",
  ariaLabel,
}: SystemHealthMeterProps) {
  const { t } = useTranslation();
  const score = assessment.score ?? 0;
  const scoreWidth =
    assessment.score === null ? "0%" : `${Math.max(6, score)}%`;
  const label = useMemo(
    () => buildStateLabel(assessment.state, t),
    [assessment.state, t],
  );
  const tone = useMemo(
    () => buildStateTone(assessment.state),
    [assessment.state],
  );
  const resolvedAriaLabel =
    ariaLabel ??
    t("dashboard.systemStatus.aria.score", {
      state: label,
      score: assessment.score ?? 0,
    });

  return (
    <div
      role="img"
      aria-label={resolvedAriaLabel}
      className={`flex min-w-0 items-center gap-2 ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dotClassName} ${tone.animationClassName ?? ""}`.trim()}
      />
      {showLabel ? (
        <span
          className={`shrink-0 text-xs font-semibold tracking-wide ${tone.labelClassName} ${
            compact ? "max-w-[72px] truncate" : ""
          }`.trim()}
        >
          {label}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className={`relative h-2 ${compact ? "w-16" : "w-full"} overflow-hidden rounded-full border border-white/60 bg-slate-200/80`}
        >
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#f43f5e_0%,#f59e0b_52%,#10b981_100%)] opacity-25" />
          {assessment.score !== null ? (
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${tone.fillClassName}`}
              style={{ width: scoreWidth }}
            />
          ) : null}
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${tone.badgeClassName} ${tone.animationClassName ?? ""} ${tone.glowClassName ?? ""}`.trim()}
        >
          {assessment.score !== null
            ? t("dashboard.systemStatus.scoreValue", {
                score: assessment.score,
              })
            : t("dashboard.systemStatus.scorePending")}
        </span>
      </div>
    </div>
  );
}

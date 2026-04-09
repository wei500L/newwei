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
      return t("dashboard.systemStatus.states.healthy", {
        defaultValue: "Healthy",
      });
    case "warning":
      return t("dashboard.systemStatus.states.warning", {
        defaultValue: "Warning",
      });
    case "critical":
      return t("dashboard.systemStatus.states.critical", {
        defaultValue: "Critical",
      });
    case "loading":
      return t("dashboard.systemStatus.states.loading", {
        defaultValue: "Loading",
      });
    case "unauthorized":
      return t("dashboard.systemStatus.states.unauthorized", {
        defaultValue: "Restricted",
      });
    case "unavailable":
      return t("dashboard.systemStatus.states.unavailable", {
        defaultValue: "Unavailable",
      });
    case "unknown":
    default:
      return t("dashboard.systemStatus.states.unknown", {
        defaultValue: "Unknown",
      });
  }
};

const buildStateTone = (state: SystemHealthState): SystemHealthTone => {
  switch (state) {
    case "healthy":
      return {
        dotClassName: "bg-emerald-500",
        fillClassName: "bg-[linear-gradient(90deg,#34d399,#10b981)]",
        badgeClassName:
          "border-emerald-200/80 bg-emerald-50/85 text-emerald-700",
        labelClassName: "text-emerald-700",
        animationClassName: null,
        glowClassName: null,
      };
    case "warning":
      return {
        dotClassName: "bg-amber-500",
        fillClassName: "bg-[linear-gradient(90deg,#fbbf24,#f59e0b)]",
        badgeClassName: "border-amber-200/80 bg-amber-50/90 text-amber-700",
        labelClassName: "text-amber-700",
        animationClassName: styles.warningPulse ?? null,
        glowClassName: styles.warningGlow ?? null,
      };
    case "critical":
      return {
        dotClassName: "bg-rose-500",
        fillClassName: "bg-[linear-gradient(90deg,#fb7185,#e11d48)]",
        badgeClassName: "border-rose-200/80 bg-rose-50/90 text-rose-700",
        labelClassName: "text-rose-700",
        animationClassName: styles.criticalBlink ?? null,
        glowClassName: styles.criticalGlow ?? null,
      };
    default:
      return {
        dotClassName: "bg-slate-400",
        fillClassName: "bg-[linear-gradient(90deg,#cbd5e1,#94a3b8)]",
        badgeClassName: "border-slate-200/80 bg-slate-50/90 text-slate-600",
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
      defaultValue: "System health {{state}} {{score}} out of 100",
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
                defaultValue: "{{score}}/100",
                score: assessment.score,
              })
            : t("dashboard.systemStatus.scorePending", {
                defaultValue: "--/100",
              })}
        </span>
      </div>
    </div>
  );
}

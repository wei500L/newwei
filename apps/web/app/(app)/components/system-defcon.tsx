"use client";

import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { useSystemHealthContext } from "./system-health-context";
import { SystemHealthMeter } from "./system-health-meter";

const formatCount = (value: number | null | undefined): string =>
  new Intl.NumberFormat().format(value ?? 0);

export function SystemDefcon() {
  const { t } = useTranslation();
  const { assessment, canManageQueue, error } = useSystemHealthContext();

  const tooltip = (() => {
    if (!canManageQueue) {
      return t("dashboard.systemStatus.tooltip.unauthorized");
    }

    if (assessment.score === null) {
      if (assessment.state === "loading") {
        return t("dashboard.systemStatus.tooltip.loading");
      }

      if (assessment.state === "unavailable") {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return t("dashboard.systemStatus.tooltip.unavailable", {
          error: errorMessage,
        });
      }

      return t("dashboard.systemStatus.tooltip.unknown");
    }

    return t("dashboard.systemStatus.tooltip.summary", {
      score: assessment.score,
      active: formatCount(assessment.counts?.active),
      failed: formatCount(assessment.counts?.failed),
      delayed: formatCount(assessment.counts?.delayed),
      waiting: formatCount(assessment.counts?.waiting),
    });
  })();

  return (
    <div className="flex h-8 items-center border-l border-[var(--border)] px-4">
      <Tooltip title={tooltip}>
        <div className="flex cursor-help items-center gap-3 rounded-full border border-[var(--border)] bg-white/70 px-3 py-1.5 shadow-[0_6px_18px_rgba(15,23,42,0.05)]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            {t("dashboard.systemStatus.title")}
          </span>
          <SystemHealthMeter
            assessment={assessment}
            compact
            ariaLabel={t("dashboard.systemStatus.aria.topNav", {
              state: t(`dashboard.systemStatus.states.${assessment.state}`, {
                defaultValue: assessment.state,
              }),
              score: assessment.score ?? 0,
            })}
          />
        </div>
      </Tooltip>
    </div>
  );
}

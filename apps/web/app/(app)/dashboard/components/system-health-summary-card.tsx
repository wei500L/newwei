"use client";

import {
  DownOutlined,
  RadarChartOutlined,
  SettingOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { Button, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SystemHealthMeter } from "@/app/(app)/components/system-health-meter";
import {
  getPrimarySystemPressure,
  type SystemHealthAssessment,
} from "@/app/(app)/components/system-health";
import meterStyles from "@/app/(app)/components/system-health-meter.module.css";

interface SystemHealthSummaryCardProps {
  assessment: SystemHealthAssessment;
  canManageQueue: boolean;
  canManageSettings: boolean;
  canViewCrawlTasks: boolean;
  queueLive: boolean;
  showSystemStats: boolean;
  setShowSystemStats: (nextValue: boolean) => void;
  hasCachedError: boolean;
}

interface QueueCountItem {
  key: "active" | "failed" | "waiting" | "delayed";
  value: number | null;
}

const COUNT_KEYS: QueueCountItem["key"][] = [
  "active",
  "failed",
  "waiting",
  "delayed",
];

const formatCount = (value: number | null): string =>
  typeof value === "number" ? new Intl.NumberFormat().format(value) : "--";

export function SystemHealthSummaryCard({
  assessment,
  canManageQueue,
  canManageSettings,
  canViewCrawlTasks,
  queueLive,
  showSystemStats,
  setShowSystemStats,
  hasCachedError,
}: SystemHealthSummaryCardProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const counts = useMemo<QueueCountItem[]>(
    () =>
      COUNT_KEYS.map((key) => ({
        key,
        value: assessment.counts?.[key] ?? null,
      })),
    [assessment.counts],
  );
  const primaryPressure = useMemo(
    () => getPrimarySystemPressure(assessment),
    [assessment],
  );

  const levelTagColor =
    assessment.state === "critical"
      ? "error"
      : assessment.state === "warning"
        ? "warning"
        : assessment.state === "healthy"
          ? "success"
          : "default";

  const cardPulseClassName =
    assessment.state === "critical"
      ? meterStyles.criticalGlow
      : assessment.state === "warning"
        ? meterStyles.warningGlow
        : "";

  const secondaryAction = canManageSettings
    ? {
        icon: <SettingOutlined />,
        label: t("dashboard.systemStatus.actions.openSystemSettings", {
          defaultValue: "Open system settings",
        }),
        onClick: () => router.push("/admin/system?tab=crawlClient"),
      }
    : canViewCrawlTasks
      ? {
          icon: <RadarChartOutlined />,
          label: t("dashboard.systemStatus.actions.openCrawlTasks", {
            defaultValue: "Open crawl tasks",
          }),
          onClick: () => router.push("/admin/ops/crawl-tasks"),
        }
      : null;

  const description = (() => {
    if (!canManageQueue) {
      return t("dashboard.systemStatus.restrictedDescription", {
        defaultValue: "Queue metrics require the queue.manage permission.",
      });
    }

    switch (assessment.state) {
      case "loading":
        return t("dashboard.systemStatus.loadingDescription", {
          defaultValue: "Fetching the latest queue snapshot.",
        });
      case "unavailable":
        return t("dashboard.systemStatus.unavailableDescription", {
          defaultValue: "Queue metrics are currently unavailable.",
        });
      case "unknown":
        return t("dashboard.systemStatus.unknownDescription", {
          defaultValue: "No queue snapshot has been reported yet.",
        });
      default:
        return t("dashboard.systemStatus.summaryDescription", {
          defaultValue:
            "Weighted health based on failed, active, delayed, and waiting load.",
        });
    }
  })();

  const shouldAllowExpand = canManageQueue;
  const primaryPressureLabel = primaryPressure
    ? t(`dashboard.queue.states.${primaryPressure.metric}`, {
        defaultValue: primaryPressure.metric,
      })
    : null;
  const explanation =
    assessment.score !== null &&
    primaryPressure &&
    primaryPressure.contributionPercent > 0
      ? t("dashboard.systemStatus.primaryPressure", {
          defaultValue:
            "Primary pressure is {{metric}} at {{pressure}}% intensity, driving {{contribution}}% of the current risk.",
          metric: primaryPressureLabel,
          pressure: primaryPressure.pressurePercent,
          contribution: primaryPressure.contributionPercent,
        })
      : assessment.score !== null
        ? t("dashboard.systemStatus.lowPressure", {
            defaultValue:
              "Pressure remains broadly contained across all tracked queues.",
          })
        : description;

  const headerContent = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
            {t("dashboard.systemStatus.title", {
              defaultValue: "System status",
            })}
          </span>
          <Tag color={levelTagColor}>
            {t(`dashboard.systemStatus.states.${assessment.state}`, {
              defaultValue: assessment.state,
            })}
          </Tag>
          {canManageQueue ? (
            <Tag color={queueLive ? "success" : "default"}>
              {queueLive
                ? t("dashboard.queue.live", { defaultValue: "Live" })
                : t("dashboard.queue.offline", { defaultValue: "Offline" })}
            </Tag>
          ) : null}
          {hasCachedError && assessment.counts ? (
            <Tag color="warning">
              {t("dashboard.systemStatus.cachedData", {
                defaultValue: "Cached snapshot",
              })}
            </Tag>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm text-slate-600">{description}</p>
      </div>
      {shouldAllowExpand ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-white/70 text-slate-500">
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={`glass-panel overflow-hidden border border-[var(--border)] p-4 shadow-[0_8px_20px_rgba(15,23,42,0.06)] transition-shadow ${cardPulseClassName}`.trim()}
    >
      {shouldAllowExpand ? (
        <button
          type="button"
          className="flex w-full items-start justify-between gap-3"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={t("dashboard.systemStatus.aria.toggleDetails", {
            defaultValue: "Toggle system status details",
          })}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex items-start justify-between gap-3">
          {headerContent}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <SystemHealthMeter
          assessment={assessment}
          className="max-w-full"
          ariaLabel={t("dashboard.systemStatus.aria.summary", {
            defaultValue:
              "Dashboard system health {{state}} {{score}} out of 100",
            state: t(`dashboard.systemStatus.states.${assessment.state}`, {
              defaultValue: assessment.state,
            }),
            score: assessment.score ?? 0,
          })}
        />
        <div className="text-sm text-slate-600">{explanation}</div>

        {canManageQueue ? (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {counts.map((item) => (
              <div
                key={item.key}
                className="rounded-2xl border border-[var(--border)] bg-white/50 px-3 py-2.5"
              >
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  {t(`dashboard.queue.states.${item.key}`, {
                    defaultValue: item.key,
                  })}
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-800 tabular-nums">
                  {formatCount(item.value)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[var(--border)] bg-white/35 px-4 py-3 text-sm text-slate-600">
            {t("dashboard.systemStatus.restrictedBody", {
              defaultValue:
                "Queue-level counters stay hidden until the account has queue.manage access.",
            })}
          </div>
        )}

        {expanded && canManageQueue ? (
          <div
            id={detailsId}
            className="grid gap-3 border-t border-[var(--border)] pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
          >
            <div className="text-sm text-slate-600">
              {t("dashboard.systemStatus.expandedHint", {
                defaultValue:
                  "Use the quick actions below to expose the full queue panel or jump into deeper system controls.",
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="small"
                type={showSystemStats ? "default" : "primary"}
                onClick={() => setShowSystemStats(!showSystemStats)}
              >
                {showSystemStats
                  ? t("dashboard.systemStatus.actions.hideFullPanel", {
                      defaultValue: "Hide full queue panel",
                    })
                  : t("dashboard.systemStatus.actions.showFullPanel", {
                      defaultValue: "Show full queue panel",
                    })}
              </Button>
              {secondaryAction ? (
                <Button
                  size="small"
                  icon={secondaryAction.icon}
                  onClick={secondaryAction.onClick}
                >
                  {secondaryAction.label}
                </Button>
              ) : null}
            </div>
          </div>
        ) : secondaryAction ? (
          <div id={detailsId} className="border-t border-[var(--border)] pt-4">
            <Button
              size="small"
              icon={secondaryAction.icon}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

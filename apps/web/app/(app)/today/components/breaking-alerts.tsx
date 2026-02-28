"use client";

import { AlertOutlined } from "@ant-design/icons";
import { useQuery } from "@apollo/client";
import { gql } from "@apollo/client";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";

const BREAKING_ALERTS_QUERY = gql`
  query BreakingAlerts($windowDays: Int, $status: NewsEventStatus) {
    newsEvents(windowDays: $windowDays, status: $status) {
      id
      title
      status
      lastAt
      itemCount
      breaking
      heatScore
    }
  }
`;

interface NewsEvent {
  id: string;
  title?: string | null;
  status?: "active" | "archived";
  lastAt?: string;
  itemCount?: number;
  breaking?: boolean;
  heatScore?: number;
}

function isBreakingAlert(event: NewsEvent): boolean {
  // Use backend breaking flag if available
  if (typeof event.breaking === "boolean") {
    return event.breaking;
  }

  // Fallback to client-side logic
  if (event.status !== "active") return false;
  if (!event.lastAt) return false;

  const lastAt = dayjs(event.lastAt);
  const now = dayjs();
  const hoursSinceLastUpdate = now.diff(lastAt, "hours");

  return hoursSinceLastUpdate <= 4 && (event.itemCount ?? 0) >= 5;
}

function getTriggerReason(event: NewsEvent): string {
  const heatScore = event.heatScore ?? 0;

  if (!event.lastAt) {
    return heatScore > 0 ? `Heat score: ${heatScore.toFixed(1)}` : "";
  }

  const lastAt = dayjs(event.lastAt);
  const now = dayjs();
  const hoursSince = now.diff(lastAt, "hours");

  let timeText = "";
  if (hoursSince < 1) {
    timeText = "Updated just now";
  } else if (hoursSince < 4) {
    timeText = `Updated ${hoursSince}h ago`;
  } else {
    timeText = "Updated recently";
  }

  return `${timeText} • ${event.itemCount} articles • Heat: ${heatScore.toFixed(1)}`;
}

export function BreakingAlerts() {
  const { t } = useTranslation();

  const { data } = useQuery<{ newsEvents: NewsEvent[] }>(BREAKING_ALERTS_QUERY, {
    variables: { windowDays: 1, status: "active" },
    fetchPolicy: "cache-first"
  });

  const events = data?.newsEvents ?? [];
  const alerts = events.filter(isBreakingAlert).slice(0, 3);

  if (alerts.length === 0) {
    return (
      <div className="bg-green-50/50 dark:bg-green-900/10 border border-green-100 dark:border-green-900/20 rounded-lg p-3 flex items-center gap-3">
        <div className="bg-green-500/20 text-green-600 dark:text-green-400 rounded-full p-1.5 shrink-0">
          <AlertOutlined />
        </div>
        <div>
          <p className="text-sm text-green-700 dark:text-green-400 m-0 font-medium">
            {t("pages.today.noAlerts", { defaultValue: "No breaking alerts" })}
          </p>
          <p className="text-xs text-green-600/70 dark:text-green-300/70 m-0">
            {t("pages.today.marketsStable", { defaultValue: "Markets are stable" })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-lg p-3 flex items-start gap-3"
        >
          <div className="bg-red-500 text-white rounded-full p-1.5 shrink-0 animate-pulse">
            <AlertOutlined />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-bold text-red-700 dark:text-red-400 text-sm m-0 truncate">
              {alert.title || t("pages.today.breakingAlert", { defaultValue: "Breaking Alert" })}
            </h4>
            <p className="text-xs text-red-600/80 dark:text-red-300/80 m-0">
              {getTriggerReason(alert)}
            </p>
          </div>
        </div>
      ))}
      <p className="text-[10px] text-gray-400 text-center m-0">
        {t("pages.today.alertsDisclaimer", { defaultValue: "For reference only • AI-generated alerts" })}
      </p>
    </div>
  );
}

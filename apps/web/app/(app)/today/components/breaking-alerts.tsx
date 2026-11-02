"use client";

import { useQuery , gql } from "@apollo/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { formatClock, resolveLocale } from "@/lib/i18n";

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

const MAX_VISIBLE_ALERTS = 3;

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

export function BreakingAlerts() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery<{ newsEvents: NewsEvent[] }>(BREAKING_ALERTS_QUERY, {
    variables: { windowDays: 1, status: "active" },
    fetchPolicy: "cache-first"
  });

  const events = data?.newsEvents ?? [];
  const alerts = events.filter(isBreakingAlert);

  if (alerts.length === 0) {
    // 头版没有突发新闻就不占位置。
    return null;
  }

  const visible = expanded ? alerts : alerts.slice(0, MAX_VISIBLE_ALERTS);
  const hidden = expanded ? 0 : Math.max(0, alerts.length - MAX_VISIBLE_ALERTS);

  return (
    <section aria-label={t("pages.today.breaking")} className="flex flex-col">
      {visible.map((alert) => (
        <div key={alert.id} className="hairline-b flex items-baseline gap-3 py-2">
          <span className="kicker shrink-0 text-[var(--destructive)]">
            ● {t("pages.today.breaking")}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {alert.title || t("pages.today.breakingAlert")}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {alert.lastAt ? formatClock(alert.lastAt, locale) : ""}
          </span>
        </div>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="py-2 text-left text-xs text-muted-foreground hover:text-[var(--foreground)]"
        >
          {t("pages.today.moreBreaking", { count: hidden })}
        </button>
      ) : null}
    </section>
  );
}

"use client";

import { useContextStore as getContextStore } from "@gev/ui/stores/context.js";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { useGevStore } from "@/lib/globe/pinia-bridge";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

interface AwarenessNearestItem {
  key: string;
  layer?: string;
  targetId?: string;
  label: string;
  distance: string;
  bearing?: number | string;
  course?: number | string;
  track?: number | string;
  ariaLabel?: string;
}

interface AwarenessRow {
  id: string;
  relationship: string;
  label: string;
  count: string;
  detail: string;
  nearest: AwarenessNearestItem[];
}

interface AwarenessView {
  kind: "standby" | "results" | "empty";
  title?: string;
  text?: string;
  subject?: string;
  rows?: AwarenessRow[];
  note?: string;
}

const LAYER_ICONS: Record<string, string> = {
  flights: "✈️",
  military: "🛩️",
  "ais-live-vessels": "🚢",
  "military-installations": "📍",
};

function bearingText(value: number | string | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const normalized = ((numeric % 360) + 360) % 360;
  return `${String(Math.round(normalized)).padStart(3, "0")}°`;
}

/** 「附近」页签：复刻 GEV `AwarenessPanel.vue` 的 CONTACTS 名单。 */
export function NearbyTargets() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const store = useMemo(
    () => getContextStore(runtime.pinia as never),
    [runtime.pinia],
  );
  const selector = useCallback(
    (state: { awareness: AwarenessView | null }) => state.awareness,
    [],
  );
  const awareness = useGevStore(store, selector);

  const rows = awareness?.kind === "results" ? awareness.rows ?? [] : [];
  const hasItems = rows.some((row) => row.nearest.length > 0);

  if (awareness?.kind === "standby") {
    return (
      <ChartEmptyState
        presentation="banner"
        title={awareness.title ?? t("globe.context.nearby.emptyTitle")}
        description={awareness.text ?? t("globe.context.nearby.emptyDescription")}
      />
    );
  }

  if (!awareness || awareness.kind === "empty" || !hasItems) {
    return (
      <ChartEmptyState
        presentation="banner"
        title={t("globe.context.nearby.emptyTitle")}
        description={t("globe.context.nearby.emptyDescription")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {awareness.subject ? (
        <p className="m-0 text-xs text-slate-300">{awareness.subject}</p>
      ) : null}

      {rows.map((row) => (
        <section key={row.id} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="kicker m-0">{row.label}</span>
            <span className="font-mono text-xs text-slate-400">{row.count}</span>
          </div>
          <p className="m-0 text-[11px] text-slate-500">{row.detail}</p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {row.nearest.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  disabled={!item.targetId}
                  aria-label={item.ariaLabel ?? item.label}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-slate-200 hover:bg-slate-800/70 disabled:cursor-default disabled:text-slate-500"
                  onClick={() => {
                    if (!item.layer || !item.targetId) return;
                    runtime.actions.track({
                      layerId: item.layer,
                      id: item.targetId,
                      targetId: item.targetId,
                    });
                  }}
                >
                  <span aria-hidden="true" className="w-4 shrink-0 text-center">
                    {LAYER_ICONS[row.id] ?? "◎"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="shrink-0 font-mono text-xs text-slate-400">
                    {item.distance}
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono text-xs text-slate-500">
                    {bearingText(item.bearing ?? item.course ?? item.track)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {awareness.note ? (
        <p className="m-0 text-[11px] text-slate-500">{awareness.note}</p>
      ) : null}
    </div>
  );
}

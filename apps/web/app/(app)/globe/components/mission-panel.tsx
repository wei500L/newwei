"use client";

import { useContextStore as getContextStore } from "@gev/ui/stores/context.js";
import { Button } from "antd";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { useGevStore } from "@/lib/globe/pinia-bridge";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

interface MissionEntry {
  id: string;
  index: number;
  label: string;
  provider: string;
  date: string;
  color?: string;
  ariaLabel?: string;
}

interface MissionRoster {
  count: number | string;
  entries: MissionEntry[];
  empty: string;
}

interface MissionPayload {
  name: string;
  detail?: string;
  type?: string;
  destination?: string;
}

interface MissionView {
  title: string;
  provider?: string;
  status?: string;
  site?: string;
  time?: string;
  orbit?: string;
  ascent?: string;
  distance?: string;
  speed?: string;
  payloads?: MissionPayload[];
  index?: number | string;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
}

interface MissionsLayer {
  selectMissionAt?: (index: number) => unknown;
  deselectMission?: () => unknown;
  selectPreviousMission?: () => unknown;
  selectNextMission?: () => unknown;
}

/** 「航天任务」页签：读法照 `MissionRoster.vue` / `MissionDetail.vue`。 */
export function MissionPanel() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const store = useMemo(
    () => getContextStore(runtime.pinia as never),
    [runtime.pinia],
  );

  const rosterSelector = useCallback(
    (state: { missionRoster: MissionRoster | null }) => state.missionRoster,
    [],
  );
  const missionSelector = useCallback(
    (state: { mission: MissionView | null }) => state.mission,
    [],
  );
  const layerSelector = useCallback(
    (state: { missionsLayer: MissionsLayer | null }) => state.missionsLayer,
    [],
  );

  const roster = useGevStore(store, rosterSelector);
  const mission = useGevStore(store, missionSelector);
  const layer = useGevStore(store, layerSelector);

  if (!roster) {
    return (
      <ChartEmptyState
        presentation="banner"
        title={t("globe.context.missions.loading")}
        description={t("globe.context.missions.loadingDescription")}
      />
    );
  }

  if (mission) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="m-0 font-serif text-base text-slate-100">{mission.title}</h3>
          <Button
            size="small"
            type="text"
            aria-label={t("globe.context.missions.close")}
            onClick={() => layer?.deselectMission?.()}
          >
            ×
          </Button>
        </div>
        <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          {(
            [
              ["provider", mission.provider],
              ["status", mission.status],
              ["site", mission.site],
              ["time", mission.time],
              ["orbit", mission.orbit],
              ["ascent", mission.ascent],
              ["distance", mission.distance],
              ["speed", mission.speed],
            ] as const
          )
            .filter(([, value]) => Boolean(value))
            .map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="text-slate-400">
                  {t(`globe.context.missions.fields.${key}`)}
                </dt>
                <dd className="m-0 break-words text-slate-100">{value}</dd>
              </div>
            ))}
        </dl>
        {mission.payloads && mission.payloads.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="kicker m-0">{t("globe.context.missions.payloads")}</span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-slate-200">
              {mission.payloads.map((payload, index) => (
                <li key={`${payload.name}:${index}`} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{payload.name}</span>
                  <span className="shrink-0 text-slate-400">
                    {payload.type ?? payload.destination ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <Button
            size="small"
            disabled={mission.previousDisabled}
            onClick={() => layer?.selectPreviousMission?.()}
          >
            ‹ {t("globe.context.missions.previous")}
          </Button>
          <span className="font-mono text-xs text-slate-400">
            {mission.index ?? "—"}
          </span>
          <Button
            size="small"
            disabled={mission.nextDisabled}
            onClick={() => layer?.selectNextMission?.()}
          >
            {t("globe.context.missions.next")} ›
          </Button>
        </div>
      </div>
    );
  }

  if (roster.entries.length === 0) {
    return (
      <ChartEmptyState
        presentation="banner"
        title={roster.empty || t("globe.context.missions.empty")}
        description={t("globe.context.missions.emptyDescription")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="kicker m-0">{t("globe.context.missions.available")}</span>
        <span className="font-mono text-xs text-slate-400">{roster.count}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {roster.entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs text-slate-200 hover:bg-slate-800/70"
              onClick={() => layer?.selectMissionAt?.(entry.index)}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color ?? "#94a3b8" }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.label}</span>
                <span className="block truncate text-[11px] text-slate-500">
                  {entry.provider} · {entry.date}
                </span>
              </span>
              <span aria-hidden="true" className="text-slate-500">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

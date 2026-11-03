"use client";

import { MenuOutlined } from "@ant-design/icons";
import { layerFeedState } from "@gev/data/feedState.js";
import { keyGuidanceText, keyRequirementText } from "@gev/ui/keyGuidance.js";
import { shownLayerName } from "@gev/ui/layerNames.js";
import { translateFeedError } from "@gev/ui/statusText.js";
import { Button, Collapse, Drawer, Spin, Switch, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { SectionHeader } from "@/components/section-header";
import type { LayerSummary } from "@/lib/globe/engine-types";
import {
  deriveLayerRow,
  groupLayers,
  type LayerPanelDeps,
  type LayerRowState,
} from "@/lib/globe/layer-panel-model";
import type { GlobeRuntime } from "@/lib/globe/runtime";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

/** `dataManager.getAll()` 每次返回新数组；按签名缓存，避免 useSyncExternalStore 死循环。 */
function useLayerSummaries(runtime: GlobeRuntime): LayerSummary[] {
  const manager = runtime.dataManager;
  const store = useMemo(() => {
    let signature = "";
    let cached: LayerSummary[] = [];
    const read = () => {
      const all = manager.getAll();
      let next: string;
      try {
        next = JSON.stringify(
          all.map((layer) => ({
            id: layer.id,
            name: layer.name,
            icon: layer.icon,
            enabled: layer.enabled,
            lifecycleState: layer.lifecycleState,
            uncertain: layer.lifecycleUncertain,
            requiresKeyId: layer.requiresKeyId,
            show: layer.showInTogglePanel,
            stats: layer.stats,
          })),
        );
      } catch {
        // 统计里若有不可序列化的值，退化为只看开关/生命周期，避免面板崩溃。
        next = all
          .map((layer) => `${layer.id}:${layer.enabled}:${layer.lifecycleState}`)
          .join("|");
      }
      if (next !== signature) {
        signature = next;
        cached = all;
      }
      return cached;
    };
    return {
      subscribe: (callback: () => void) => manager.subscribe(callback),
      getSnapshot: read,
    };
  }, [manager]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function statusColor(state: LayerRowState): string {
  switch (state) {
    case "degraded":
    case "stale":
    case "partial":
    case "fallback":
    case "uncertain":
      return "text-amber-400";
    case "unavailable":
      return "text-rose-400";
    case "loading":
      return "text-slate-400";
    default:
      return "text-slate-400";
  }
}

function LayerRowItem({
  runtime,
  layer,
  deps,
}: {
  runtime: GlobeRuntime;
  layer: LayerSummary;
  deps: LayerPanelDeps;
}) {
  const { t } = useTranslation();
  const row = deriveLayerRow(layer, deps);
  const showStatus = row.state !== "nominal" && row.state !== "off";

  const control = (
    <Switch
      size="small"
      checked={row.enabled}
      loading={row.busy}
      disabled={row.busy || row.keyRequired}
      aria-label={row.name}
      onChange={() => {
        void runtime.actions.toggleLayer(row.id);
      }}
    />
  );

  return (
    <div className="border-b border-slate-800/60 py-1.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-0.5 w-5 shrink-0 text-center text-sm">
          {row.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-slate-100" title={row.name}>
              {row.name}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-xs text-slate-400">
                {row.countText}
              </span>
              {row.keyRequired ? (
                <Tooltip
                  title={row.keyGuidance || t("globe.layers.keyRequiredHint")}
                >
                  <span className="inline-flex">{control}</span>
                </Tooltip>
              ) : (
                control
              )}
            </span>
          </div>
          {showStatus ? (
            <div
              className={`mt-0.5 flex items-center gap-1 text-[11px] ${statusColor(row.state)}`}
            >
              {row.state === "loading" ? <Spin size="small" /> : null}
              <span>{t(row.stateLabelKey, { defaultValue: row.stateLabelKey })}</span>
            </div>
          ) : null}
          {row.error ? (
            <div className="mt-0.5 line-clamp-2 text-[11px] text-rose-400">
              {row.error}
            </div>
          ) : null}
          {row.keyRequired && !row.error ? (
            <div className="mt-0.5 text-[11px] text-amber-400">
              {t("globe.layers.keyRequired")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LayerPanelContent({ runtime }: { runtime: GlobeRuntime }) {
  const { t, i18n } = useTranslation();
  const layers = useLayerSummaries(runtime);
  const [clearing, setClearing] = useState(false);
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const initialized = useRef(false);

  const locale: "zh-CN" | "en" = i18n.language?.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en";

  const groups = useMemo(() => groupLayers(layers), [layers]);

  const deps = useMemo<LayerPanelDeps>(
    () => ({
      layerFeedState,
      shownLayerName,
      keyRequirementText,
      keyGuidanceText,
      translateFeedError,
      locale,
    }),
    [locale],
  );

  const groupSignature = groups.map((group) => group.groupKey).join("|");
  useEffect(() => {
    if (initialized.current || groups.length === 0) return;
    const open = groups
      .filter((group) => group.rows.some((layer) => layer.enabled))
      .map((group) => group.groupKey);
    setActiveKeys(open.length > 0 ? open : groups.map((group) => group.groupKey));
    initialized.current = true;
    // groupSignature 只用于在分组结构变化时重算；初始化只做一次。
  }, [groupSignature, groups]);

  const clearAll = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await runtime.actions.clearLayers();
    } finally {
      setClearing(false);
    }
  };

  const items = groups.map((group) => ({
    key: group.groupKey,
    label: <span className="kicker">{t(group.groupKey)}</span>,
    children: (
      <div className="pl-0.5">
        {group.rows.map((layer) => (
          <LayerRowItem
            key={layer.id}
            runtime={runtime}
            layer={layer}
            deps={deps}
          />
        ))}
      </div>
    ),
  }));

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="border-b border-slate-800 px-3 py-2">
        <SectionHeader
          kicker="DATA LAYERS"
          title={t("globe.layers.title")}
          extra={
            <Button
              type="text"
              size="small"
              loading={clearing}
              disabled={clearing}
              aria-busy={clearing}
              aria-label={t("globe.layers.closeAll")}
              onClick={() => {
                void clearAll();
              }}
            >
              {clearing ? t("globe.layers.clearing") : t("globe.layers.closeAll")}
            </Button>
          }
        />
      </div>
      <div className="rail-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-slate-400">{t("globe.layers.empty")}</p>
        ) : (
          <Collapse
            ghost
            size="small"
            activeKey={activeKeys}
            onChange={(keys) =>
              setActiveKeys(Array.isArray(keys) ? keys : [keys])
            }
            items={items}
          />
        )}
      </div>
    </div>
  );
}

const PANEL_SHELL =
  "pointer-events-auto rounded-md border border-slate-700 bg-slate-950/85 text-slate-100";

export function LayerPanel() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <nav
        aria-label={t("globe.layers.aria")}
        className={`${PANEL_SHELL} absolute left-3 top-3 bottom-20 z-20 hidden w-[300px] flex-col md:flex`}
      >
        <LayerPanelContent runtime={runtime} />
      </nav>

      <div className="pointer-events-auto absolute left-3 top-3 z-20 md:hidden">
        <Button
          type="text"
          aria-label={t("globe.layers.open")}
          className="border border-slate-700 bg-slate-950/85 text-slate-100"
          icon={<MenuOutlined />}
          onClick={() => setDrawerOpen(true)}
        />
      </div>

      <Drawer
        placement="left"
        width={300}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={t("globe.layers.title")}
        styles={{ body: { padding: 0, height: "100%" } }}
      >
        <LayerPanelContent runtime={runtime} />
      </Drawer>
    </>
  );
}

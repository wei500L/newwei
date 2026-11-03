"use client";

import {
  GlobalOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useDisplayStore } from "@gev/ui/stores/display.js";
import {
  AutoComplete,
  Button,
  Dropdown,
  Input,
  Popover,
  Segmented,
  Tooltip,
} from "antd";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  GLOBE_MAP_STACKS,
  GLOBE_STYLES,
  parseCoordinateQuery,
} from "@/lib/globe/command-model";
import { detectionModeStore } from "@/lib/globe/detection-mode-store";
import { useMapStack } from "@/lib/globe/gev-events";
import { useGevStore } from "@/lib/globe/pinia-bridge";
import type { GlobePlaceResult } from "@/lib/globe/runtime";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

const DOCK_SHELL =
  "pointer-events-auto flex items-center gap-2 rounded-md border border-slate-700 bg-slate-950/85 px-2 py-2";

/** 640px 以下的窄屏：底图 / 风格都收进 Dropdown，dock 抬高避开数据署名。 */
function useNarrowScreen(query = "(max-width: 639px)"): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    setNarrow(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return narrow;
}

function ResultOption({ result }: { result: GlobePlaceResult }) {
  const { t } = useTranslation();
  const kindLabel = t(`globe.dock.kind.${result.kind}`, {
    defaultValue: result.kind,
  });
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate text-sm text-slate-100">
          {result.label}
        </span>
        {result.sublabel ? (
          <span className="block truncate text-[11px] text-slate-400">
            {result.sublabel}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
        {kindLabel}
      </span>
    </div>
  );
}

/** 地点搜索：防抖 250ms、AbortController 取消上一次请求；坐标即时预览。 */
function PlaceSearch() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<
    { value: string; label: ReactNode }[]
  >([]);
  const results = useRef(new Map<string, GlobePlaceResult>());
  const controller = useRef<AbortController | null>(null);

  // 输入（或坐标即时预览）→ 250ms 防抖搜索。
  useEffect(() => {
    const text = value.trim();
    results.current.clear();

    if (!text) {
      setOptions([]);
      setOpen(false);
      controller.current?.abort();
      return;
    }

    const coordinate = parseCoordinateQuery(text);
    if (coordinate) {
      const result: GlobePlaceResult = {
        id: "coordinate",
        label: coordinate.label,
        lat: coordinate.lat,
        lon: coordinate.lon,
        kind: "coordinate",
      };
      results.current.set(result.id, result);
      setOptions([
        {
          value: result.id,
          label: (
            <span className="text-sm text-slate-100">
              {t("globe.dock.flyToCoordinate", { coords: result.label })}
            </span>
          ),
        },
      ]);
      setOpen(true);
      controller.current?.abort();
      return;
    }

    const timer = window.setTimeout(() => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      void runtime.actions
        .searchPlaces(text, next.signal)
        .then((found) => {
          if (next.signal.aborted) return;
          results.current.clear();
          for (const result of found) results.current.set(result.id, result);
          setOptions(
            found.map((result) => ({
              value: result.id,
              label: <ResultOption result={result} />,
            })),
          );
          setOpen(true);
        })
        .catch(() => {
          if (!next.signal.aborted) setOptions([]);
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [value, runtime, t]);

  // Esc（快捷键层派发）关闭并清空搜索。
  useEffect(() => {
    const dismiss = () => {
      setOpen(false);
      setValue("");
      controller.current?.abort();
    };
    window.addEventListener("globe:dismiss-search", dismiss);
    return () => window.removeEventListener("globe:dismiss-search", dismiss);
  }, []);

  // 卸载时取消在途请求。
  useEffect(() => () => controller.current?.abort(), []);

  const onSelect = (selected: string) => {
    const result = results.current.get(String(selected));
    setOpen(false);
    setValue("");
    if (result) runtime.actions.flyToPlace(result);
  };

  return (
    <div className="min-w-0 flex-1">
      <AutoComplete
        value={value}
        options={options}
        open={open}
        onSearch={setValue}
        onChange={(next) => setValue(String(next ?? ""))}
        onSelect={onSelect}
        onDropdownVisibleChange={(next) => setOpen(next)}
        className="w-full"
        popupMatchSelectWidth={false}
      >
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined className="text-slate-500" />}
          placeholder={t("globe.dock.searchPlaceholder")}
          aria-label={t("globe.dock.searchAria")}
        />
      </AutoComplete>
    </div>
  );
}

function StyleControl() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const narrow = useNarrowScreen();
  const displayStore = useDisplayStore(runtime.pinia as never);
  const style = useGevStore(
    displayStore,
    (state) =>
      (state as { style?: { name: string; label: string } | null }).style ??
      null,
  );
  const activeStyle = style?.name ?? runtime.actions.getStyle();

  const items = GLOBE_STYLES.map((option) => ({
    value: option.id,
    label: (
      <span title={`${t(option.labelKey)} · ${option.key}`}>
        {t(option.labelKey)}
      </span>
    ),
  }));

  if (narrow) {
    return (
      <Dropdown
        trigger={["click"]}
        menu={{
          items: GLOBE_STYLES.map((option) => ({
            key: option.id,
            label: `${t(option.labelKey)} · ${option.key}`,
          })),
          selectable: true,
          selectedKeys: [activeStyle],
          onClick: ({ key }) => runtime.actions.setStyle(key),
        }}
      >
        <Button
          type="text"
          size="small"
          aria-label={t("globe.dock.styleAria")}
          title={`${t("globe.dock.styleAria")} · ${activeStyle}`}
        >
          {t(
            GLOBE_STYLES.find((option) => option.id === activeStyle)
              ?.labelKey ?? "globe.styles.normal",
          )}
        </Button>
      </Dropdown>
    );
  }

  return (
    <div role="group" aria-label={t("globe.dock.styleAria")} className="shrink-0">
      <Segmented
        size="small"
        value={activeStyle}
        options={items}
        onChange={(next) => runtime.actions.setStyle(String(next))}
      />
    </div>
  );
}

function MapStackControl() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const mapState = useMapStack<{ activeId?: string }>();
  const activeId = mapState?.activeId ?? runtime.actions.getMapStack();
  const stacks = runtime.actions.availableMapStacks();

  const available = GLOBE_MAP_STACKS.filter((stack) =>
    stacks.some((candidate) => candidate.id === stack.id),
  );
  const activeStack = available.find((stack) => stack.id === activeId);

  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: available.map((stack) => ({
          key: stack.id,
          label: t(stack.labelKey),
        })),
        selectable: true,
        selectedKeys: [activeId],
        onClick: ({ key }) => {
          void runtime.actions.setMapStack(key).catch(() => undefined);
        },
      }}
    >
      <Button
        type="text"
        size="small"
        aria-label={t("globe.dock.mapStackAria")}
        title={t("globe.dock.mapStackAria")}
      >
        {activeStack ? t(activeStack.labelKey) : activeId}
      </Button>
    </Dropdown>
  );
}

function DetectionControl() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const mode = useSyncExternalStore(
    detectionModeStore.subscribe,
    detectionModeStore.getSnapshot,
    detectionModeStore.getSnapshot,
  );
  const label = t(`globe.dock.detectionModes.${mode}`, { defaultValue: mode });
  const on = mode !== "OFF";

  return (
    <Button
      type="text"
      size="small"
      aria-pressed={on}
      aria-label={t("globe.dock.detectionAria", { mode: label })}
      title={t("globe.dock.detectionAria", { mode: label })}
      onClick={() => runtime.actions.cycleDetection()}
    >
      {label}
    </Button>
  );
}

function ShortcutHelp() {
  const { t } = useTranslation();
  const actionHelp: readonly (readonly [string, string])[] = [
    ["H", "globe.dock.help.hud"],
    ["O", "globe.dock.help.orbit"],
    ["V", "globe.dock.help.cleanView"],
    ["F", "globe.dock.help.layers"],
    ["D", "globe.dock.help.detection"],
    ["C", "globe.dock.help.cctv"],
  ];
  const content = (
    <div className="grid max-w-[280px] grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs text-slate-200">
      {GLOBE_STYLES.map((style) => (
        <Fragment key={style.id}>
          <kbd className="rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">
            {style.key}
          </kbd>
          <span>{t(style.labelKey)}</span>
        </Fragment>
      ))}
      <kbd className="rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">
        Esc
      </kbd>
      <span>{t("globe.dock.help.escape")}</span>
      {actionHelp.map(([key, labelKey]) => (
        <Fragment key={key}>
          <kbd className="rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">
            {key}
          </kbd>
          <span>{t(labelKey)}</span>
        </Fragment>
      ))}
    </div>
  );

  return (
    <Popover
      content={content}
      title={t("globe.dock.shortcuts")}
      trigger="click"
      placement="top"
    >
      <Button
        type="text"
        size="small"
        aria-label={t("globe.dock.shortcuts")}
        title={t("globe.dock.shortcuts")}
        icon={<QuestionCircleOutlined />}
      />
    </Popover>
  );
}

/**
 * 底部命令坞（`absolute bottom-4 left-1/2 -translate-x-1/2`，宽度
 * `min(760px, calc(100% - 24px))`）。窄屏抬高到 `bottom-14` 以避开右下角
 * 数据署名 `#cesium-credits`。
 */
export function CommandDock() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();

  return (
    <div
      aria-label={t("globe.dock.aria")}
      className="pointer-events-auto absolute left-1/2 bottom-4 z-30 -translate-x-1/2 max-sm:bottom-14"
      style={{ width: "min(760px, calc(100% - 24px))" }}
    >
      <div className={DOCK_SHELL}>
        <PlaceSearch />
        <div className="flex shrink-0 items-center gap-1">
          <StyleControl />
          <MapStackControl />
          <DetectionControl />
          <Tooltip title={t("globe.dock.resetGlobe")}>
            <Button
              type="text"
              size="small"
              aria-label={t("globe.dock.resetGlobe")}
              title={t("globe.dock.resetGlobe")}
              icon={<GlobalOutlined />}
              onClick={() => runtime.actions.resetGlobe()}
            />
          </Tooltip>
          <ShortcutHelp />
        </div>
      </div>
    </div>
  );
}

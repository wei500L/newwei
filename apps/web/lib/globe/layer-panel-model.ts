/**
 * layer-panel-model.ts — 左侧「数据图层」面板的纯逻辑。
 *
 * 分组常量 `GLOBE_LAYER_GROUPS` 移植自
 * `vendor/gods-eye-view/src/ui/layerPanel.js:41-99` 的 `PANEL_GROUPS`
 * （只抄写数据，不引用该文件：`ui/layerPanel.js` 会间接带进 `LayerRows.vue`）。
 * 状态推导等函数由调用方注入 GEV 的无 Vue 依赖模块：
 * `@gev/data/feedState.js`、`@gev/ui/layerNames.js`、`@gev/ui/keyGuidance.js`、
 * `@gev/ui/statusText.js`。
 */
import type { LayerSummary } from "./engine-types";

/** 图层面板状态：GEV 的 feed state + 生命周期过渡态 + 关闭态。 */
export type LayerRowState =
  | "nominal"
  | "loading"
  | "degraded"
  | "stale"
  | "partial"
  | "fallback"
  | "unavailable"
  | "enabling"
  | "disabling"
  | "off"
  | "uncertain";

/** 状态 → i18n key（`layerPanel.js:26-37` 的 FEED_STATE_LABEL_KEYS 一一对应，另补 off/uncertain）。 */
export const LAYER_STATE_LABEL_KEYS: Record<LayerRowState, string> = {
  nominal: "globe.layers.state.nominal",
  loading: "globe.layers.state.loading",
  degraded: "globe.layers.state.degraded",
  stale: "globe.layers.state.stale",
  partial: "globe.layers.state.partial",
  fallback: "globe.layers.state.fallback",
  unavailable: "globe.layers.state.unavailable",
  enabling: "globe.layers.state.enabling",
  disabling: "globe.layers.state.disabling",
  off: "globe.layers.state.off",
  uncertain: "globe.layers.state.uncertain",
};

/** 图层分组：展示顺序与注册顺序无关。键是 i18n key。 */
export interface GlobeLayerGroup {
  key: string;
  ids: readonly string[];
}

export const GLOBE_LAYER_GROUPS: readonly GlobeLayerGroup[] = Object.freeze([
  {
    key: "globe.layers.groups.movement",
    ids: [
      "satellites",
      "flights",
      "military",
      "local-adsb",
      "ais-live-vessels",
      "traffic",
      "transit",
      "bikeshare",
    ],
  },
  {
    key: "globe.layers.groups.cameras",
    ids: ["cctv", "recent-imagery", "street-level"],
  },
  {
    key: "globe.layers.groups.infrastructure",
    ids: [
      "alpr-cameras",
      "military-installations",
      "local-datacenters",
      "telegeography-submarine-cables",
      "local-dams",
    ],
  },
  {
    key: "globe.layers.groups.events",
    ids: [
      "rocket-launches",
      "earthquakes",
      "local-firms",
      "fire-perimeters",
      "gnss-integrity",
      "s2-ghostmaps",
    ],
  },
  {
    key: "globe.layers.groups.weather",
    ids: [
      "air-quality",
      "wind",
      "weather-radar",
      "weather-satellite",
      "weather-lightning",
      "weather-cyclones",
    ],
  },
  {
    key: "globe.layers.groups.audio",
    ids: ["radio"],
  },
]);

/** 未登记但允许出现在面板里的图层进「其它」组。 */
export const OTHER_LAYERS_GROUP_KEY = "globe.layers.groups.other";

/** `deriveLayerRow` 依赖的 GEV 函数（注入以便单测使用假实现，不加载 GEV）。 */
export interface LayerPanelDeps {
  layerFeedState(stats?: Record<string, unknown> | null): string;
  shownLayerName(name?: string, id?: string): string;
  keyRequirementText(id: string): string;
  keyGuidanceText(
    requirement: string,
    alternatives?: readonly { label?: string; requiresKeyId?: string | null }[],
  ): string;
  translateFeedError(text?: string): string;
  locale: "zh-CN" | "en";
}

/** 一行图层的视图模型。 */
export interface LayerRowView {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  busy: boolean;
  state: LayerRowState;
  stateLabelKey: string;
  count: number | null;
  countText: string;
  error: string | null;
  keyRequired: boolean;
  /** 缺少密钥时的完整提示（GEV keyGuidanceText 的产物）；空串表示无。 */
  keyGuidance: string;
  lastUpdate: number | null;
}

function trimTrailingZero(text: string): string {
  return text.replace(/\.0$/, "");
}

/**
 * 数量格式化：>= 10000 时中文 `1.2万`、英文 `12k`；其余按语言分组显示。
 * `0` / 缺失按 GEV 的习惯显示 `—`。
 */
export function formatLayerCount(
  count: number | null | undefined,
  locale: "zh-CN" | "en",
): string {
  if (count == null || !Number.isFinite(count) || count <= 0) return "—";
  if (count >= 10000) {
    if (locale === "zh-CN") {
      return `${trimTrailingZero((count / 10000).toFixed(1))}万`;
    }
    return `${trimTrailingZero((count / 1000).toFixed(1))}k`;
  }
  return count.toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US");
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 输入 `dataManager.getAll()` 的一项，输出一行视图模型。 */
export function deriveLayerRow(
  layer: LayerSummary,
  deps: LayerPanelDeps,
): LayerRowView {
  const stats = (layer.stats ?? {}) as Record<string, unknown>;
  const transitioning =
    layer.lifecycleState === "enabling" || layer.lifecycleState === "disabling";
  const sourceUnavailable = stats.sourceUnavailable === true;

  let state: LayerRowState;
  if (transitioning) {
    state = layer.lifecycleState as LayerRowState;
  } else if (layer.lifecycleUncertain) {
    state = "uncertain";
  } else if (sourceUnavailable) {
    state = "unavailable";
  } else if (!layer.enabled) {
    state = "off";
  } else {
    state = deps.layerFeedState(stats) as LayerRowState;
  }

  const count = asNumber(stats.count);
  const countLabel = asNonEmptyString(stats.countLabel);
  const countText = countLabel ?? formatLayerCount(count, deps.locale);

  const errorText =
    asNonEmptyString(stats.error) ??
    asNonEmptyString(stats.lastError) ??
    asNonEmptyString(stats.managerRefreshError);
  const error = errorText ? deps.translateFeedError(errorText) : null;

  const keyRequired = stats.keyRequired === true;
  let keyGuidance = "";
  if (keyRequired) {
    const requirement = deps.keyRequirementText(
      String(layer.requiresKeyId ?? ""),
    );
    const rawAlternatives = Array.isArray(stats.keyAlternatives)
      ? (stats.keyAlternatives as readonly {
          label?: string;
          requiresKeyId?: string | null;
        }[])
      : [];
    keyGuidance = deps.keyGuidanceText(requirement, rawAlternatives) || "";
  }

  return {
    id: layer.id,
    name: deps.shownLayerName(layer.name, layer.id),
    icon: String(layer.icon ?? ""),
    enabled: Boolean(layer.enabled),
    busy: transitioning,
    state,
    stateLabelKey: LAYER_STATE_LABEL_KEYS[state] ?? LAYER_STATE_LABEL_KEYS.uncertain,
    count,
    countText,
    error,
    keyRequired,
    keyGuidance,
    lastUpdate: asNumber(stats.lastUpdate),
  };
}

/** 分组后的原始图层（组件再逐行调用 `deriveLayerRow`）。 */
export interface GroupedLayers {
  groupKey: string;
  rows: LayerSummary[];
}

/**
 * 按 `GLOBE_LAYER_GROUPS` 的顺序分组：
 * - 未登记、`showInTogglePanel` 为真 → 「其它」组；
 * - `showInTogglePanel === false` → 不显示；
 * - 空组丢弃。
 */
export function groupLayers(all: LayerSummary[]): GroupedLayers[] {
  const visible = all.filter((layer) => layer.showInTogglePanel !== false);
  const byId = new Map(visible.map((layer) => [layer.id, layer] as const));
  const claimed = new Set<string>();
  const groups: GroupedLayers[] = [];

  for (const group of GLOBE_LAYER_GROUPS) {
    const rows: LayerSummary[] = [];
    for (const id of group.ids) {
      const layer = byId.get(id);
      if (!layer) continue;
      rows.push(layer);
      claimed.add(id);
    }
    if (rows.length > 0) groups.push({ groupKey: group.key, rows });
  }

  const others = visible.filter((layer) => !claimed.has(layer.id));
  if (others.length > 0) {
    groups.push({ groupKey: OTHER_LAYERS_GROUP_KEY, rows: others });
  }

  return groups;
}

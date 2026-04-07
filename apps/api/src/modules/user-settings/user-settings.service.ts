import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  type WarMapLayerId as SharedWarMapLayerId,
  type WarMapLayerVisibility as SharedWarMapLayerVisibility,
  type WarMapSettings as SharedWarMapSettings,
  normalizeWarMapSettings as normalizeSharedWarMapSettings,
} from "@modular/utils";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../config/prisma.service";

const KEY_SITUATION_MONITOR_MONITORS = "ui:situation-monitor:monitors:v1";
const KEY_SITUATION_MONITOR_LAYOUT = "ui:situation-monitor:layout:v1";
const KEY_SITUATION_MONITOR_SETTINGS = "ui:situation-monitor:settings:v1";
const KEY_WAR_MAP_SETTINGS = "ui:war-map:settings:v1";
const KEY_SPACETIME_TIMELINE_SETTINGS = "ui:spacetime-timeline:settings:v1";
const KEY_NEWSNOW_SETTINGS = "ui:newsnow:settings:v1";
const KEY_RSS_READER_SETTINGS = "ui:rss-reader:settings:v1";

const MAX_MONITORS = 20;
const MAX_LAYOUT_ITEMS_PER_BREAKPOINT = 64;
const MAX_VISIBILITY_KEYS = 64;
const MAX_NEWSNOW_SOURCE_IDS = 200;
const MAX_NEWSNOW_COLUMNS = 32;
const MAX_NEWSNOW_AFFINITIES = 300;
const MAX_RSS_READER_SOURCE_IDS = 500;
const MAX_RSS_READER_LANGUAGE_FILTERS = 24;
const NEWSNOW_SOURCE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;

export interface SituationMonitorUiSettingsResponse {
  version: 1;
  updatedAt: {
    monitors?: string;
    layout?: string;
    settings?: string;
  };
  monitors: SituationMonitorCustomMonitor[] | null;
  layout: SituationMonitorLayout | null;
  settings: SituationMonitorSettings | null;
}

export type WarMapLayerId = SharedWarMapLayerId;
export type WarMapLayerVisibility = SharedWarMapLayerVisibility;
export type WarMapSettings = SharedWarMapSettings;

export interface WarMapUiSettingsResponse {
  version: 1;
  updatedAt: {
    settings?: string;
  };
  settings: WarMapSettings | null;
}

export type SpacetimeTimelineSourceType =
  | "all"
  | "authoritative"
  | "mixed"
  | "blog";

export type SpacetimeTimelineSortBy = "latest" | "heat" | "credibility";

export type SpacetimeTimelineGranularity = "auto" | "day" | "week" | "month";

export interface SpacetimeTimelineSettings {
  authoritativeLock: boolean;
  requireCorroborated: boolean;
  sourceType: SpacetimeTimelineSourceType;
  sortBy: SpacetimeTimelineSortBy;
  minHeatScore: number;
  minCredibilityScore: number;
  timelineGranularity: SpacetimeTimelineGranularity;
  speed: number;
  syncStatusAutoRefresh: boolean;
}

export interface SpacetimeTimelineUiSettingsResponse {
  version: 1;
  updatedAt: {
    settings?: string;
  };
  settings: SpacetimeTimelineSettings | null;
}

export type NewsnowSortMode = "manual" | "personalized" | "smart";
export type NewsnowDensityMode = "compact" | "comfortable";

export interface NewsnowSourceAffinitySettings {
  score: number;
  openOriginalCount: number;
  openEventCount: number;
  openItemCount: number;
  refreshCount: number;
  focusCount: number;
  accumulatedDwellMs: number;
  lastInteractedAt: number;
}

export interface NewsnowUiSettings {
  focusSources: string[];
  columnOrders: Record<string, string[]>;
  hideCrossSourceDuplicates: boolean;
  sortMode: NewsnowSortMode;
  densityMode: NewsnowDensityMode;
  sourceAffinity: Record<string, NewsnowSourceAffinitySettings>;
}

export interface NewsnowUiSettingsResponse {
  version: 1;
  updatedAt: {
    settings?: string;
  };
  settings: NewsnowUiSettings | null;
}

export type RssReaderTranslationProvider = "deeplx" | "llm";

export interface RssReaderUiSettings {
  selectedSourceIds: string[] | null;
  sourceLanguageFilters: string[];
  translationEnabled: boolean;
  translationProvider: RssReaderTranslationProvider;
  targetLanguage: string;
  showOriginalContent: boolean;
}

export interface RssReaderUiSettingsResponse {
  version: 1;
  updatedAt: {
    settings?: string;
  };
  settings: RssReaderUiSettings | null;
}

export function createDefaultNewsnowUiSettings(): NewsnowUiSettings {
  return {
    focusSources: [],
    columnOrders: {},
    hideCrossSourceDuplicates: false,
    sortMode: "manual",
    densityMode: "compact",
    sourceAffinity: {},
  };
}

export function createDefaultRssReaderUiSettings(): RssReaderUiSettings {
  return {
    selectedSourceIds: null,
    sourceLanguageFilters: [],
    translationEnabled: false,
    translationProvider: "deeplx",
    targetLanguage: "zh-CN",
    showOriginalContent: false,
  };
}

export interface SituationMonitorCustomMonitor {
  id: string;
  name: string;
  keywords: string[];
  enabled: boolean;
  color?: string;
  location?: {
    name: string;
    lat: number;
    lng: number;
  };
  createdAt: number;
}

export interface SituationMonitorLayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  static?: boolean;
}

export const SITUATION_MONITOR_LAYOUT_BREAKPOINTS = [
  "lg",
  "md",
  "sm",
  "xs",
  "xxs",
] as const;

export type SituationMonitorLayoutBreakpoint =
  (typeof SITUATION_MONITOR_LAYOUT_BREAKPOINTS)[number];

export type SituationMonitorResponsiveLayouts = Partial<
  Record<SituationMonitorLayoutBreakpoint, SituationMonitorLayoutItem[]>
>;

export interface SituationMonitorLayout {
  layouts: SituationMonitorResponsiveLayouts;
  visibility: Record<string, boolean>;
}

export type SituationMonitorScope = "tagged" | "all";

export interface SituationMonitorSettings {
  windowHours: number;
  scope: SituationMonitorScope;
  autoRefresh: boolean;
  resetLayoutOnPreset: boolean;
  translateToZh: boolean;
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

function normalizeKeywords(raw: unknown): string[] {
  const normalized = Array.isArray(raw)
    ? raw
        .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 30)
    : [];

  return Array.from(new Set(normalized));
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (
    /^#[0-9a-fA-F]{6}$/.test(normalized) ||
    /^#[0-9a-fA-F]{3}$/.test(normalized)
  ) {
    return normalized.toLowerCase();
  }
  return undefined;
}

function normalizeLocation(
  value: unknown,
): SituationMonitorCustomMonitor["location"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const name = normalizeName(record.name);
  const lat =
    typeof record.lat === "number" && Number.isFinite(record.lat)
      ? record.lat
      : Number.NaN;
  const lng =
    typeof record.lng === "number" && Number.isFinite(record.lng)
      ? record.lng
      : Number.NaN;

  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return undefined;
  }
  return { name, lat, lng };
}

function normalizeMonitors(value: unknown): SituationMonitorCustomMonitor[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: SituationMonitorCustomMonitor[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = normalizeName(record.name);
    const keywords = normalizeKeywords(record.keywords);
    if (!name || keywords.length === 0) {
      continue;
    }

    const idRaw = typeof record.id === "string" ? record.id.trim() : "";
    const id =
      idRaw.length > 0 ? idRaw.slice(0, 64) : `sm-${randomUUID().slice(0, 10)}`;

    const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
    const color = normalizeColor(record.color);
    const location = normalizeLocation(record.location);
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : Date.now();

    out.push({
      id,
      name,
      keywords,
      enabled,
      color,
      location,
      createdAt,
    });

    if (out.length >= MAX_MONITORS) {
      break;
    }
  }

  return out;
}

function normalizeLayoutItem(
  value: unknown,
): SituationMonitorLayoutItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.i === "string" ? record.i.trim().slice(0, 128) : "";
  if (!id) {
    return null;
  }

  const x =
    typeof record.x === "number" && Number.isFinite(record.x)
      ? Math.max(0, Math.round(record.x))
      : 0;
  const y =
    typeof record.y === "number" && Number.isFinite(record.y)
      ? Math.max(0, Math.round(record.y))
      : 0;
  const w =
    typeof record.w === "number" && Number.isFinite(record.w)
      ? Math.max(1, Math.round(record.w))
      : 1;
  const h =
    typeof record.h === "number" && Number.isFinite(record.h)
      ? Math.max(1, Math.round(record.h))
      : 1;

  const minW =
    typeof record.minW === "number" && Number.isFinite(record.minW)
      ? Math.max(1, Math.round(record.minW))
      : undefined;
  const minH =
    typeof record.minH === "number" && Number.isFinite(record.minH)
      ? Math.max(1, Math.round(record.minH))
      : undefined;
  const staticValue =
    typeof record.static === "boolean" ? record.static : undefined;

  return {
    i: id,
    x,
    y,
    w,
    h,
    ...(minW ? { minW } : {}),
    ...(minH ? { minH } : {}),
    ...(staticValue !== undefined ? { static: staticValue } : {}),
  };
}

function normalizeLayout(value: unknown): SituationMonitorLayout {
  const defaults: SituationMonitorLayout = { layouts: {}, visibility: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }
  const record = value as Record<string, unknown>;

  const layouts: SituationMonitorResponsiveLayouts = {};
  const rawLayouts = record.layouts;

  if (
    rawLayouts &&
    typeof rawLayouts === "object" &&
    !Array.isArray(rawLayouts)
  ) {
    const layoutRecord = rawLayouts as Record<string, unknown>;
    for (const breakpoint of SITUATION_MONITOR_LAYOUT_BREAKPOINTS) {
      const rawLayout = layoutRecord[breakpoint];
      if (!Array.isArray(rawLayout)) {
        continue;
      }

      const normalizedLayout = rawLayout
        .map((entry) => normalizeLayoutItem(entry))
        .filter((entry): entry is SituationMonitorLayoutItem => Boolean(entry))
        .slice(0, MAX_LAYOUT_ITEMS_PER_BREAKPOINT);

      if (normalizedLayout.length > 0) {
        layouts[breakpoint] = normalizedLayout;
      }
    }
  }

  if (!layouts.lg && Array.isArray(record.layout)) {
    const normalizedLegacyLayout = record.layout
      .map((entry) => normalizeLayoutItem(entry))
      .filter((entry): entry is SituationMonitorLayoutItem => Boolean(entry))
      .slice(0, MAX_LAYOUT_ITEMS_PER_BREAKPOINT);

    if (normalizedLegacyLayout.length > 0) {
      layouts.lg = normalizedLegacyLayout;
    }
  }

  const visibility: Record<string, boolean> = {};
  const rawVisibility = record.visibility;
  if (
    rawVisibility &&
    typeof rawVisibility === "object" &&
    !Array.isArray(rawVisibility)
  ) {
    for (const [key, val] of Object.entries(
      rawVisibility as Record<string, unknown>,
    )) {
      if (typeof val !== "boolean") {
        continue;
      }
      const normalizedKey = key.trim().slice(0, 128);
      if (!normalizedKey) {
        continue;
      }
      visibility[normalizedKey] = val;
      if (Object.keys(visibility).length >= MAX_VISIBILITY_KEYS) {
        break;
      }
    }
  }

  return { layouts, visibility };
}

function normalizeWindowHours(value: unknown): number {
  const raw = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(raw)) {
    return 24;
  }
  const allowed = new Set([6, 24, 72]);
  return allowed.has(raw) ? raw : 24;
}

function normalizeScope(value: unknown): SituationMonitorScope {
  return value === "tagged" ? "tagged" : "all";
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSettings(value: unknown): SituationMonitorSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      windowHours: 24,
      scope: "all",
      autoRefresh: true,
      resetLayoutOnPreset: false,
      translateToZh: false,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    windowHours: normalizeWindowHours(record.windowHours),
    scope: normalizeScope(record.scope),
    autoRefresh: normalizeBoolean(record.autoRefresh, true),
    resetLayoutOnPreset: normalizeBoolean(record.resetLayoutOnPreset, false),
    translateToZh: normalizeBoolean(record.translateToZh, false),
  };
}

const SPACETIME_TIMELINE_DEFAULT_SETTINGS: SpacetimeTimelineSettings = {
  authoritativeLock: true,
  requireCorroborated: true,
  sourceType: "authoritative",
  sortBy: "heat",
  minHeatScore: 0.7,
  minCredibilityScore: 48,
  timelineGranularity: "auto",
  speed: 2,
  syncStatusAutoRefresh: true,
} as const;

function normalizeSpacetimeTimelineSourceType(
  value: unknown,
): SpacetimeTimelineSourceType {
  return value === "all" ||
    value === "mixed" ||
    value === "blog" ||
    value === "authoritative"
    ? value
    : SPACETIME_TIMELINE_DEFAULT_SETTINGS.sourceType;
}

function normalizeSpacetimeTimelineSortBy(
  value: unknown,
): SpacetimeTimelineSortBy {
  return value === "latest" || value === "heat" || value === "credibility"
    ? value
    : SPACETIME_TIMELINE_DEFAULT_SETTINGS.sortBy;
}

function normalizeSpacetimeTimelineGranularity(
  value: unknown,
): SpacetimeTimelineGranularity {
  return value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "auto"
    ? value
    : SPACETIME_TIMELINE_DEFAULT_SETTINGS.timelineGranularity;
}

function clampFloat(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (numeric < min) {
    return min;
  }
  if (numeric > max) {
    return max;
  }
  return numeric;
}

function normalizeSpacetimeTimelineSettings(
  value: unknown,
): SpacetimeTimelineSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...SPACETIME_TIMELINE_DEFAULT_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  const authoritativeLock =
    typeof record.authoritativeLock === "boolean"
      ? record.authoritativeLock
      : SPACETIME_TIMELINE_DEFAULT_SETTINGS.authoritativeLock;
  const requireCorroborated =
    typeof record.requireCorroborated === "boolean"
      ? record.requireCorroborated
      : SPACETIME_TIMELINE_DEFAULT_SETTINGS.requireCorroborated;

  const sourceType = normalizeSpacetimeTimelineSourceType(record.sourceType);
  return {
    authoritativeLock,
    requireCorroborated,
    sourceType,
    sortBy: normalizeSpacetimeTimelineSortBy(record.sortBy),
    minHeatScore: clampFloat(
      record.minHeatScore,
      0,
      12,
      SPACETIME_TIMELINE_DEFAULT_SETTINGS.minHeatScore,
    ),
    minCredibilityScore: clampFloat(
      record.minCredibilityScore,
      0,
      100,
      SPACETIME_TIMELINE_DEFAULT_SETTINGS.minCredibilityScore,
    ),
    timelineGranularity: normalizeSpacetimeTimelineGranularity(
      record.timelineGranularity,
    ),
    speed: clampFloat(
      record.speed,
      0.25,
      16,
      SPACETIME_TIMELINE_DEFAULT_SETTINGS.speed,
    ),
    syncStatusAutoRefresh: normalizeBoolean(
      record.syncStatusAutoRefresh,
      SPACETIME_TIMELINE_DEFAULT_SETTINGS.syncStatusAutoRefresh,
    ),
  };
}

function normalizeNewsnowSourceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return NEWSNOW_SOURCE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function clampNewsnowInt(
  value: unknown,
  min: number,
  max: number,
  fallback = 0,
): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  if (raw < min) {
    return min;
  }
  if (raw > max) {
    return max;
  }
  return Math.round(raw);
}

function clampNewsnowFloat(
  value: unknown,
  min: number,
  max: number,
  fallback = 0,
): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  if (raw < min) {
    return min;
  }
  if (raw > max) {
    return max;
  }
  return raw;
}

function normalizeNewsnowSourceList(
  value: unknown,
  maxCount: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeNewsnowSourceId(entry);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxCount) {
      break;
    }
  }
  return out;
}

function normalizeNewsnowColumnOrders(
  value: unknown,
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const [column, rawList] of Object.entries(record)) {
    if (count >= MAX_NEWSNOW_COLUMNS) {
      break;
    }
    const normalizedColumn = normalizeNewsnowSourceId(column);
    if (!normalizedColumn) {
      continue;
    }
    const normalizedList = normalizeNewsnowSourceList(
      rawList,
      MAX_NEWSNOW_SOURCE_IDS,
    );
    if (normalizedList.length === 0) {
      continue;
    }
    out[normalizedColumn] = normalizedList;
    count += 1;
  }
  return out;
}

function normalizeNewsnowSourceAffinity(
  value: unknown,
): Record<string, NewsnowSourceAffinitySettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, NewsnowSourceAffinitySettings> = {};
  let count = 0;

  for (const [sourceId, rawAffinity] of Object.entries(record)) {
    if (count >= MAX_NEWSNOW_AFFINITIES) {
      break;
    }
    const normalizedSourceId = normalizeNewsnowSourceId(sourceId);
    if (!normalizedSourceId) {
      continue;
    }
    if (
      !rawAffinity ||
      typeof rawAffinity !== "object" ||
      Array.isArray(rawAffinity)
    ) {
      continue;
    }
    const affinity = rawAffinity as Record<string, unknown>;
    out[normalizedSourceId] = {
      score: clampNewsnowFloat(affinity.score, 0, 100, 0),
      openOriginalCount: clampNewsnowInt(
        affinity.openOriginalCount,
        0,
        1_000_000,
        0,
      ),
      openEventCount: clampNewsnowInt(affinity.openEventCount, 0, 1_000_000, 0),
      openItemCount: clampNewsnowInt(affinity.openItemCount, 0, 1_000_000, 0),
      refreshCount: clampNewsnowInt(affinity.refreshCount, 0, 1_000_000, 0),
      focusCount: clampNewsnowInt(affinity.focusCount, 0, 1_000_000, 0),
      accumulatedDwellMs: clampNewsnowInt(
        affinity.accumulatedDwellMs,
        0,
        365 * 24 * 60 * 60 * 1000,
        0,
      ),
      lastInteractedAt: clampNewsnowInt(
        affinity.lastInteractedAt,
        0,
        9_999_999_999_999,
        0,
      ),
    };
    count += 1;
  }

  return out;
}

function normalizeNewsnowSortMode(value: unknown): NewsnowSortMode {
  return value === "smart" || value === "personalized"
    ? "personalized"
    : "manual";
}

function normalizeNewsnowDensityMode(value: unknown): NewsnowDensityMode {
  return value === "comfortable" ? "comfortable" : "compact";
}

export function normalizeNewsnowUiSettings(value: unknown): NewsnowUiSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultNewsnowUiSettings();
  }

  const record = value as Record<string, unknown>;
  return {
    focusSources: normalizeNewsnowSourceList(
      record.focusSources,
      MAX_NEWSNOW_SOURCE_IDS,
    ),
    columnOrders: normalizeNewsnowColumnOrders(record.columnOrders),
    hideCrossSourceDuplicates: Boolean(record.hideCrossSourceDuplicates),
    sortMode: normalizeNewsnowSortMode(record.sortMode),
    densityMode: normalizeNewsnowDensityMode(record.densityMode),
    sourceAffinity: normalizeNewsnowSourceAffinity(record.sourceAffinity),
  };
}

function normalizeRssReaderSourceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().slice(0, 128);
  return normalized.length > 0 ? normalized : null;
}

function normalizeRssReaderSourceIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const normalized = normalizeRssReaderSourceId(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_RSS_READER_SOURCE_IDS) {
      break;
    }
  }

  return out;
}

function normalizeRssReaderLanguage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase().slice(0, 24);
  return normalized.length > 0 ? normalized : null;
}

function normalizeRssReaderLanguageFilters(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const normalized = normalizeRssReaderLanguage(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_RSS_READER_LANGUAGE_FILTERS) {
      break;
    }
  }

  return out;
}

function normalizeRssReaderTranslationProvider(
  value: unknown,
): RssReaderTranslationProvider {
  return value === "llm" ? "llm" : "deeplx";
}

function normalizeRssReaderTargetLanguage(value: unknown): string {
  if (typeof value !== "string") {
    return "zh-CN";
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 32) : "zh-CN";
}

export function normalizeRssReaderUiSettings(
  value: unknown,
): RssReaderUiSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultRssReaderUiSettings();
  }

  const record = value as Record<string, unknown>;
  return {
    selectedSourceIds: normalizeRssReaderSourceIds(record.selectedSourceIds),
    sourceLanguageFilters: normalizeRssReaderLanguageFilters(
      record.sourceLanguageFilters,
    ),
    translationEnabled: record.translationEnabled === true,
    translationProvider: normalizeRssReaderTranslationProvider(
      record.translationProvider,
    ),
    targetLanguage: normalizeRssReaderTargetLanguage(record.targetLanguage),
    showOriginalContent: record.showOriginalContent === true,
  };
}

@Injectable()
export class UserSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSituationMonitorUiSettings(
    orgId: string,
    userId: string,
  ): Promise<SituationMonitorUiSettingsResponse> {
    const records = await this.prisma.userSetting.findMany({
      where: {
        orgId,
        userId,
        key: {
          in: [
            KEY_SITUATION_MONITOR_MONITORS,
            KEY_SITUATION_MONITOR_LAYOUT,
            KEY_SITUATION_MONITOR_SETTINGS,
          ],
        },
      },
      select: { key: true, value: true, updatedAt: true },
    });

    const byKey = new Map<
      string,
      { value: Prisma.JsonValue; updatedAt: Date }
    >();
    for (const record of records) {
      byKey.set(record.key, {
        value: record.value,
        updatedAt: record.updatedAt,
      });
    }

    const monitorsRecord = byKey.get(KEY_SITUATION_MONITOR_MONITORS);
    const layoutRecord = byKey.get(KEY_SITUATION_MONITOR_LAYOUT);
    const settingsRecord = byKey.get(KEY_SITUATION_MONITOR_SETTINGS);

    return {
      version: 1,
      updatedAt: {
        ...(monitorsRecord
          ? { monitors: monitorsRecord.updatedAt.toISOString() }
          : {}),
        ...(layoutRecord
          ? { layout: layoutRecord.updatedAt.toISOString() }
          : {}),
        ...(settingsRecord
          ? { settings: settingsRecord.updatedAt.toISOString() }
          : {}),
      },
      monitors: monitorsRecord ? normalizeMonitors(monitorsRecord.value) : null,
      layout: layoutRecord ? normalizeLayout(layoutRecord.value) : null,
      settings: settingsRecord ? normalizeSettings(settingsRecord.value) : null,
    };
  }

  async updateSituationMonitorUiSettings(
    orgId: string,
    userId: string,
    input: {
      monitors?: unknown[];
      layout?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    },
  ): Promise<SituationMonitorUiSettingsResponse> {
    const operations: Promise<{
      key: string;
      value: Prisma.JsonValue;
      updatedAt: Date;
    }>[] = [];

    if (input.monitors !== undefined) {
      const monitors = normalizeMonitors(input.monitors);
      operations.push(
        this.upsert(
          orgId,
          userId,
          KEY_SITUATION_MONITOR_MONITORS,
          this.toPrismaJson(monitors),
        ),
      );
    }

    if (input.layout !== undefined) {
      const layout = normalizeLayout(input.layout);
      operations.push(
        this.upsert(
          orgId,
          userId,
          KEY_SITUATION_MONITOR_LAYOUT,
          this.toPrismaJson(layout),
        ),
      );
    }

    if (input.settings !== undefined) {
      const settings = normalizeSettings(input.settings);
      operations.push(
        this.upsert(
          orgId,
          userId,
          KEY_SITUATION_MONITOR_SETTINGS,
          this.toPrismaJson(settings),
        ),
      );
    }

    if (operations.length > 0) {
      await Promise.all(operations);
    }

    return this.getSituationMonitorUiSettings(orgId, userId);
  }

  async getWarMapUiSettings(
    orgId: string,
    userId: string,
  ): Promise<WarMapUiSettingsResponse> {
    const record = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: KEY_WAR_MAP_SETTINGS,
        },
      },
      select: { key: true, value: true, updatedAt: true },
    });

    return {
      version: 1,
      updatedAt: {
        ...(record ? { settings: record.updatedAt.toISOString() } : {}),
      },
      settings: record ? normalizeSharedWarMapSettings(record.value) : null,
    };
  }

  async updateWarMapUiSettings(
    orgId: string,
    userId: string,
    input: { settings?: Record<string, unknown> },
  ): Promise<WarMapUiSettingsResponse> {
    if (input.settings !== undefined) {
      const settings = normalizeSharedWarMapSettings(input.settings);
      await this.upsert(
        orgId,
        userId,
        KEY_WAR_MAP_SETTINGS,
        this.toPrismaJson(settings),
      );
    }

    return this.getWarMapUiSettings(orgId, userId);
  }

  async getSpacetimeTimelineUiSettings(
    orgId: string,
    userId: string,
  ): Promise<SpacetimeTimelineUiSettingsResponse> {
    const record = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: KEY_SPACETIME_TIMELINE_SETTINGS,
        },
      },
      select: { key: true, value: true, updatedAt: true },
    });

    return {
      version: 1,
      updatedAt: {
        ...(record ? { settings: record.updatedAt.toISOString() } : {}),
      },
      settings: record
        ? normalizeSpacetimeTimelineSettings(record.value)
        : null,
    };
  }

  async updateSpacetimeTimelineUiSettings(
    orgId: string,
    userId: string,
    input: { settings?: Record<string, unknown> },
  ): Promise<SpacetimeTimelineUiSettingsResponse> {
    if (input.settings !== undefined) {
      const settings = normalizeSpacetimeTimelineSettings(input.settings);
      await this.upsert(
        orgId,
        userId,
        KEY_SPACETIME_TIMELINE_SETTINGS,
        this.toPrismaJson(settings),
      );
    }

    return this.getSpacetimeTimelineUiSettings(orgId, userId);
  }

  async getNewsnowUiSettings(
    orgId: string,
    userId: string,
  ): Promise<NewsnowUiSettingsResponse> {
    const record = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: KEY_NEWSNOW_SETTINGS,
        },
      },
      select: { key: true, value: true, updatedAt: true },
    });

    return {
      version: 1,
      updatedAt: {
        ...(record ? { settings: record.updatedAt.toISOString() } : {}),
      },
      settings: record ? normalizeNewsnowUiSettings(record.value) : null,
    };
  }

  async updateNewsnowUiSettings(
    orgId: string,
    userId: string,
    input: { settings?: Record<string, unknown> },
  ): Promise<NewsnowUiSettingsResponse> {
    if (input.settings !== undefined) {
      const settings = normalizeNewsnowUiSettings(input.settings);
      await this.upsert(
        orgId,
        userId,
        KEY_NEWSNOW_SETTINGS,
        this.toPrismaJson(settings),
      );
    }

    return this.getNewsnowUiSettings(orgId, userId);
  }

  async getRssReaderUiSettings(
    orgId: string,
    userId: string,
  ): Promise<RssReaderUiSettingsResponse> {
    const record = await this.prisma.userSetting.findUnique({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key: KEY_RSS_READER_SETTINGS,
        },
      },
      select: { key: true, value: true, updatedAt: true },
    });

    return {
      version: 1,
      updatedAt: {
        ...(record ? { settings: record.updatedAt.toISOString() } : {}),
      },
      settings: record ? normalizeRssReaderUiSettings(record.value) : null,
    };
  }

  async updateRssReaderUiSettings(
    orgId: string,
    userId: string,
    input: { settings?: Record<string, unknown> },
  ): Promise<RssReaderUiSettingsResponse> {
    if (input.settings !== undefined) {
      const settings = normalizeRssReaderUiSettings(input.settings);
      await this.upsert(
        orgId,
        userId,
        KEY_RSS_READER_SETTINGS,
        this.toPrismaJson(settings),
      );
    }

    return this.getRssReaderUiSettings(orgId, userId);
  }

  private async upsert(
    orgId: string,
    userId: string,
    key: string,
    value: Prisma.InputJsonValue,
  ) {
    const record = await this.prisma.userSetting.upsert({
      where: {
        orgId_userId_key: {
          orgId,
          userId,
          key,
        },
      },
      update: {
        value,
      },
      create: {
        orgId,
        userId,
        key,
        value,
      },
      select: {
        key: true,
        value: true,
        updatedAt: true,
      },
    });
    return record;
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}

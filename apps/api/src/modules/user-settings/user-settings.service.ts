import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../config/prisma.service";

const KEY_SITUATION_MONITOR_MONITORS = "ui:situation-monitor:monitors:v1";
const KEY_SITUATION_MONITOR_LAYOUT = "ui:situation-monitor:layout:v1";
const KEY_SITUATION_MONITOR_SETTINGS = "ui:situation-monitor:settings:v1";
const KEY_WAR_MAP_SETTINGS = "ui:war-map:settings:v1";

const MAX_MONITORS = 20;
const MAX_LAYOUT_ITEMS = 120;
const MAX_VISIBILITY_KEYS = 64;

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

export type WarMapLayerId =
  | "hotspots"
  | "conflictZones"
  | "chokepoints"
  | "cableLandings"
  | "nuclearSites"
  | "militaryBases"
  | "monitors";

export type WarMapLayerVisibility = Record<WarMapLayerId, boolean>;

export interface WarMapSettings {
  layerVisibility: WarMapLayerVisibility;
}

export interface WarMapUiSettingsResponse {
  version: 1;
  updatedAt: {
    settings?: string;
  };
  settings: WarMapSettings | null;
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

export interface SituationMonitorLayout {
  layout: SituationMonitorLayoutItem[];
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
  if (/^#[0-9a-fA-F]{6}$/.test(normalized) || /^#[0-9a-fA-F]{3}$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  return undefined;
}

function normalizeLocation(value: unknown): SituationMonitorCustomMonitor["location"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const name = normalizeName(record.name);
  const lat = typeof record.lat === "number" && Number.isFinite(record.lat) ? record.lat : Number.NaN;
  const lng = typeof record.lng === "number" && Number.isFinite(record.lng) ? record.lng : Number.NaN;

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
    const id = idRaw.length > 0 ? idRaw.slice(0, 64) : `sm-${randomUUID().slice(0, 10)}`;

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

function normalizeLayoutItem(value: unknown): SituationMonitorLayoutItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.i === "string" ? record.i.trim().slice(0, 128) : "";
  if (!id) {
    return null;
  }

  const x = typeof record.x === "number" && Number.isFinite(record.x) ? Math.max(0, Math.round(record.x)) : 0;
  const y = typeof record.y === "number" && Number.isFinite(record.y) ? Math.max(0, Math.round(record.y)) : 0;
  const w = typeof record.w === "number" && Number.isFinite(record.w) ? Math.max(1, Math.round(record.w)) : 1;
  const h = typeof record.h === "number" && Number.isFinite(record.h) ? Math.max(1, Math.round(record.h)) : 1;

  const minW =
    typeof record.minW === "number" && Number.isFinite(record.minW) ? Math.max(1, Math.round(record.minW)) : undefined;
  const minH =
    typeof record.minH === "number" && Number.isFinite(record.minH) ? Math.max(1, Math.round(record.minH)) : undefined;
  const staticValue = typeof record.static === "boolean" ? record.static : undefined;

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
  const defaults: SituationMonitorLayout = { layout: [], visibility: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }
  const record = value as Record<string, unknown>;

  const rawLayout = record.layout;
  const layout = Array.isArray(rawLayout)
    ? rawLayout
        .map((entry) => normalizeLayoutItem(entry))
        .filter((entry): entry is SituationMonitorLayoutItem => Boolean(entry))
        .slice(0, MAX_LAYOUT_ITEMS)
    : [];

  const visibility: Record<string, boolean> = {};
  const rawVisibility = record.visibility;
  if (rawVisibility && typeof rawVisibility === "object" && !Array.isArray(rawVisibility)) {
    for (const [key, val] of Object.entries(rawVisibility as Record<string, unknown>)) {
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

  return { layout, visibility };
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
  return value === "all" ? "all" : "tagged";
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSettings(value: unknown): SituationMonitorSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      windowHours: 24,
      scope: "tagged",
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

const WAR_MAP_DEFAULT_LAYER_VISIBILITY: WarMapLayerVisibility = {
  hotspots: true,
  conflictZones: true,
  chokepoints: false,
  cableLandings: false,
  nuclearSites: false,
  militaryBases: false,
  monitors: true,
} as const;

function normalizeWarMapSettings(value: unknown): WarMapSettings {
  const defaults: WarMapSettings = { layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY } };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }
  const record = value as Record<string, unknown>;
  const rawVisibility =
    record.layerVisibility && typeof record.layerVisibility === "object" && !Array.isArray(record.layerVisibility)
      ? (record.layerVisibility as Record<string, unknown>)
      : record;

  const next: WarMapLayerVisibility = { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY };
  for (const key of Object.keys(WAR_MAP_DEFAULT_LAYER_VISIBILITY) as WarMapLayerId[]) {
    const raw = rawVisibility[key];
    if (typeof raw === "boolean") {
      next[key] = raw;
    }
  }
  return { layerVisibility: next };
}

@Injectable()
export class UserSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSituationMonitorUiSettings(orgId: string, userId: string): Promise<SituationMonitorUiSettingsResponse> {
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

    const byKey = new Map<string, { value: Prisma.JsonValue; updatedAt: Date }>();
    for (const record of records) {
      byKey.set(record.key, { value: record.value, updatedAt: record.updatedAt });
    }

    const monitorsRecord = byKey.get(KEY_SITUATION_MONITOR_MONITORS);
    const layoutRecord = byKey.get(KEY_SITUATION_MONITOR_LAYOUT);
    const settingsRecord = byKey.get(KEY_SITUATION_MONITOR_SETTINGS);

    return {
      version: 1,
      updatedAt: {
        ...(monitorsRecord ? { monitors: monitorsRecord.updatedAt.toISOString() } : {}),
        ...(layoutRecord ? { layout: layoutRecord.updatedAt.toISOString() } : {}),
        ...(settingsRecord ? { settings: settingsRecord.updatedAt.toISOString() } : {}),
      },
      monitors: monitorsRecord ? normalizeMonitors(monitorsRecord.value) : null,
      layout: layoutRecord ? normalizeLayout(layoutRecord.value) : null,
      settings: settingsRecord ? normalizeSettings(settingsRecord.value) : null,
    };
  }

  async updateSituationMonitorUiSettings(
    orgId: string,
    userId: string,
    input: { monitors?: unknown[]; layout?: Record<string, unknown>; settings?: Record<string, unknown> },
  ): Promise<SituationMonitorUiSettingsResponse> {
    const operations: Promise<{ key: string; value: Prisma.JsonValue; updatedAt: Date }>[] = [];

    if (input.monitors !== undefined) {
      const monitors = normalizeMonitors(input.monitors);
      operations.push(
        this.upsert(orgId, userId, KEY_SITUATION_MONITOR_MONITORS, this.toPrismaJson(monitors)),
      );
    }

    if (input.layout !== undefined) {
      const layout = normalizeLayout(input.layout);
      operations.push(this.upsert(orgId, userId, KEY_SITUATION_MONITOR_LAYOUT, this.toPrismaJson(layout)));
    }

    if (input.settings !== undefined) {
      const settings = normalizeSettings(input.settings);
      operations.push(
        this.upsert(orgId, userId, KEY_SITUATION_MONITOR_SETTINGS, this.toPrismaJson(settings)),
      );
    }

    if (operations.length > 0) {
      await Promise.all(operations);
    }

    return this.getSituationMonitorUiSettings(orgId, userId);
  }

  async getWarMapUiSettings(orgId: string, userId: string): Promise<WarMapUiSettingsResponse> {
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
      settings: record ? normalizeWarMapSettings(record.value) : null,
    };
  }

  async updateWarMapUiSettings(
    orgId: string,
    userId: string,
    input: { settings?: Record<string, unknown> },
  ): Promise<WarMapUiSettingsResponse> {
    if (input.settings !== undefined) {
      const settings = normalizeWarMapSettings(input.settings);
      await this.upsert(orgId, userId, KEY_WAR_MAP_SETTINGS, this.toPrismaJson(settings));
    }

    return this.getWarMapUiSettings(orgId, userId);
  }

  private async upsert(orgId: string, userId: string, key: string, value: Prisma.InputJsonValue) {
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

"use client";

import { nanoid } from "nanoid";
import { create } from "zustand";

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

export interface SituationMonitorMonitorMatch {
  monitorId: string;
  monitorName: string;
  matchedKeywords: string[];
  item: {
    title: string;
    titleZh?: string;
    itemMetaId?: string;
    link: string;
    source: string;
    timestamp: number;
    category?: string;
    summary?: string;
    summaryZh?: string;
    keyPoints?: string[];
    keyPointsZh?: string[];
    topics?: string[];
  };
}

const MAX_MONITORS = 20;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeywords(raw: string[]): string[] {
  const normalized = raw
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 30);

  return Array.from(new Set(normalized));
}

function normalizeName(value: string) {
  return value.trim().slice(0, 64);
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
  const name = typeof record.name === "string" ? record.name.trim().slice(0, 64) : "";
  const latRaw = record.lat;
  const lngRaw = record.lng;
  const lat = typeof latRaw === "number" && Number.isFinite(latRaw) ? latRaw : Number.NaN;
  const lng = typeof lngRaw === "number" && Number.isFinite(lngRaw) ? lngRaw : Number.NaN;

  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return undefined;
  }
  return { name, lat, lng };
}

function buildSearchText(item: SituationMonitorMonitorMatch["item"]) {
  const titleZh = typeof item.titleZh === "string" ? item.titleZh : "";
  const summary = typeof item.summary === "string" ? item.summary : "";
  const summaryZh = typeof item.summaryZh === "string" ? item.summaryZh : "";
  const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints.join(" ") : "";
  const keyPointsZh = Array.isArray(item.keyPointsZh) ? item.keyPointsZh.join(" ") : "";
  const topics = Array.isArray(item.topics) ? item.topics.join(" ") : "";
  return `${item.title} ${titleZh} ${item.source} ${summary} ${summaryZh} ${keyPoints} ${keyPointsZh} ${topics}`.toLowerCase();
}

export interface SituationMonitorMonitorsState {
  monitors: SituationMonitorCustomMonitor[];
  matches: SituationMonitorMonitorMatch[];
  matchCounts: Record<string, number>;
  hydrateFromRemote: (monitors: unknown) => void;
  addMonitor: (input: {
    name: string;
    keywords: string[];
    color?: string | null;
    location?: SituationMonitorCustomMonitor["location"] | null;
  }) => SituationMonitorCustomMonitor | null;
  updateMonitor: (
    id: string,
    patch: Partial<Pick<SituationMonitorCustomMonitor, "name" | "keywords" | "enabled">> & {
      color?: string | null;
      location?: SituationMonitorCustomMonitor["location"] | null;
    },
  ) => boolean;
  deleteMonitor: (id: string) => void;
  toggleMonitor: (id: string) => void;
  scan: (items: Array<SituationMonitorMonitorMatch["item"]>) => void;
  clearMatches: () => void;
  reset: () => void;
}

export const useSituationMonitorMonitorsStore = create<SituationMonitorMonitorsState>((set, get) => ({
  monitors: [],
  matches: [],
  matchCounts: {},
  hydrateFromRemote: (monitors) =>
    set(() => ({
      monitors: normalizeStoredMonitors(monitors),
      matches: [],
      matchCounts: {},
    })),
  addMonitor: (input) => {
    const name = normalizeName(input.name);
    const keywords = normalizeKeywords(input.keywords);
    if (!name || keywords.length === 0) {
      return null;
    }

    const color = normalizeColor(input.color);
    const location = normalizeLocation(input.location);

    const state = get();
    if (state.monitors.length >= MAX_MONITORS) {
      return null;
    }

    const monitor: SituationMonitorCustomMonitor = {
      id: `sm-${nanoid(10)}`,
      name,
      keywords,
      enabled: true,
      color,
      location,
      createdAt: Date.now(),
    };

    set((prev) => ({
      monitors: [...prev.monitors, monitor],
    }));

    return monitor;
  },
  updateMonitor: (id, patch) => {
    let updated = false;
    set((state) => {
      const next = state.monitors.map((monitor) => {
        if (monitor.id !== id) {
          return monitor;
        }
        updated = true;
        const nextName = patch.name !== undefined ? normalizeName(patch.name) : monitor.name;
        const nextKeywords =
          patch.keywords !== undefined ? normalizeKeywords(patch.keywords) : monitor.keywords;
        const nextColor = patch.color !== undefined ? normalizeColor(patch.color) : monitor.color;
        const nextLocation = patch.location !== undefined ? normalizeLocation(patch.location) : monitor.location;
        return {
          ...monitor,
          name: nextName,
          keywords: nextKeywords,
          enabled: patch.enabled ?? monitor.enabled,
          color: nextColor,
          location: nextLocation,
        };
      });
      return { monitors: next };
    });
    return updated;
  },
  deleteMonitor: (id) =>
    set((state) => ({
      monitors: state.monitors.filter((monitor) => monitor.id !== id),
      matches: state.matches.filter((match) => match.monitorId !== id),
      matchCounts: Object.fromEntries(Object.entries(state.matchCounts).filter(([key]) => key !== id)),
    })),
  toggleMonitor: (id) =>
    set((state) => ({
      monitors: state.monitors.map((monitor) =>
        monitor.id === id ? { ...monitor, enabled: !monitor.enabled } : monitor,
      ),
    })),
  scan: (items) => {
    const state = get();
    const enabled = state.monitors.filter((monitor) => monitor.enabled);
    if (enabled.length === 0 || items.length === 0) {
      set({ matches: [], matchCounts: {} });
      return;
    }

    const matches: SituationMonitorMonitorMatch[] = [];
    const matchCounts: Record<string, number> = {};

    const candidates = items
      .filter((item) => Boolean(item.title && item.link))
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 500)
      .map((item) => ({
        item,
        haystack: buildSearchText(item),
      }));

    for (const monitor of enabled) {
      const matchers = monitor.keywords
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((display) => {
          const normalized = display.toLowerCase();
          const shortAscii = normalized.length <= 3 && /^[a-z0-9]+$/.test(normalized);
          return {
            display,
            normalized,
            regex: shortAscii ? new RegExp(`\\b${escapeRegex(normalized)}\\b`) : null,
          };
        });

      if (matchers.length === 0) {
        continue;
      }

      let count = 0;
      for (const candidate of candidates) {
        const matchedKeywords: string[] = [];
        for (const matcher of matchers) {
          const ok = matcher.regex
            ? matcher.regex.test(candidate.haystack)
            : candidate.haystack.includes(matcher.normalized);
          if (!ok) {
            continue;
          }
          matchedKeywords.push(matcher.display);
          if (matchedKeywords.length >= 6) {
            break;
          }
        }

        if (matchedKeywords.length === 0) {
          continue;
        }
        matches.push({
          monitorId: monitor.id,
          monitorName: monitor.name,
          matchedKeywords,
          item: candidate.item,
        });
        count += 1;
      }

      matchCounts[monitor.id] = count;
    }

    set({
      matches: matches.sort((a, b) => b.item.timestamp - a.item.timestamp).slice(0, 200),
      matchCounts,
    });
  },
  clearMatches: () => set({ matches: [], matchCounts: {} }),
  reset: () => set({ monitors: [], matches: [], matchCounts: {} }),
}));

function normalizeStoredMonitors(value: unknown): SituationMonitorCustomMonitor[] {
  const stored = Array.isArray(value) ? value : [];
  return stored
    .filter((monitor): monitor is SituationMonitorCustomMonitor => !!monitor && typeof monitor === "object")
    .map((monitor) => ({
      id: typeof monitor.id === "string" ? monitor.id : `sm-${nanoid(10)}`,
      name: normalizeName(typeof monitor.name === "string" ? monitor.name : ""),
      keywords: normalizeKeywords(Array.isArray(monitor.keywords) ? monitor.keywords : []),
      enabled: typeof monitor.enabled === "boolean" ? monitor.enabled : true,
      color: normalizeColor((monitor as { color?: unknown }).color),
      location: normalizeLocation((monitor as { location?: unknown }).location),
      createdAt: typeof monitor.createdAt === "number" ? monitor.createdAt : Date.now()
    }))
    .filter((monitor) => monitor.name.length > 0 && monitor.keywords.length > 0)
    .slice(0, MAX_MONITORS);
}

"use client";

/**
 * intel-feed.ts — G6 情报图层的数据订阅。
 *
 * 用 `@tanstack/react-query` + `apiClient` 拉取最近 72 小时的战争地图事件与
 * 新闻标记，转成 GeoJSONL 后写入对应 GEV 图层。只有对应图层启用时才请求。
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
  buildWarMapBaseRequestParams,
  normalizeWarMapEventsResponse,
  normalizeWarMapNewsMarkersResponse,
} from "@/app/(app)/dashboard/charts/war-map/war-map-data";
import { createApiClient } from "@/lib/api-client";
import {
  eventsToGeojsonl,
  newsMarkersToGeojsonl,
} from "@/lib/globe/intel-geojson";
import type { GlobeRuntime } from "@/lib/globe/runtime";
import { normalizeLocale } from "@/lib/i18n";

const INTEL_WINDOW_MS = 72 * 60 * 60 * 1000;
const REFETCH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_TIME_MS = 60 * 1000;

interface IntelEnabledState {
  events: boolean;
  news: boolean;
}

/** 订阅 dataManager，只在对应情报图层启用时才允许请求。 */
function useIntelEnabled(runtime: GlobeRuntime | null): IntelEnabledState {
  const store = useMemo(() => {
    if (!runtime) {
      return {
        subscribe: () => () => undefined,
        getSnapshot: () => "0:0",
      };
    }
    const manager = runtime.dataManager;
    return {
      subscribe: (callback: () => void) => manager.subscribe(callback),
      getSnapshot: () =>
        `${manager.isEnabled("newwei-events") ? 1 : 0}:${
          manager.isEnabled("newwei-news") ? 1 : 0
        }`,
    };
  }, [runtime]);

  const signature = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return {
    events: signature.startsWith("1"),
    news: signature.endsWith("1"),
  };
}

function currentWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - INTEL_WINDOW_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * 拉取情报数据并写入运行时。调用方应在 `<GlobeRuntimeProvider>` 内挂载一个
 * 只负责调用本 hook 的组件。
 */
export function useIntelFeed(runtime: GlobeRuntime | null): void {
  const { data: session } = useSession();
  const { i18n } = useTranslation();
  const locale = normalizeLocale(i18n.language);
  const enabled = useIntelEnabled(runtime);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const canLoadEvents = Boolean(runtime && enabled.events);
  const canLoadNews = Boolean(runtime && enabled.news);

  const eventsQuery = useQuery({
    queryKey: ["globe", "intel", "events"],
    queryFn: async () => {
      const { start, end } = currentWindow();
      const response = await apiClient.get("dashboard/war-map/events", {
        params: buildWarMapBaseRequestParams({ start, end, cluster: false }),
      });
      return normalizeWarMapEventsResponse(response.data);
    },
    enabled: canLoadEvents,
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    placeholderData: (previous) => previous,
  });

  const newsQuery = useQuery({
    queryKey: ["globe", "intel", "news"],
    queryFn: async () => {
      const { start, end } = currentWindow();
      const response = await apiClient.get("dashboard/war-map/news-markers", {
        params: buildWarMapBaseRequestParams({ start, end, cluster: false }),
      });
      return normalizeWarMapNewsMarkersResponse(response.data);
    },
    enabled: canLoadNews,
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!runtime || !eventsQuery.data) return;
    const geojsonl = eventsToGeojsonl(eventsQuery.data.events, { locale });
    void runtime.actions
      .setIntelData({ eventsGeojsonl: geojsonl })
      .catch(() => undefined);
  }, [runtime, eventsQuery.data, locale]);

  useEffect(() => {
    if (!runtime || !newsQuery.data) return;
    const geojsonl = newsMarkersToGeojsonl(newsQuery.data.markers, { locale });
    void runtime.actions
      .setIntelData({ newsGeojsonl: geojsonl })
      .catch(() => undefined);
  }, [runtime, newsQuery.data, locale]);
}

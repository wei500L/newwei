import type { WarMapClusterPartition } from "./war-map-clustering";
import type {
  RenderableWarMapEvent,
  RenderableWarMapNewsMarker,
  RenderableWarMapTransportSelection,
  SelectedInspector,
} from "./war-map-overlay-model";

/** Inspector 选中键构造（event/news 单点、聚类与运输对象）。 */
export function toClusterSelectionKey(
  kind: "event" | "news",
  memberKey: string,
): string {
  return `${kind}-cluster:${memberKey}`;
}

export function toSingleSelectionKey(kind: "event" | "news", id: string): string {
  return `${kind}:${id}`;
}

export function toTransportSelectionKey(
  kind: "aircraft" | "vessel",
  objectKey: string,
): string {
  return `transport:${kind}:${objectKey}`;
}

/** 运输选择条目：展示模型 + 定位信息（flights/AIS 派生）。 */
export interface WarMapTransportSelectionEntry
  extends RenderableWarMapTransportSelection {
  lat: number;
  lng: number;
  selectionKey: string;
}

export interface ResolveWarMapSelectedInspectorInput {
  selectedInspectorKey: string | null;
  clusteredEvents: WarMapClusterPartition<RenderableWarMapEvent>;
  clusteredNews: WarMapClusterPartition<RenderableWarMapNewsMarker>;
  rawEvents: RenderableWarMapEvent[];
  rawNewsMarkers: RenderableWarMapNewsMarker[];
  transportSelections: WarMapTransportSelectionEntry[];
}

/**
 * 由选中键解析 Inspector 内容（纯函数，FE-批4A）。
 *
 * 查找顺序与 zoomTarget 契约（与迁移前行为一致）：
 * 1. event 聚类（zoomTarget 8）；
 * 2. news 聚类（zoomTarget 9）；
 * 3. event 单点（zoomTarget 7）；
 * 4. news 单点（zoomTarget 8）；
 * 5. 运输对象 flight/vessel（zoomTarget 8）；
 * 未命中返回 null（调用方据此清理选中键）。
 */
export function resolveWarMapSelectedInspector(
  input: ResolveWarMapSelectedInspectorInput,
): SelectedInspector | null {
  const {
    selectedInspectorKey,
    clusteredEvents,
    clusteredNews,
    rawEvents,
    rawNewsMarkers,
    transportSelections,
  } = input;
  if (!selectedInspectorKey) {
    return null;
  }

  const eventCluster = clusteredEvents.clusters.find(
    (cluster) =>
      toClusterSelectionKey("event", cluster.memberKey) === selectedInspectorKey,
  );
  if (eventCluster) {
    return {
      key: selectedInspectorKey,
      kind: "event-cluster",
      lat: eventCluster.lat,
      lng: eventCluster.lng,
      count: eventCluster.count,
      zoomTarget: 8,
      members: eventCluster.members,
    };
  }

  const newsCluster = clusteredNews.clusters.find(
    (cluster) =>
      toClusterSelectionKey("news", cluster.memberKey) === selectedInspectorKey,
  );
  if (newsCluster) {
    return {
      key: selectedInspectorKey,
      kind: "news-cluster",
      lat: newsCluster.lat,
      lng: newsCluster.lng,
      count: newsCluster.count,
      zoomTarget: 9,
      members: newsCluster.members,
    };
  }

  const event = rawEvents.find(
    (entry) => toSingleSelectionKey("event", entry.id) === selectedInspectorKey,
  );
  if (event) {
    return {
      key: selectedInspectorKey,
      kind: "event",
      lat: event.lat,
      lng: event.lng,
      zoomTarget: 7,
      item: event,
    };
  }

  const newsItem = rawNewsMarkers.find(
    (entry) => toSingleSelectionKey("news", entry.id) === selectedInspectorKey,
  );
  if (newsItem) {
    return {
      key: selectedInspectorKey,
      kind: "news",
      lat: newsItem.lat,
      lng: newsItem.lng,
      zoomTarget: 8,
      item: newsItem,
    };
  }

  const transport = transportSelections.find(
    (entry) => entry.selectionKey === selectedInspectorKey,
  );
  if (transport) {
    return {
      key: selectedInspectorKey,
      kind: transport.transportKind === "aircraft" ? "flight" : "vessel",
      lat: transport.lat,
      lng: transport.lng,
      zoomTarget: 8,
      item: transport,
    };
  }

  return null;
}

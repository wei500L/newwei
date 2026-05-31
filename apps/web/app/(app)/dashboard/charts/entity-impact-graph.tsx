"use client";

import { IdcardOutlined, WarningOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Drawer,
  Segmented,
  Skeleton,
  Slider,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { RequestErrorBanner } from "@/components/request-error-banner";
import {
  useEntityImpactGraphSettingsQuery,
  useKnowledgeEntityByNameLazyQuery,
} from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { usePendingAction } from "@/hooks/use-pending-action";
import {
  useEntityImpactGraph,
  type EntityImpactLink,
} from "@/hooks/useEntityImpactGraph";
import { formatDashboardWindowLabel } from "@/lib/dashboard-time";
import {
  buildEntityGraphConnectionMap,
  ENTITY_GRAPH_DEFAULT_CATEGORIES,
  filterEntityGraphData,
  normalizeEntityGraphCategory,
  normalizeEntityGraphEdgeType,
  resolveEntityGraphForce,
  resolveEntityGraphNodeSize,
  sanitizeEntityGraphLinks,
  selectEntityGraphLabelNodeIds,
  type EntityGraphEdgeType,
  type EntityGraphLabelDensity,
} from "@/lib/entity-impact-graph";
import { useDashboardRangeStore } from "@/store/time-range";

const { Text } = Typography;

const EDGE_TYPE_OPTIONS: EntityGraphEdgeType[] = [
  "coOccurrence",
  "correlation",
];

const CATEGORY_CONFIG: Record<
  string,
  { color: string; symbol: string; index: number }
> = {
  person: { color: "#2f6ce5", symbol: "circle", index: 0 },
  organization: { color: "#10b981", symbol: "rect", index: 1 },
  stock: { color: "#f59e0b", symbol: "diamond", index: 2 },
  commodity: { color: "#8b5cf6", symbol: "triangle", index: 3 },
};

const DEFAULT_CATEGORY = { color: "#64748b", symbol: "circle", index: 4 };

const resolveCategoryList = (input: string[] | undefined) => {
  const normalized = (input ?? []).map(normalizeEntityGraphCategory);
  const allowed = new Set(ENTITY_GRAPH_DEFAULT_CATEGORIES);
  const deduped = Array.from(new Set(normalized)).filter((entry) =>
    allowed.has(entry),
  );
  return deduped.length > 0 ? deduped : [...ENTITY_GRAPH_DEFAULT_CATEGORIES];
};

const getCategoryConfig = (type: string) =>
  CATEGORY_CONFIG[normalizeEntityGraphCategory(type)] ?? DEFAULT_CATEGORY;

const resolveKnowledgeEntityTypeForImpactNode = (type: string) => {
  const normalized = normalizeEntityGraphCategory(type);
  if (normalized === "stock") {
    return "instrument";
  }
  if (normalized === "commodity" || normalized === "person") {
    return normalized;
  }
  return undefined;
};

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function EntityImpactGraph() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const { data: session, status: sessionStatus } = useSession();
  const authenticated = sessionStatus === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadDashboards = permissions.includes("dashboards.read");
  const { range, start, end } = useDashboardRangeStore();
  const windowLabel = formatDashboardWindowLabel(start, end);

  const containerRef = useRef<HTMLDivElement>(null);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    nodeName: string;
  } | null>(null);

  const [minConfidence, setMinConfidence] = useState(0.5);
  const [confidenceDraft, setConfidenceDraft] = useState(0.5);
  const [minCorrelation, setMinCorrelation] = useState(0.3);
  const [minCoOccurrence, setMinCoOccurrence] = useState(2);
  const [maxNodes, setMaxNodes] = useState(100);
  const [queryCategories, setQueryCategories] = useState<string[]>([
    ...ENTITY_GRAPH_DEFAULT_CATEGORIES,
  ]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([
    ...ENTITY_GRAPH_DEFAULT_CATEGORIES,
  ]);
  const [selectedEdgeTypes, setSelectedEdgeTypes] =
    useState<EntityGraphEdgeType[]>(EDGE_TYPE_OPTIONS);
  const [labelDensity, setLabelDensity] =
    useState<EntityGraphLabelDensity>("compact");
  const [settingsApplied, setSettingsApplied] = useState(false);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [graphRenderSeed, setGraphRenderSeed] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  const {
    data: settingsData,
    loading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings,
  } = useEntityImpactGraphSettingsQuery({
    fetchPolicy: "cache-and-network",
    skip: !authenticated || !canReadDashboards,
  });
  const { pending: refreshingSettings, run: refreshSettings } = usePendingAction(
    () => refetchSettings(),
  );
  const [resolveKnowledgeEntityByName, { loading: resolvingEntityCard }] =
    useKnowledgeEntityByNameLazyQuery({
      fetchPolicy: "network-only",
    });

  const settings = settingsData?.entityImpactGraphSettings;
  const enabled = settings?.enabled ?? true;
  const defaultMinConfidence = settings?.minEntityConfidence ?? 0.5;

  useEffect(() => {
    if (settings && !settingsHydrated) {
      const categoriesFromSettings = resolveCategoryList(settings.categories);
      setMinConfidence(settings.minEntityConfidence);
      setConfidenceDraft(settings.minEntityConfidence);
      setMinCorrelation(settings.minCorrelation);
      setMinCoOccurrence(settings.minCoOccurrence);
      setMaxNodes(settings.maxNodes);
      setQueryCategories(categoriesFromSettings);
      setSelectedCategories(categoriesFromSettings);
      setSettingsApplied(true);
      setSettingsHydrated(true);
      return;
    }
    if (!settingsLoading && !settingsError && !settingsApplied) {
      setSettingsApplied(true);
    }
  }, [
    settings,
    settingsApplied,
    settingsError,
    settingsHydrated,
    settingsLoading,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const sync = () => {
      setIsMobile(window.innerWidth < 768);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("resize", sync);
    };
  }, []);

  const { nodes, links, metadata, loading, error, refetch, hasData } =
    useEntityImpactGraph({
      minConfidence,
      minCorrelation,
      minCoOccurrence,
      maxNodes,
      categories: queryCategories,
      skip:
        !authenticated ||
        !canReadDashboards ||
        enabled === false ||
        !settingsApplied,
    });
  const { pending: refreshingGraph, run: refreshGraph } = usePendingAction(
    () => refetch(),
  );

  const emptyMessage = t("dashboard.dataEmpty", { defaultValue: "No data" });

  const filteredGraph = useMemo(
    () =>
      filterEntityGraphData(
        nodes,
        links,
        selectedCategories,
        selectedEdgeTypes,
      ),
    [links, nodes, selectedCategories, selectedEdgeTypes],
  );

  const visibleNodes = filteredGraph.nodes;
  const visibleLinks = filteredGraph.links;

  const visibleNodeIdSet = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes],
  );

  const visibleNodeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of visibleNodes) {
      const normalizedId = node.id.trim().toLowerCase();
      if (normalizedId && !map.has(normalizedId)) {
        map.set(normalizedId, node.id);
      }
      const normalized = node.name.trim().toLowerCase();
      if (normalized && !map.has(normalized)) {
        map.set(normalized, node.id);
      }
    }
    return map;
  }, [visibleNodes]);

  const safeLinks = useMemo(() => {
    return sanitizeEntityGraphLinks<EntityImpactLink>(visibleLinks, {
      nodeIds: visibleNodeIdSet,
      nodeIdByNormalizedName: visibleNodeNameMap,
    });
  }, [visibleLinks, visibleNodeIdSet, visibleNodeNameMap]);

  const connectionMap = useMemo(
    () => buildEntityGraphConnectionMap(safeLinks),
    [safeLinks],
  );

  useEffect(() => {
    if (!selectedNode) {
      return;
    }
    const stillVisible = visibleNodes.some((node) => node.id === selectedNode);
    if (!stillVisible) {
      setSelectedNode(null);
      setDrawerOpen(false);
      setContextMenu(null);
    }
  }, [selectedNode, visibleNodes]);

  const selectedNodeRecord = useMemo(
    () => visibleNodes.find((node) => node.id === selectedNode) ?? null,
    [selectedNode, visibleNodes],
  );

  const labelNodeIds = useMemo(
    () =>
      selectEntityGraphLabelNodeIds(
        visibleNodes,
        labelDensity,
        selectedNode,
        connectionMap,
      ),
    [connectionMap, labelDensity, selectedNode, visibleNodes],
  );

  const relatedEntities = useMemo(() => {
    if (!selectedNode) {
      return [];
    }
    const relatedIds = connectionMap.get(selectedNode) ?? [];
    const byId = new Map(
      visibleNodes.map((node) => [node.id, node.name] as const),
    );
    return relatedIds
      .map((id) => ({ id, name: byId.get(id) }))
      .filter(
        (item): item is { id: string; name: string } =>
          typeof item.name === "string" && item.name.trim().length > 0,
      )
      .map((item) => ({ id: item.id, name: item.name.trim() }));
  }, [connectionMap, selectedNode, visibleNodes]);

  const forceConfig = useMemo(
    () => resolveEntityGraphForce(visibleNodes.length),
    [visibleNodes.length],
  );

  const categoryLabels = useMemo(
    () => ({
      person: t("dashboard.charts.entityGraph.person", {
        defaultValue: "Person",
      }),
      organization: t("dashboard.charts.entityGraph.organization", {
        defaultValue: "Organization",
      }),
      stock: t("dashboard.charts.entityGraph.stock", { defaultValue: "Stock" }),
      commodity: t("dashboard.charts.entityGraph.commodity", {
        defaultValue: "Commodity",
      }),
      other: t("dashboard.charts.entityGraph.other", { defaultValue: "Other" }),
    }),
    [t],
  );

  const nodeNameById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node.name] as const)),
    [visibleNodes],
  );

  // 降级统计：计算被过滤的无效链接
  const degradationStats = useMemo(() => {
    if (visibleLinks.length === 0) {
      return { filteredLinks: 0, totalLinks: 0 };
    }
    const filteredLinks = Math.max(0, visibleLinks.length - safeLinks.length);
    return { filteredLinks, totalLinks: visibleLinks.length };
  }, [safeLinks, visibleLinks]);

  const option = useMemo<EChartsOption>(() => {
    if (visibleNodes.length === 0) {
      return {};
    }

    const connectedNodeIds = new Set<string>();
    if (selectedNode) {
      connectedNodeIds.add(selectedNode);
      for (const id of connectionMap.get(selectedNode) ?? []) {
        connectedNodeIds.add(id);
      }
    }

    const chartCategories = [
      { name: categoryLabels.person },
      { name: categoryLabels.organization },
      { name: categoryLabels.stock },
      { name: categoryLabels.commodity },
      { name: categoryLabels.other },
    ];

    const transformedNodes = visibleNodes.map((node) => {
      const categoryConfig = getCategoryConfig(node.category);
      const connectionCount = connectionMap.get(node.id)?.length ?? 0;
      const relatedNodeNames = (connectionMap.get(node.id) ?? [])
        .map((id) => nodeNameById.get(id))
        .filter((value): value is string => typeof value === "string")
        .slice(0, 5);

      const isSelected = selectedNode === node.id;
      const isConnected = connectedNodeIds.has(node.id);
      const shouldDim = selectedNode !== null && !isConnected;

      return {
        id: node.id,
        name: node.name,
        value: node.value,
        category: categoryConfig.index,
        symbol: categoryConfig.symbol,
        symbolSize: resolveEntityGraphNodeSize(node.value, isSelected),
        itemStyle: {
          color: categoryConfig.color,
          opacity: shouldDim ? 0.2 : 0.94,
          borderColor: isSelected
            ? (colors?.primary ?? "#1f3b7b")
            : (colors?.border ?? "#dbe3ee"),
          borderWidth: isSelected ? 3 : 1.2,
          shadowBlur: isSelected ? 18 : 8,
          shadowColor: isSelected
            ? "rgba(31, 59, 123, 0.34)"
            : "rgba(15, 23, 42, 0.12)",
        },
        label: {
          show: labelNodeIds.has(node.id),
          position: "right" as const,
          distance: 6,
          color: colors?.foreground ?? "#334155",
          fontFamily,
          fontSize: isSelected ? 12 : 11,
          fontWeight: isSelected ? (700 as const) : (500 as const),
        },
        originalData: {
          type: node.type,
          category: node.category,
          connectionCount,
          relatedEntities: relatedNodeNames,
        },
      };
    });

    const nodeIndexById = new Map<string, number>();
    transformedNodes.forEach((node, index) => {
      nodeIndexById.set(node.id, index);
    });

    const transformedLinks = safeLinks.flatMap((link) => {
      const sourceIndex = nodeIndexById.get(link.source);
      const targetIndex = nodeIndexById.get(link.target);
      if (sourceIndex === undefined || targetIndex === undefined) {
        return [];
      }
      const normalizedType = normalizeEntityGraphEdgeType(link.type);
      const isSelectedAdjacency =
        selectedNode !== null &&
        (link.source === selectedNode || link.target === selectedNode);
      const shouldDim = selectedNode !== null && !isSelectedAdjacency;
      const rawValue = Number(link.value ?? 0);
      const baseWidth =
        normalizedType === "correlation"
          ? Math.max(1.1, Math.min(3.2, rawValue * 4.2))
          : Math.max(0.9, Math.min(2.8, Math.sqrt(Math.max(rawValue, 0))));

      return {
        source: sourceIndex,
        target: targetIndex,
        value: rawValue,
        lineStyle: {
          width: isSelectedAdjacency ? baseWidth + 1.2 : baseWidth,
          type:
            normalizedType === "correlation"
              ? ("dashed" as const)
              : ("solid" as const),
          color: isSelectedAdjacency
            ? (colors?.primary ?? "#1f3b7b")
            : normalizedType === "correlation"
              ? "rgba(217, 119, 6, 0.5)"
              : "rgba(31, 59, 123, 0.34)",
          opacity: shouldDim ? 0.08 : isSelectedAdjacency ? 0.78 : 0.24,
          curveness: normalizedType === "correlation" ? 0.24 : 0.16,
        },
        originalData: {
          type: link.type,
          normalizedType,
          sourceId: link.source,
          targetId: link.target,
        },
      };
    });

    return {
      animation: false,
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: colors?.tooltipBg ?? "rgba(15, 23, 42, 0.92)",
        borderColor: "rgba(255, 255, 255, 0.2)",
        textStyle: {
          color: colors?.tooltipText ?? "#f8fafc",
          fontFamily,
        },
        formatter: (params: any) => {
          if (params?.dataType === "node") {
            const data = params.data;
            const original = data.originalData ?? {};
            const categoryKey = normalizeEntityGraphCategory(
              String(original.category ?? ""),
            );
            const categoryName =
              categoryLabels[categoryKey as keyof typeof categoryLabels] ??
              categoryLabels.other;
            const related = Array.isArray(original.relatedEntities)
              ? original.relatedEntities.filter(
                  (entry: unknown) => typeof entry === "string",
                )
              : [];
            const relatedLabel =
              related.length > 0
                ? `${t("dashboard.charts.entityGraph.relatedEntities", { defaultValue: "Related" })}: ${related.join(", ")}`
                : "";
            const safeNodeName = escapeHtml(data.name ?? "-");
            const safeType = escapeHtml(original.type ?? "-");
            const safeCategoryName = escapeHtml(categoryName);
            const safeRelatedLabel = escapeHtml(relatedLabel);
            const safeWindowLabel = escapeHtml(windowLabel);

            return [
              `<div style="font-weight:600;margin-bottom:6px;">${safeNodeName}</div>`,
              `<div>${t("dashboard.charts.entityGraph.type", { defaultValue: "Type" })}: ${safeType}</div>`,
              `<div>${t("dashboard.charts.entityGraph.category", { defaultValue: "Category" })}: ${safeCategoryName}</div>`,
              `<div>${t("dashboard.charts.entityGraph.weight", { defaultValue: "Weight" })}: ${Number(data.value ?? 0).toFixed(1)}</div>`,
              `<div>${t("dashboard.charts.entityGraph.connections", { defaultValue: "Connections" })}: ${original.connectionCount ?? 0}</div>`,
              relatedLabel ? `<div>${safeRelatedLabel}</div>` : "",
              `<div style="color:#94a3b8;margin-top:6px;">${t("dashboard.charts.entityGraph.window", { defaultValue: "Window" })}: ${safeWindowLabel}</div>`,
            ].join("");
          }

          if (params?.dataType === "edge") {
            const data = params.data;
            const original = data.originalData ?? {};
            const normalizedType =
              original.normalizedType === "correlation"
                ? "correlation"
                : "coOccurrence";
            const sourceId =
              typeof original.sourceId === "string"
                ? original.sourceId
                : typeof data.source === "string"
                  ? data.source
                  : "";
            const targetId =
              typeof original.targetId === "string"
                ? original.targetId
                : typeof data.target === "string"
                  ? data.target
                  : "";
            const source = nodeNameById.get(sourceId) ?? sourceId;
            const target = nodeNameById.get(targetId) ?? targetId;
            const linkTypeLabel =
              normalizedType === "correlation"
                ? t("dashboard.charts.entityGraph.correlation", {
                    defaultValue: "Correlation",
                  })
                : t("dashboard.charts.entityGraph.coOccurrence", {
                    defaultValue: "Co-occurrence",
                  });
            const safeSource = escapeHtml(source);
            const safeTarget = escapeHtml(target);
            const safeWindowLabel = escapeHtml(windowLabel);
            const safeLinkTypeLabel = escapeHtml(linkTypeLabel);

            return [
              `<div style="font-weight:600;margin-bottom:6px;">${safeSource} -> ${safeTarget}</div>`,
              `<div>${t("dashboard.charts.entityGraph.linkType", { defaultValue: "Link Type" })}: ${safeLinkTypeLabel}</div>`,
              `<div>${t("dashboard.charts.entityGraph.strength", { defaultValue: "Strength" })}: ${Number(data.value ?? 0).toFixed(normalizedType === "correlation" ? 2 : 0)}</div>`,
              `<div style="color:#94a3b8;margin-top:6px;">${t("dashboard.charts.entityGraph.window", { defaultValue: "Window" })}: ${safeWindowLabel}</div>`,
            ].join("");
          }

          return "";
        },
      },
      series: [
        {
          name: t("dashboard.charts.entityGraph.title", {
            defaultValue: "Entity Impact Graph",
          }),
          type: "graph",
          layout: "force",
          data: transformedNodes,
          links: transformedLinks,
          categories: chartCategories,
          roam: true,
          draggable: true,
          cursor: "pointer",
          force: {
            repulsion: forceConfig.repulsion,
            gravity: forceConfig.gravity,
            edgeLength: forceConfig.edgeLength,
            layoutAnimation: false,
          },
          lineStyle: {
            color: "source",
            opacity: 0.42,
            curveness: 0.18,
          },
          emphasis: {
            focus: "adjacency",
            scale: true,
            lineStyle: {
              opacity: 0.9,
            },
          },
        },
      ],
    };
  }, [
    categoryLabels,
    colors,
    connectionMap,
    fontFamily,
    forceConfig,
    labelNodeIds,
    nodeNameById,
    selectedNode,
    t,
    safeLinks,
    visibleNodes,
    windowLabel,
  ]);

  const openSearchForEntity = useCallback(
    (query: string) => {
      const normalized = query.trim();
      if (!normalized) {
        return;
      }
      const toastId = toast.loading(
        t("dashboard.charts.entityGraph.openingSearch", {
          query: normalized,
          defaultValue: `Opening search for "${normalized}"...`,
        }),
      );
      const handle = window.open(
        `/search?q=${encodeURIComponent(normalized)}`,
        "_blank",
        "noopener,noreferrer",
      );
      window.setTimeout(() => {
        if (handle) {
          toast.success(
            t("dashboard.charts.entityGraph.openedSearch", {
              query: normalized,
              defaultValue: `Search opened for "${normalized}" in a new tab`,
            }),
            { id: toastId },
          );
        } else {
          toast.error(
            t("common.popupBlocked", {
              defaultValue: "Popup blocked. Please allow popups for this site.",
            }),
            { id: toastId },
          );
        }
      }, 200);
    },
    [t],
  );

  const copyEntityName = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast.success(t("common.copied", { defaultValue: "Copied" }));
      } catch {
        toast.error(t("common.copyFailed", { defaultValue: "Copy failed" }));
      }
    },
    [t],
  );

  const openIntelligenceCardForEntity = useCallback(
    async (name: string, type: string) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        return;
      }
      try {
        const result = await resolveKnowledgeEntityByName({
          variables: {
            name: normalizedName,
            type: resolveKnowledgeEntityTypeForImpactNode(type),
          },
        });
        const entity = result.data?.knowledgeEntityByName;
        if (!entity?.id) {
          toast.error(
            t("entities.intelligence.resolveFailed", {
              defaultValue: "No matching knowledge graph entity found.",
            }),
          );
          return;
        }
        window.location.assign(`/entities/${encodeURIComponent(entity.id)}`);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("entities.intelligence.resolveFailed", {
                defaultValue: "No matching knowledge graph entity found.",
              }),
        );
      }
    },
    [resolveKnowledgeEntityByName, t],
  );

  const handleNodeClick = useCallback(
    (params: any) => {
      if (params.dataType !== "node") {
        return;
      }
      const nodeId = params.data?.id;
      const nodeName = params.data?.name;
      if (!nodeId) {
        return;
      }
      const newSelection = selectedNode === nodeId ? null : nodeId;
      setSelectedNode(newSelection);
      setContextMenu(null);
      setDrawerOpen(Boolean(newSelection));
      if (newSelection && nodeName) {
        message.info(
          t("dashboard.charts.entityGraph.nodeSelected", {
            node: nodeName,
            defaultValue: `Selected: ${nodeName}`,
          }),
        );
      }
    },
    [message, selectedNode, t],
  );

  const handleNodeContextMenu = useCallback((params: any) => {
    if (params.dataType !== "node") {
      return;
    }

    const nodeId = params.data?.id;
    const nodeName = params.data?.name;
    if (typeof nodeId !== "string" || typeof nodeName !== "string") {
      return;
    }

    const nativeEvent = params.event?.event as MouseEvent | undefined;
    nativeEvent?.preventDefault?.();
    nativeEvent?.stopPropagation?.();

    let x =
      typeof params.event?.offsetX === "number"
        ? params.event.offsetX
        : Number.NaN;
    let y =
      typeof params.event?.offsetY === "number"
        ? params.event.offsetY
        : Number.NaN;

    if (
      (!Number.isFinite(x) || !Number.isFinite(y)) &&
      nativeEvent &&
      containerRef.current
    ) {
      const rect = containerRef.current.getBoundingClientRect();
      x = nativeEvent.clientX - rect.left;
      y = nativeEvent.clientY - rect.top;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = 10;
      y = 10;
    }

    setSelectedNode(nodeId);
    setContextMenu({ x, y, nodeId, nodeName });
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const dismiss = () => setContextMenu(null);
    const dismissOnKey = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("mousedown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", dismissOnKey);

    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", dismissOnKey);
    };
  }, [contextMenu]);

  const clearGraphFocus = useCallback(() => {
    setSelectedNode(null);
    setDrawerOpen(false);
    setContextMenu(null);
  }, []);

  const handleConfidenceChange = useCallback((value: number) => {
    setConfidenceDraft(value);
  }, []);

  const handleConfidenceCommit = useCallback(
    (value: number) => {
      setConfidenceDraft(value);
      setMinConfidence(value);
      clearGraphFocus();
    },
    [clearGraphFocus],
  );

  const toggleCategory = useCallback((category: string) => {
    const normalized = normalizeEntityGraphCategory(category);
    setSelectedCategories((previous) => {
      if (previous.includes(normalized)) {
        if (previous.length === 1) {
          return previous;
        }
        return previous.filter((entry) => entry !== normalized);
      }
      return [...previous, normalized];
    });
    setSelectedNode(null);
    setDrawerOpen(false);
    setContextMenu(null);
  }, []);

  const toggleEdgeType = useCallback((edgeType: EntityGraphEdgeType) => {
    setSelectedEdgeTypes((previous) => {
      if (previous.includes(edgeType)) {
        if (previous.length === 1) {
          return previous;
        }
        return previous.filter((entry) => entry !== edgeType);
      }
      return [...previous, edgeType];
    });
    setSelectedNode(null);
    setDrawerOpen(false);
    setContextMenu(null);
  }, []);

  const handleReflow = useCallback(() => {
    setGraphRenderSeed((seed) => seed + 1);
    message.success(
      t("dashboard.charts.entityGraph.reflowed", {
        defaultValue: "Graph layout refreshed",
      }),
    );
  }, [message, t]);

  const handleResetFilters = useCallback(() => {
    setSelectedCategories([...queryCategories]);
    setSelectedEdgeTypes([...EDGE_TYPE_OPTIONS]);
    setLabelDensity("compact");
    setConfidenceDraft(defaultMinConfidence);
    setMinConfidence(defaultMinConfidence);
    clearGraphFocus();
  }, [clearGraphFocus, defaultMinConfidence, queryCategories]);

  if (sessionStatus === "loading") {
    return (
      <div className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (authenticated && !canReadDashboards) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("common.accessDeniedDescription", {
            defaultValue:
              "You don't have permission to view this data. Contact an administrator if you need access.",
          })}
        />
      </div>
    );
  }

  if (!settingsApplied && settingsError) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={settingsError.message}
          actionLabel={t("dashboard.actions.retryFetch", {
            defaultValue: "Retry fetch"
          })}
          actionLoading={refreshingSettings}
          onAction={() => {
            void refreshSettings();
          }}
        />
      </div>
    );
  }

  if (enabled === false) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState
          variant="offline"
          title={t("dashboard.charts.entityGraph.disabledTitle", {
            defaultValue: "Disabled",
          })}
          description={t("dashboard.charts.entityGraph.disabledDescription", {
            defaultValue: "Disabled by admin",
          })}
        />
      </div>
    );
  }

  if (!settingsApplied) {
    return (
      <div className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (loading && !hasData) {
    return (
      <div className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (error && !hasData) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error instanceof Error ? error.message : emptyMessage}
          actionLabel={t("dashboard.actions.retryFetch", {
            defaultValue: "Retry fetch"
          })}
          actionLoading={refreshingGraph}
          onAction={() => {
            void refreshGraph();
          }}
        />
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState description={emptyMessage} />
      </div>
    );
  }

  const showStaleDataErrorBanner = Boolean(error && hasData);
  const showStaleSettingsErrorBanner = Boolean(
    settingsApplied && settingsError,
  );
  const chartHeight = isMobile ? 320 : 400;
  const drawerWidth = isMobile ? "100%" : 420;

  return (
    <>
      <div className="entity-graph-panel">
        {showStaleDataErrorBanner ? (
          <div className="mb-2">
            <RequestErrorBanner
              error={error}
              onRetry={() => {
                void refreshGraph();
              }}
              actionLoading={refreshingGraph}
              showCachedDataHint
            />
          </div>
        ) : showStaleSettingsErrorBanner ? (
          <div className="mb-2">
            <RequestErrorBanner
              error={settingsError}
              onRetry={() => {
                void refreshSettings();
              }}
              actionLoading={refreshingSettings}
              showCachedDataHint
            />
          </div>
        ) : null}

        <div className="entity-graph-meta-row">
          <Tag color="default" className="text-xs">
            {t("dashboard.charts.entityGraph.range", { defaultValue: "Range" })}
            : {range}
          </Tag>
          <Tag color="default" className="text-xs">
            {t("dashboard.charts.entityGraph.window", {
              defaultValue: "Window",
            })}
            : {windowLabel}
          </Tag>
          <Tag color="geekblue" className="text-xs">
            {t("dashboard.charts.entityGraph.aggregation", {
              defaultValue: "Aggregation: window graph",
            })}
          </Tag>
          {degradationStats.filteredLinks > 0 ? (
            <Tooltip
              title={t("dashboard.charts.entityGraph.filteredLinksTooltip", {
                filtered: degradationStats.filteredLinks,
                total: degradationStats.totalLinks,
                defaultValue: `${degradationStats.filteredLinks} 个链接在规范化过程中被隐藏（无效引用、自环、重复或异常值），以确保图表正常显示。`
              })}
            >
              <Tag
                color="orange"
                icon={<WarningOutlined />}
                className="text-xs cursor-help"
              >
                {t("dashboard.charts.entityGraph.filteredLinks", {
                  count: degradationStats.filteredLinks,
                  defaultValue: `已隐藏 ${degradationStats.filteredLinks} 个链接`
                })}
              </Tag>
            </Tooltip>
          ) : null}
        </div>

        <div className="entity-graph-toolbar">
          <div className="entity-graph-group">
            <span className="entity-graph-group-label">
              {t("dashboard.charts.entityGraph.categoryFilter", {
                defaultValue: "Categories",
              })}
            </span>
            <Space size={6} wrap>
              {ENTITY_GRAPH_DEFAULT_CATEGORIES.map((category) => {
                const categoryLabel =
                  categoryLabels[category as keyof typeof categoryLabels] ??
                  category;
                const isActive = selectedCategories.includes(category);
                return (
                  <Button
                    key={category}
                    size="small"
                    type={isActive ? "primary" : "default"}
                    className={`entity-graph-chip entity-graph-chip-${category}`}
                    disabled={isActive && selectedCategories.length === 1}
                    onClick={() => toggleCategory(category)}
                  >
                    {categoryLabel}
                  </Button>
                );
              })}
            </Space>
          </div>

          <div className="entity-graph-group">
            <span className="entity-graph-group-label">
              {t("dashboard.charts.entityGraph.edgeFilter", {
                defaultValue: "Edge Types",
              })}
            </span>
            <Space size={6} wrap>
              {EDGE_TYPE_OPTIONS.map((edgeType) => {
                const edgeLabel =
                  edgeType === "correlation"
                    ? t("dashboard.charts.entityGraph.correlation", {
                        defaultValue: "Correlation",
                      })
                    : t("dashboard.charts.entityGraph.coOccurrence", {
                        defaultValue: "Co-occurrence",
                      });
                const isActive = selectedEdgeTypes.includes(edgeType);
                return (
                  <Button
                    key={edgeType}
                    size="small"
                    type={isActive ? "primary" : "default"}
                    className={`entity-graph-chip ${
                      edgeType === "correlation"
                        ? "entity-graph-chip-correlation"
                        : "entity-graph-chip-cooccurrence"
                    }`}
                    disabled={isActive && selectedEdgeTypes.length === 1}
                    onClick={() => toggleEdgeType(edgeType)}
                  >
                    {edgeLabel}
                  </Button>
                );
              })}
            </Space>
          </div>

          <div className="entity-graph-group">
            <span className="entity-graph-group-label">
              {t("dashboard.charts.entityGraph.labels", {
                defaultValue: "Labels",
              })}
            </span>
            <Segmented<EntityGraphLabelDensity>
              size="small"
              value={labelDensity}
              onChange={(value) => setLabelDensity(value)}
              options={[
                {
                  label: t("dashboard.charts.entityGraph.labelCompact", {
                    defaultValue: "Compact",
                  }),
                  value: "compact",
                },
                {
                  label: t("dashboard.charts.entityGraph.labelStandard", {
                    defaultValue: "Standard",
                  }),
                  value: "standard",
                },
              ]}
            />
          </div>

          <div className="entity-graph-group entity-graph-confidence">
            <Text type="secondary" className="text-xs whitespace-nowrap">
              {t("dashboard.charts.entityGraph.confidenceFilter", {
                defaultValue: "Entity confidence",
              })}
            </Text>
            <Slider
              min={0}
              max={1}
              step={0.1}
              value={confidenceDraft}
              onChange={handleConfidenceChange}
              onChangeComplete={handleConfidenceCommit}
              style={{ width: 120 }}
              tooltip={{
                formatter: (value) => `${((value ?? 0) * 100).toFixed(0)}%`,
              }}
            />
            <Text type="secondary" className="text-xs min-w-[34px] text-right">
              {(confidenceDraft * 100).toFixed(0)}%
            </Text>
          </div>

          <div className="entity-graph-group entity-graph-actions">
            <Button size="small" onClick={handleReflow}>
              {t("dashboard.charts.entityGraph.reflow", {
                defaultValue: "Reflow",
              })}
            </Button>
            <Button size="small" onClick={handleResetFilters}>
              {t("common.reset", { defaultValue: "Reset" })}
            </Button>
          </div>
        </div>

        {visibleNodes.length > 0 ? (
          <div ref={containerRef} className="entity-graph-canvas">
            <DashboardChart
              key={`entity-graph-${graphRenderSeed}`}
              option={option}
              theme={echartsTheme}
              height={chartHeight}
              onEvents={[
                {
                  type: "click",
                  handler: handleNodeClick,
                },
                {
                  type: "contextmenu",
                  handler: handleNodeContextMenu,
                },
              ]}
            />
            {loading ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40">
                <Skeleton active paragraph={{ rows: 6 }} />
              </div>
            ) : null}

            {contextMenu ? (
              <div
                className="absolute z-20"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onContextMenu={(evt) => evt.preventDefault()}
                onMouseDown={(evt) => evt.stopPropagation()}
              >
                <div className="min-w-[220px] overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur">
                  <div className="px-3 py-2 text-xs text-slate-600">
                    {contextMenu.nodeName}
                  </div>
                  <div className="border-t border-slate-200" />
                  <div className="p-1.5">
                    <Button
                      type="text"
                      size="small"
                      block
                      icon={<IdcardOutlined />}
                      loading={resolvingEntityCard}
                      onClick={() => {
                        void openIntelligenceCardForEntity(
                          contextMenu.nodeName,
                          selectedNodeRecord?.type ?? "",
                        );
                        setContextMenu(null);
                      }}
                    >
                      {t("entities.intelligence.openCard", {
                        defaultValue: "Open Intelligence Card",
                      })}
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      block
                      onClick={() => {
                        openSearchForEntity(contextMenu.nodeName);
                        setContextMenu(null);
                      }}
                    >
                      {t("dashboard.charts.entityGraph.openSearch", {
                        defaultValue: "Open search",
                      })}
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      block
                      onClick={() => {
                        void copyEntityName(contextMenu.nodeName);
                        setContextMenu(null);
                      }}
                    >
                      {t("common.copy", { defaultValue: "Copy" })}
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      block
                      onClick={() => {
                        setDrawerOpen(true);
                        setContextMenu(null);
                      }}
                    >
                      {t("common.details", { defaultValue: "Details" })}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="entity-graph-canvas h-[320px] md:h-[400px] flex items-center justify-center">
            <ChartEmptyState
              title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
              description={t("dashboard.charts.entityGraph.filteredEmpty", {
                defaultValue:
                  "No nodes match the active filters. Reset filters or broaden categories to continue.",
              })}
              actionLabel={t("common.reset", { defaultValue: "Reset" })}
              onAction={handleResetFilters}
            />
          </div>
        )}

        <div className="entity-graph-footer">
          <div className="entity-graph-kpis">
            <Tag>
              {t("dashboard.charts.entityGraph.visibleNodes", {
                defaultValue: "Visible nodes",
              })}
              : {visibleNodes.length}
            </Tag>
            <Tag>
              {t("dashboard.charts.entityGraph.visibleLinks", {
                defaultValue: "Visible links",
              })}
              : {safeLinks.length}
            </Tag>
            <Tag>
              {t("dashboard.charts.entityGraph.totalNodes", {
                defaultValue: "Total nodes",
              })}
              : {metadata?.totalNodes ?? nodes.length}
            </Tag>
            <Tag>
              {t("dashboard.charts.entityGraph.totalLinks", {
                defaultValue: "Total links",
              })}
              : {metadata?.totalLinks ?? links.length}
            </Tag>
          </div>
          <Text type="secondary" className="text-xs">
            {t("dashboard.charts.entityGraph.hint", {
              defaultValue: "Tip: right-click a node for quick actions.",
            })}
          </Text>
        </div>
      </div>

      <Drawer
        open={drawerOpen && Boolean(selectedNodeRecord)}
        onClose={() => setDrawerOpen(false)}
        placement="right"
        width={drawerWidth}
        title={
          selectedNodeRecord?.name ??
          t("dashboard.charts.entityGraph.detailsTitle", {
            defaultValue: "Details",
          })
        }
        extra={
          <Button
            size="small"
            onClick={() => {
              setSelectedNode(null);
              setDrawerOpen(false);
            }}
          >
            {t("common.clear", { defaultValue: "Clear" })}
          </Button>
        }
      >
        {selectedNodeRecord ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <Text type="secondary" className="block">
                {t("dashboard.charts.entityGraph.type", {
                  defaultValue: "Type",
                })}
                : {selectedNodeRecord.type}
              </Text>
              <Text type="secondary" className="block">
                {t("dashboard.charts.entityGraph.category", {
                  defaultValue: "Category",
                })}
                : {selectedNodeRecord.category}
              </Text>
              <Text type="secondary" className="block">
                {t("dashboard.charts.entityGraph.weight", {
                  defaultValue: "Weight",
                })}
                : {Number(selectedNodeRecord.value ?? 0).toFixed(1)}
              </Text>
              <Text type="secondary" className="block">
                {t("dashboard.charts.entityGraph.connections", {
                  defaultValue: "Connections",
                })}
                : {relatedEntities.length}
              </Text>
            </div>

            <Space wrap>
              <Button
                icon={<IdcardOutlined />}
                loading={resolvingEntityCard}
                onClick={() => {
                  void openIntelligenceCardForEntity(
                    selectedNodeRecord.name,
                    selectedNodeRecord.type,
                  );
                }}
              >
                {t("entities.intelligence.openCard", {
                  defaultValue: "Open Intelligence Card",
                })}
              </Button>
              <Button
                type="primary"
                onClick={() => openSearchForEntity(selectedNodeRecord.name)}
              >
                {t("dashboard.charts.entityGraph.openSearch", {
                  defaultValue: "Open search",
                })}
              </Button>
              <Button
                onClick={() => void copyEntityName(selectedNodeRecord.name)}
              >
                {t("common.copy", { defaultValue: "Copy" })}
              </Button>
            </Space>

            {relatedEntities.length > 0 ? (
              <div>
                <Text type="secondary" className="block mb-2">
                  {t("dashboard.charts.entityGraph.relatedEntities", {
                    defaultValue: "Related",
                  })}
                </Text>
                <div className="flex flex-wrap gap-2">
                  {relatedEntities.slice(0, 18).map(({ id, name }) => (
                    <Tag
                      key={id}
                      className="cursor-pointer"
                      onClick={() => {
                        openSearchForEntity(name);
                      }}
                    >
                      {name}
                    </Tag>
                  ))}
                </div>
              </div>
            ) : (
              <Text type="secondary">
                {t("dashboard.charts.entityGraph.noRelatedEntities", {
                  defaultValue: "No related entities found.",
                })}
              </Text>
            )}
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}

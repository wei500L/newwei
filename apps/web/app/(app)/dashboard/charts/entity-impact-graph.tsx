"use client";

import { Skeleton, Slider, Space, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { message } from "antd";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useEntityImpactGraphSettingsQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import {
  useEntityImpactGraph,
  type EntityImpactNode,
  type EntityImpactLink
} from "@/hooks/useEntityImpactGraph";

const { Text } = Typography;

/**
 * Category configuration for node styling
 * Maps entity types to visual properties
 */
const CATEGORY_CONFIG: Record<
  string,
  { color: string; symbol: string; index: number }
> = {
  person: { color: "#3b82f6", symbol: "circle", index: 0 },
  organization: { color: "#22c55e", symbol: "rect", index: 1 },
  stock: { color: "#f97316", symbol: "diamond", index: 2 },
  commodity: { color: "#a855f7", symbol: "triangle", index: 3 }
};

/**
 * Default category for unknown types
 */
const DEFAULT_CATEGORY = { color: "#64748b", symbol: "circle", index: 4 };

/**
 * Get category configuration for a node type
 */
function getCategoryConfig(type: string) {
  const normalizedType = type.toLowerCase();
  return CATEGORY_CONFIG[normalizedType] ?? DEFAULT_CATEGORY;
}

/**
 * Build a map of node connections for tooltip display
 */
function buildConnectionMap(links: EntityImpactLink[]): Map<string, string[]> {
  const connectionMap = new Map<string, string[]>();

  for (const link of links) {
    // Add target to source's connections
    const sourceConnections = connectionMap.get(link.source) ?? [];
    if (!sourceConnections.includes(link.target)) {
      sourceConnections.push(link.target);
    }
    connectionMap.set(link.source, sourceConnections);

    // Add source to target's connections
    const targetConnections = connectionMap.get(link.target) ?? [];
    if (!targetConnections.includes(link.source)) {
      targetConnections.push(link.source);
    }
    connectionMap.set(link.target, targetConnections);
  }

  return connectionMap;
}

/**
 * Transform nodes to ECharts format
 */
function transformNodes(
  nodes: EntityImpactNode[],
  links: EntityImpactLink[],
  colors: Record<string, string> | undefined,
  selectedNodeId: string | null
) {
  const connectionMap = buildConnectionMap(links);

  // Get connected node IDs for highlighting
  const connectedNodeIds = new Set<string>();
  if (selectedNodeId) {
    connectedNodeIds.add(selectedNodeId);
    const connections = connectionMap.get(selectedNodeId) ?? [];
    for (const conn of connections) {
      connectedNodeIds.add(conn);
    }
  }

  return nodes.map((node) => {
    const categoryConfig = getCategoryConfig(node.category);
    const symbolSize = Math.max(20, Math.min(60, 20 + node.value * 2));
    const relatedEntities = connectionMap.get(node.id) ?? [];

    // Determine if node should be highlighted or dimmed
    const isSelected = selectedNodeId === node.id;
    const isConnected = connectedNodeIds.has(node.id);
    const shouldDim = selectedNodeId !== null && !isConnected;

    return {
      id: node.id,
      name: node.name,
      value: node.value,
      category: categoryConfig.index,
      symbol: categoryConfig.symbol,
      symbolSize: isSelected ? symbolSize * 1.2 : symbolSize,
      itemStyle: {
        color: categoryConfig.color,
        borderColor: isSelected
          ? (colors?.primary ?? "#1f3b7b")
          : (colors?.border ?? "#e2e8f0"),
        borderWidth: isSelected ? 4 : 2,
        opacity: shouldDim ? 0.3 : 1
      },
      label: {
        show: symbolSize > 30 || isSelected,
        position: "right" as const,
        formatter: "{b}",
        fontWeight: isSelected ? ("bold" as const) : ("normal" as const)
      },
      // Store original data for tooltip
      originalData: {
        type: node.type,
        category: node.category,
        connectionCount: relatedEntities.length,
        relatedEntities: relatedEntities.slice(0, 5) // Limit to 5 for tooltip
      }
    };
  });
}

/**
 * Transform links to ECharts format
 */
function transformLinks(
  links: EntityImpactLink[],
  selectedNodeId: string | null
) {
  return links.map((link) => {
    const isCorrelation = link.type === "correlation";
    const lineWidth = Math.max(1, Math.min(5, link.value * 3));

    // Determine if link should be highlighted or dimmed
    const isConnected =
      selectedNodeId !== null &&
      (link.source === selectedNodeId || link.target === selectedNodeId);
    const shouldDim = selectedNodeId !== null && !isConnected;

    return {
      source: link.source,
      target: link.target,
      value: link.value,
      lineStyle: {
        width: isConnected ? lineWidth * 1.5 : lineWidth,
        type: isCorrelation ? ("dashed" as const) : ("solid" as const),
        color: isCorrelation ? "#94a3b8" : "#64748b",
        curveness: 0.2,
        opacity: shouldDim ? 0.15 : isConnected ? 1 : 0.6
      },
      // Store original data for tooltip
      originalData: {
        type: link.type
      }
    };
  });
}

/**
 * EntityImpactGraph component
 *
 * Displays a force-directed graph visualization showing relationships
 * between news entities (persons, organizations) and financial instruments
 * (stocks, commodities).
 *
 * Features:
 * - Force-directed layout with configurable physics
 * - 4 node categories with distinct styling
 * - 2 link types (co-occurrence: solid, correlation: dashed)
 * - Interactive tooltips and click events
 * - Loading, error, and empty states
 */
export function EntityImpactGraph() {
  const { t } = useTranslation();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState<number>(0.5);
  const [minCorrelation, setMinCorrelation] = useState<number>(0.3);
  const [minCoOccurrence, setMinCoOccurrence] = useState<number>(2);
  const [maxNodes, setMaxNodes] = useState<number>(100);
  const [categories, setCategories] = useState<string[]>(["person", "organization", "stock", "commodity"]);
  const [settingsApplied, setSettingsApplied] = useState(false);

  const { data: settingsData, loading: settingsLoading } = useEntityImpactGraphSettingsQuery({
    fetchPolicy: "cache-and-network"
  });

  const settings = settingsData?.entityImpactGraphSettings;
  const enabled = settings?.enabled ?? true;

  useEffect(() => {
    if (settingsApplied) {
      return;
    }
    if (settings) {
      setMinConfidence(settings.minEntityConfidence);
      setMinCorrelation(settings.minCorrelation);
      setMinCoOccurrence(settings.minCoOccurrence);
      setMaxNodes(settings.maxNodes);
      setCategories(settings.categories);
      setSettingsApplied(true);
      return;
    }
    if (!settingsLoading) {
      setSettingsApplied(true);
    }
  }, [settings, settingsApplied, settingsLoading]);

  const { nodes, links, metadata, loading, error, refetch, hasData } =
    useEntityImpactGraph({
      minConfidence,
      minCorrelation,
      minCoOccurrence,
      maxNodes,
      categories,
      skip: enabled === false || !settingsApplied
    });

  const emptyMessage = t("dashboard.dataEmpty", { defaultValue: "No data" });

  if (enabled === false) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState
          variant="offline"
          title={t("dashboard.charts.entityGraph.disabledTitle", { defaultValue: "Disabled" })}
          description={t("dashboard.charts.entityGraph.disabledDescription", { defaultValue: "Disabled by admin" })}
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

  /**
   * Build ECharts option with graph series configuration
   */
  const option = useMemo<EChartsOption>(() => {
    if (!hasData) return {};

    const transformedNodes = transformNodes(nodes, links, colors, selectedNode);
    const transformedLinks = transformLinks(links, selectedNode);

    // Define categories for legend
    const categories = [
      { name: t("dashboard.charts.entityGraph.person", { defaultValue: "Person" }) },
      { name: t("dashboard.charts.entityGraph.organization", { defaultValue: "Organization" }) },
      { name: t("dashboard.charts.entityGraph.stock", { defaultValue: "Stock" }) },
      { name: t("dashboard.charts.entityGraph.commodity", { defaultValue: "Commodity" }) },
      { name: t("dashboard.charts.entityGraph.other", { defaultValue: "Other" }) }
    ];

    return {
      tooltip: {
        trigger: "item",
        backgroundColor: colors?.tooltipBg ?? "#0f172a",
        borderColor: colors?.primary ?? "#1f3b7b",
        textStyle: {
          color: colors?.tooltipText ?? "#f8fafc",
          fontFamily
        },
        formatter: (params: any) => {
          if (params.dataType === "node") {
            const data = params.data;
            const originalData = data.originalData ?? {};
            const categoryName = categories[data.category]?.name ?? "Unknown";
            const connectionCount = originalData.connectionCount ?? 0;
            const relatedEntities: string[] = originalData.relatedEntities ?? [];

            // Build tooltip with 5 data points: name, type, category, connections, related entities
            const lines = [
              `<b>${data.name}</b>`,
              `${t("dashboard.charts.entityGraph.type", { defaultValue: "Type" })}: ${originalData.type ?? "-"}`,
              `${t("dashboard.charts.entityGraph.category", { defaultValue: "Category" })}: ${categoryName}`,
              `${t("dashboard.charts.entityGraph.weight", { defaultValue: "Weight" })}: ${Number(data.value ?? 0).toFixed(1)}`,
              `${t("dashboard.charts.entityGraph.connections", { defaultValue: "Connections" })}: ${connectionCount}`
            ];

            // Add related entities if available
            if (relatedEntities.length > 0) {
              const relatedLabel = t("dashboard.charts.entityGraph.relatedEntities", { defaultValue: "Related" });
              const relatedList = relatedEntities.slice(0, 3).join(", ");
              const moreCount = relatedEntities.length > 3 ? ` +${relatedEntities.length - 3}` : "";
              lines.push(`${relatedLabel}: ${relatedList}${moreCount}`);
            }

            return lines.join("<br/>");
          }
          if (params.dataType === "edge") {
            const data = params.data;
            const originalData = data.originalData ?? {};
            const isCorrelation = originalData.type === "correlation";
            const linkType =
              isCorrelation
                ? t("dashboard.charts.entityGraph.correlation", { defaultValue: "Correlation" })
                : t("dashboard.charts.entityGraph.coOccurrence", { defaultValue: "Co-occurrence" });
            const strengthLabel = isCorrelation
              ? t("dashboard.charts.entityGraph.correlationValue", { defaultValue: "Correlation" })
              : t("dashboard.charts.entityGraph.coOccurrenceCount", { defaultValue: "Count" });
            const strengthValue = isCorrelation
              ? Number(data.value ?? 0).toFixed(2)
              : `${Math.round(Number(data.value ?? 0))}`;
            return [
              `<b>${params.name}</b>`,
              `${t("dashboard.charts.entityGraph.linkType", { defaultValue: "Link Type" })}: ${linkType}`,
              `${strengthLabel}: ${strengthValue}`
            ].join("<br/>");
          }
          return "";
        }
      },
      legend: {
        data: categories.map((c) => c.name),
        orient: "horizontal",
        bottom: 10,
        textStyle: {
          color: colors?.foreground ?? "#64748b",
          fontFamily
        }
      },
      series: [
        {
          name: t("dashboard.charts.entityGraph.title", { defaultValue: "Entity Impact Graph" }),
          type: "graph",
          layout: "force",
          data: transformedNodes,
          links: transformedLinks,
          categories,
          roam: true,
          draggable: true,
          force: {
            repulsion: 500,
            gravity: 0.1,
            edgeLength: [50, 200],
            layoutAnimation: true
          },
          emphasis: {
            focus: "adjacency",
            lineStyle: {
              width: 4
            },
            itemStyle: {
              shadowBlur: 10,
              shadowColor: "rgba(0, 0, 0, 0.3)"
            }
          },
          label: {
            show: true,
            position: "right",
            fontFamily,
            fontSize: 10,
            color: colors?.foreground ?? "#64748b"
          },
          edgeLabel: {
            show: false
          },
          lineStyle: {
            color: "source",
            curveness: 0.2
          }
        }
      ]
    };
  }, [hasData, nodes, links, colors, fontFamily, t, selectedNode]);

  /**
   * Handle node click event
   */
  const handleNodeClick = useCallback(
    (params: any) => {
      if (params.dataType === "node") {
        const nodeId = params.data?.id;
        const nodeName = params.data?.name;
        if (nodeId) {
          const newSelection = selectedNode === nodeId ? null : nodeId;
          setSelectedNode(newSelection);
          if (newSelection && nodeName) {
            message.info(
              t("dashboard.charts.entityGraph.nodeSelected", {
                node: nodeName,
                defaultValue: `Selected: ${nodeName}`
              })
            );
          }
        }
      }
    },
    [selectedNode, t]
  );

  /**
   * Handle confidence filter change
   */
  const handleConfidenceChange = useCallback((value: number) => {
    setMinConfidence(value);
    // Clear selection when filter changes
    setSelectedNode(null);
  }, []);

  // Loading state
  if (loading && !hasData) {
    return (
      <div className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  // Error state
  if (error && !hasData) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error instanceof Error ? error.message : emptyMessage}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      </div>
    );
  }

  // Empty state
  if (!hasData) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState description={emptyMessage} />
      </div>
    );
  }

  return (
    <div className="relative h-[400px]">
      <DashboardChart
        option={option}
        theme={echartsTheme}
        height="100%"
        onEvents={[
          {
            type: "click",
            handler: handleNodeClick
          }
        ]}
        actions={
          <Space size="middle" align="center">
            <Text type="secondary" className="text-xs whitespace-nowrap">
              {t("dashboard.charts.entityGraph.confidenceFilter", { defaultValue: "Entity confidence" })}:
            </Text>
            <Slider
              min={0}
              max={1}
              step={0.1}
              value={minConfidence}
              onChange={handleConfidenceChange}
              style={{ width: 100 }}
              tooltip={{
                formatter: (value) => `${((value ?? 0) * 100).toFixed(0)}%`
              }}
            />
            <Text type="secondary" className="text-xs">
              {(minConfidence * 100).toFixed(0)}%
            </Text>
          </Space>
        }
      />
      {loading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : null}
      {metadata ? (
        <div className="absolute bottom-2 right-2 text-xs text-gray-500">
          {t("dashboard.charts.entityGraph.stats", {
            nodes: metadata.totalNodes,
            links: metadata.totalLinks,
            defaultValue: `${metadata.totalNodes} nodes, ${metadata.totalLinks} links`
          })}
        </div>
      ) : null}
    </div>
  );
}

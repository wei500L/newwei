"use client";

import { SearchOutlined, WarningOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Input, Skeleton, Slider, Space, Tag, Tooltip, Typography, message } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useGetKnowledgeGraphSubgraphQuery, useKnowledgeGraphSettingsQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";

const { Text } = Typography;

const NODE_TYPE_CONFIG: Record<string, { color: string; symbol: string; index: number }> = {
  company: { color: "#2563eb", symbol: "roundRect", index: 0 },
  industry: { color: "#16a34a", symbol: "rect", index: 1 },
  person: { color: "#f97316", symbol: "circle", index: 2 },
  policy: { color: "#ef4444", symbol: "diamond", index: 3 },
  commodity: { color: "#a855f7", symbol: "triangle", index: 4 },
  instrument: { color: "#0ea5e9", symbol: "pin", index: 5 },
  organization: { color: "#64748b", symbol: "roundRect", index: 6 }
};

const DEFAULT_NODE_TYPE = { color: "#94a3b8", symbol: "circle", index: 7 };
const LAST_ENTITY_STORAGE_KEY = "dashboard.knowledgeGraph.lastEntity";
const EMPTY_DEGRADATION_STATS = {
  filteredNodes: 0,
  totalNodes: 0,
  filteredEdges: 0,
  totalEdges: 0
} as const;

function getNodeTypeConfig(type: string) {
  const normalized = type.trim().toLowerCase();
  return NODE_TYPE_CONFIG[normalized] ?? DEFAULT_NODE_TYPE;
}

function buildDegreeMap(edges: { from: string; to: string }[]) {
  const map = new Map<string, number>();
  for (const edge of edges) {
    map.set(edge.from, (map.get(edge.from) ?? 0) + 1);
    map.set(edge.to, (map.get(edge.to) ?? 0) + 1);
  }
  return map;
}

function getConfidenceColor(confidence: number) {
  if (!Number.isFinite(confidence)) {
    return "#94a3b8";
  }
  if (confidence >= 0.85) return "#16a34a";
  if (confidence >= 0.7) return "#f59e0b";
  return "#ef4444";
}

export function KnowledgeGraph() {
  const { t } = useTranslation();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const { data: session, status: sessionStatus } = useSession();
  const authenticated = sessionStatus === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadDashboards = permissions.includes("dashboards.read");
  const [messageApi, contextHolder] = message.useMessage();
  const [seedDraft, setSeedDraft] = useState("");
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedName, setSeedName] = useState<string>("");
  const [maxDepth, setMaxDepth] = useState<number>(2);
  const [maxNodes, setMaxNodes] = useState<number>(200);
  const [selectedNode, setSelectedNode] = useState<{
    id: string;
    name: string;
    type?: string;
    degree?: number;
  } | null>(null);
  const [nodeDrawerOpen, setNodeDrawerOpen] = useState(false);

  const {
    data: settingsData,
    loading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings
  } = useKnowledgeGraphSettingsQuery({
    fetchPolicy: "cache-and-network",
    skip: !authenticated || !canReadDashboards
  });

  const settings = settingsData?.knowledgeGraphSettings;
  const isDisabledByAdmin = settings?.enabled === false;

  useEffect(() => {
    if (!authenticated || !canReadDashboards || seedName) {
      return;
    }
    try {
      const saved = window.localStorage.getItem(LAST_ENTITY_STORAGE_KEY)?.trim();
      if (!saved) {
        return;
      }
      setSeedDraft(saved);
      setSeedName(saved);
    } catch {
      // ignore storage failures
    }
  }, [authenticated, canReadDashboards, seedName]);

  const handleSearch = useCallback(
    (value?: string) => {
      const next = (value ?? seedDraft).trim();
      if (!next) {
        const warning = t("dashboard.charts.knowledgeGraphSeedRequired", { defaultValue: "Enter an entity name" });
        setSeedError(warning);
        messageApi.warning(warning);
        return;
      }
      setSeedError(null);
      setSeedName(next);
      try {
        window.localStorage.setItem(LAST_ENTITY_STORAGE_KEY, next);
      } catch {
        // ignore storage failures
      }
    },
    [messageApi, seedDraft, t]
  );

  const { data, loading, error, refetch } = useGetKnowledgeGraphSubgraphQuery({
    variables: {
      input: {
        seedName,
        maxDepth,
        maxNodes
      }
    },
    fetchPolicy: "cache-first",
    skip: !authenticated || !canReadDashboards || isDisabledByAdmin || !seedName
  });

  const graph = data?.getKnowledgeGraphSubgraph ?? null;

  const normalizedGraph = useMemo(() => {
    if (!graph) {
      return null;
    }

    // 预处理节点，同时统计重复/无效节点
    const normalizedNodes: Array<(typeof graph.nodes)[number] & { id: string }> = [];
    const seenNodeIds = new Set<string>();
    let filteredNodes = 0;
    for (const node of graph.nodes) {
      const id = typeof node.id === "string" ? node.id.trim() : "";
      if (!id || seenNodeIds.has(id)) {
        filteredNodes++;
        continue;
      }
      seenNodeIds.add(id);
      normalizedNodes.push({ ...node, id });
    }

    // 预处理链接，同时统计无效链接（引用不存在节点或自环）
    const safeEdges: typeof graph.edges = [];
    let filteredEdges = 0;
    for (const edge of graph.edges) {
      if (!seenNodeIds.has(edge.from) || !seenNodeIds.has(edge.to) || edge.from === edge.to) {
        filteredEdges++;
        continue;
      }
      safeEdges.push(edge);
    }

    return {
      normalizedNodes,
      safeEdges,
      degradationStats: {
        filteredNodes,
        totalNodes: graph.nodes.length,
        filteredEdges,
        totalEdges: graph.edges.length
      }
    };
  }, [graph]);

  const degradationStats = normalizedGraph?.degradationStats ?? EMPTY_DEGRADATION_STATS;

  const option = useMemo<EChartsOption>(() => {
    if (!graph || !normalizedGraph) {
      return {};
    }

    const { normalizedNodes, safeEdges } = normalizedGraph;
    const categories = Object.keys(NODE_TYPE_CONFIG).map((key) => ({ name: key }));
    const degreeMap = buildDegreeMap(safeEdges);

    const nodes = normalizedNodes.map((node) => {
      const cfg = getNodeTypeConfig(node.type);
      const degree = degreeMap.get(node.id) ?? 0;
      const symbolSize = Math.max(18, Math.min(60, 18 + degree * 6));
      return {
        id: node.id,
        name: node.name,
        value: degree,
        category: cfg.index,
        symbol: cfg.symbol,
        symbolSize,
        itemStyle: {
          color: cfg.color,
          borderColor: colors?.border ?? "#e2e8f0",
          borderWidth: node.id === graph.seed.id ? 4 : 2
        },
        label: {
          show: symbolSize >= 30 || node.id === graph.seed.id,
          formatter: "{b}",
          fontWeight: node.id === graph.seed.id ? ("bold" as const) : ("normal" as const)
        },
        originalData: {
          type: node.type,
          degree
        }
      };
    });

    const nodeNameById = new Map(normalizedNodes.map((node) => [node.id, node.name]));
    const nodeIndexById = new Map<string, number>();
    nodes.forEach((node, index) => {
      nodeIndexById.set(node.id, index);
    });

    const links = safeEdges.flatMap((edge) => {
      const sourceIndex = nodeIndexById.get(edge.from);
      const targetIndex = nodeIndexById.get(edge.to);
      if (sourceIndex === undefined || targetIndex === undefined) {
        return [];
      }
      return {
        source: sourceIndex,
        target: targetIndex,
        value: edge.weight,
        lineStyle: {
          width: Math.max(1, Math.min(5, edge.weight)),
          opacity: Math.max(0.25, Math.min(0.9, 0.2 + edge.confidence * 0.7)),
          color: getConfidenceColor(edge.confidence),
          curveness: 0.15
        },
        originalData: {
          type: edge.type,
          confidence: edge.confidence,
          sourceId: edge.from,
          targetId: edge.to
        }
      };
    });

    return {
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: colors?.background ?? "rgba(15, 23, 42, 0.92)",
        textStyle: { color: colors?.foreground ?? "#f8fafc", fontFamily },
        formatter: (params: any) => {
          const data = params?.data ?? {};
          if (params?.dataType === "edge") {
            const meta = data.originalData ?? {};
            const sourceId =
              typeof meta.sourceId === "string"
                ? meta.sourceId
                : typeof data.source === "number"
                  ? nodes[data.source]?.id
                  : "";
            const targetId =
              typeof meta.targetId === "string"
                ? meta.targetId
                : typeof data.target === "number"
                  ? nodes[data.target]?.id
                  : "";
            const sourceName = sourceId ? nodeNameById.get(sourceId) ?? sourceId : "";
            const targetName = targetId ? nodeNameById.get(targetId) ?? targetId : "";
            return [
              `<div style="font-weight:600;margin-bottom:6px;">${sourceName && targetName ? `${sourceName} -> ${targetName}` : (meta.type ?? "edge")}</div>`,
              `<div>type: ${meta.type ?? "edge"}</div>`,
              `<div>weight: ${Number(data.value ?? 0).toFixed(2)}</div>`,
              meta.confidence !== undefined ? `<div>confidence: ${Number(meta.confidence).toFixed(2)}</div>` : ""
            ].join("");
          }
          const meta = data.originalData ?? {};
          return [
            `<div style="font-weight:600;margin-bottom:6px;">${data.name ?? ""}</div>`,
            `<div>type: ${meta.type ?? "unknown"}</div>`,
            `<div>degree: ${meta.degree ?? 0}</div>`
          ].join("");
        }
      },
      legend: [
        {
          data: categories.map((c) => c.name),
          type: "scroll",
          bottom: 0,
          textStyle: { color: colors?.foreground ?? "#1f2933", fontFamily }
        }
      ],
      series: [
        {
          type: "graph",
          layout: "force",
          roam: true,
          draggable: true,
          focusNodeAdjacency: true,
          cursor: "pointer",
          data: nodes,
          links,
          categories,
          force: {
            repulsion: 220,
            edgeLength: [60, 160],
            gravity: 0.08
          },
          label: {
            color: colors?.foreground ?? "#0f172a",
            fontFamily
          },
          emphasis: {
            focus: "adjacency"
          }
        }
      ]
    };
  }, [colors, fontFamily, graph, normalizedGraph]);

  if (sessionStatus === "loading") {
    return (
      <div className="h-[420px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (authenticated && !canReadDashboards) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("common.accessDeniedDescription", {
            defaultValue:
              "You don't have permission to view this data. Contact an administrator if you need access."
          })}
        />
      </div>
    );
  }

  if (settingsLoading) {
    return (
      <div className="h-[420px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (settingsError) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={settingsError.message}
          actionLabel={t("common.retry", { defaultValue: "Retry" })}
          onAction={() => void refetchSettings()}
        />
      </div>
    );
  }

  if (isDisabledByAdmin) {
    return (
      <div className="h-[420px]">
        <ChartEmptyState
          variant="offline"
          title={t("dashboard.charts.knowledgeGraphDisabledTitle", { defaultValue: "Disabled" })}
          description={t("dashboard.charts.knowledgeGraphDisabledDescription", { defaultValue: "Disabled by admin" })}
        />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "0.75rem" }}>
        <div style={{ maxWidth: 360, width: "100%" }}>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              value={seedDraft}
              status={seedError ? "error" : undefined}
              onChange={(evt) => {
                setSeedDraft(evt.target.value);
                setSeedError(null);
              }}
              onPressEnter={(event) => handleSearch(event.currentTarget.value)}
              placeholder={t("dashboard.charts.knowledgeGraphSeedPlaceholder", { defaultValue: "Entity name" })}
              allowClear
            />
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={loading}
              aria-label={t("common.search", { defaultValue: "Search" })}
              onClick={() => handleSearch()}
            />
          </Space.Compact>
          {seedError ? (
            <Text type="danger" className="text-xs">
              {seedError}
            </Text>
          ) : null}
        </div>
        <Space size="middle">
          <div>
            <Text type="secondary">
              {t("dashboard.charts.knowledgeGraphDepth", { defaultValue: "Depth" })}: {maxDepth}
            </Text>
            <Slider min={1} max={5} step={1} value={maxDepth} onChange={(value) => setMaxDepth(value)} style={{ width: 160 }} />
          </div>
          <div>
            <Text type="secondary">
              {t("dashboard.charts.knowledgeGraphMaxNodes", { defaultValue: "Max nodes" })}: {maxNodes}
            </Text>
            <Slider min={50} max={500} step={25} value={maxNodes} onChange={(value) => setMaxNodes(value)} style={{ width: 160 }} />
          </div>
        </Space>
      </div>

      {seedName ? (
        <Space size="small" wrap style={{ marginBottom: "0.75rem" }}>
          <Tag color="geekblue" className="text-xs">
            {t("dashboard.charts.knowledgeGraphSeedLabel", { defaultValue: "Entity" })}: {seedName}
          </Tag>
          {loading ? (
            <Tag color="processing" className="text-xs">
              {t("dashboard.charts.knowledgeGraphSearching", { defaultValue: "Searching..." })}
            </Tag>
          ) : null}
        </Space>
      ) : null}

      {settings ? (
        <Space size="small" wrap style={{ marginBottom: "0.75rem" }}>
          <Tag color="default" className="text-xs">
            Time: not range-filtered
          </Tag>
          <Tag color="blue">
            {t("settings.knowledgeGraph.fields.minEdgeConfidence")}:{" "}
            {Number(settings.minEdgeConfidence ?? 0).toFixed(2)}
          </Tag>
          {settings.dynamicEdgeConfidenceEnabled ? (
            <Tag>
              {t("settings.knowledgeGraph.fields.dynamicEdgeConfidenceEnabled")}{" "}
              Q{Number(settings.dynamicEdgeConfidenceQuantile ?? 0.25).toFixed(2)}
            </Tag>
          ) : null}
          {settings.multiModelValidationEnabled ? (
            <Tag color="green">{t("settings.knowledgeGraph.fields.multiModelValidationEnabled")}</Tag>
          ) : null}
          {settings.entityDisambiguationEnabled ? (
            <Tag color="geekblue">{t("settings.knowledgeGraph.fields.entityDisambiguationEnabled")}</Tag>
          ) : null}
          {degradationStats.filteredNodes > 0 || degradationStats.filteredEdges > 0 ? (
            <Tooltip
              title={t("dashboard.charts.knowledgeGraph.filteredTooltip", {
                filteredNodes: degradationStats.filteredNodes,
                totalNodes: degradationStats.totalNodes,
                filteredEdges: degradationStats.filteredEdges,
                totalEdges: degradationStats.totalEdges,
                defaultValue: `${degradationStats.filteredNodes} 个重复/无效节点和 ${degradationStats.filteredEdges} 个无效链接已被隐藏，以确保图谱正常显示。`
              })}
            >
              <Tag
                color="orange"
                icon={<WarningOutlined />}
                className="text-xs cursor-help"
              >
                {t("dashboard.charts.knowledgeGraph.filtered", {
                  nodes: degradationStats.filteredNodes,
                  edges: degradationStats.filteredEdges,
                  defaultValue: `已过滤 ${degradationStats.filteredNodes} 节点 / ${degradationStats.filteredEdges} 链接`
                })}
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error.message}
          action={
            <a
              onClick={(evt) => {
                evt.preventDefault();
                void refetch();
              }}
            >
              {t("common.retry")}
            </a>
          }
          style={{ marginBottom: "0.75rem" }}
        />
      ) : null}

      {!seedName ? (
        <div className="h-[360px] transition-all duration-300">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphEmptyTitle", { defaultValue: "No data" })}
            description={t("dashboard.charts.knowledgeGraphEmptyDescription", {
              defaultValue: "Search an entity to load real graph data"
            })}
          />
        </div>
      ) : loading ? (
        <div className="h-[360px] flex items-center transition-all duration-300">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : graph ? (
        <div className="h-[360px] transition-all duration-300">
          <DashboardChart
            option={option}
            theme={echartsTheme}
            height="100%"
            onEvents={[
              {
                type: "click",
                handler: (params: any) => {
                  if (params?.dataType !== "node") {
                    return;
                  }
                  const data = params.data ?? {};
                  const id = typeof data.id === "string" ? data.id : "";
                  const name = typeof data.name === "string" ? data.name : "";
                  if (!id || !name) {
                    return;
                  }
                  const meta = data.originalData ?? {};
                  setSelectedNode({
                    id,
                    name,
                    type: typeof meta.type === "string" ? meta.type : undefined,
                    degree: typeof meta.degree === "number" ? meta.degree : undefined
                  });
                  setNodeDrawerOpen(true);
                }
              }
            ]}
          />
        </div>
      ) : (
        <div className="h-[360px] transition-all duration-300">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphNotFoundTitle", { defaultValue: "Not found" })}
            description={t("dashboard.charts.knowledgeGraphNotFoundDescription", {
              defaultValue: "No graph data found for this entity"
            })}
          />
        </div>
      )}
      <Drawer
        open={nodeDrawerOpen && Boolean(selectedNode)}
        onClose={() => setNodeDrawerOpen(false)}
        placement="right"
        width={380}
        title={selectedNode?.name ?? t("dashboard.charts.knowledgeGraphNodeTitle", { defaultValue: "Node" })}
      >
        {selectedNode ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <div>
              <Text type="secondary">
                {t("dashboard.charts.knowledgeGraphNodeType", { defaultValue: "Type" })}: {selectedNode.type ?? "-"}
              </Text>
              <br />
              <Text type="secondary">
                {t("dashboard.charts.knowledgeGraphNodeDegree", { defaultValue: "Degree" })}: {selectedNode.degree ?? 0}
              </Text>
            </div>
            <Space wrap>
              <Button
                type="primary"
                onClick={() => {
                  setSeedDraft(selectedNode.name);
                  setSeedName(selectedNode.name);
                  setSeedError(null);
                  setNodeDrawerOpen(false);
                }}
              >
                {t("dashboard.charts.knowledgeGraphExplore", { defaultValue: "Explore this node" })}
              </Button>
              <Button
                onClick={() => {
                  const toastId = toast.loading(
                    t("dashboard.charts.knowledgeGraphOpeningSearch", {
                      query: selectedNode.name,
                      defaultValue: `Opening search for "${selectedNode.name}"...`
                    })
                  );
                  const handle = window.open(
                    `/search?q=${encodeURIComponent(selectedNode.name)}`,
                    "_blank",
                    "noopener,noreferrer"
                  );
                  window.setTimeout(() => {
                    if (handle) {
                      toast.success(
                        t("dashboard.charts.knowledgeGraphOpenedSearch", {
                          query: selectedNode.name,
                          defaultValue: `Search opened for "${selectedNode.name}" in a new tab`
                        }),
                        { id: toastId }
                      );
                    } else {
                      toast.error(
                        t("common.popupBlocked", { defaultValue: "Popup blocked. Please allow popups for this site." }),
                        { id: toastId }
                      );
                    }
                  }, 200);
                }}
              >
                {t("dashboard.charts.knowledgeGraphOpenSearch", { defaultValue: "Open search" })}
              </Button>
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(selectedNode.name)
                    .then(() => toast.success(t("common.copied", { defaultValue: "Copied" })))
                    .catch(() => toast.error(t("common.copyFailed", { defaultValue: "Copy failed" })));
                }}
              >
                {t("common.copy", { defaultValue: "Copy" })}
              </Button>
            </Space>
            <Text type="secondary" className="text-xs">
              {t("dashboard.charts.knowledgeGraphExploreHint", {
                defaultValue: "Tip: use \"Explore this node\" to re-center the graph on it."
              })}
            </Text>
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}

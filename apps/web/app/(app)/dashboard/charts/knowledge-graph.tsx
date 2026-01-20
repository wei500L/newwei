"use client";

import { Alert, Input, Skeleton, Slider, Space, Tag, Typography, message } from "antd";
import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const [messageApi, contextHolder] = message.useMessage();
  const [seedDraft, setSeedDraft] = useState("");
  const [seedName, setSeedName] = useState<string>("");
  const [maxDepth, setMaxDepth] = useState<number>(2);
  const [maxNodes, setMaxNodes] = useState<number>(200);
  const [settingsApplied, setSettingsApplied] = useState(false);

  const { data: settingsData, loading: settingsLoading } = useKnowledgeGraphSettingsQuery({
    fetchPolicy: "cache-and-network"
  });

  const settings = settingsData?.knowledgeGraphSettings;
  const enabled = settings?.enabled ?? false;

  useEffect(() => {
    if (settingsApplied) {
      return;
    }
    if (settings) {
      setSettingsApplied(true);
      return;
    }
    if (!settingsLoading) {
      setSettingsApplied(true);
    }
  }, [settings, settingsApplied, settingsLoading]);

  const handleSearch = useCallback(
    (value?: string) => {
      const next = (value ?? seedDraft).trim();
      if (!next) {
        messageApi.warning(t("dashboard.charts.knowledgeGraphSeedRequired", { defaultValue: "Enter a seed entity" }));
        return;
      }
      setSeedName(next);
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
    skip: !enabled || !settingsApplied || !seedName
  });

  const graph = data?.getKnowledgeGraphSubgraph ?? null;

  const option = useMemo<EChartsOption>(() => {
    if (!graph) {
      return {};
    }

    const degreeMap = buildDegreeMap(graph.edges);

    const categories = Object.keys(NODE_TYPE_CONFIG).map((key) => ({ name: key }));

    const nodes = graph.nodes.map((node) => {
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

    const links = graph.edges.map((edge) => ({
      source: edge.from,
      target: edge.to,
      value: edge.weight,
      lineStyle: {
        width: Math.max(1, Math.min(5, edge.weight)),
        opacity: Math.max(0.25, Math.min(0.9, 0.2 + edge.confidence * 0.7)),
        color: getConfidenceColor(edge.confidence),
        curveness: 0.15
      },
      originalData: {
        type: edge.type,
        confidence: edge.confidence
      }
    }));

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
            return [
              `<div style="font-weight:600;margin-bottom:6px;">${meta.type ?? "edge"}</div>`,
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
  }, [colors, fontFamily, graph]);

  if (enabled === false) {
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

  if (!settingsApplied) {
    return (
      <div className="h-[420px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "0.75rem" }}>
        <Input.Search
          value={seedDraft}
          onChange={(evt) => setSeedDraft(evt.target.value)}
          onSearch={handleSearch}
          placeholder={t("dashboard.charts.knowledgeGraphSeedPlaceholder", { defaultValue: "Seed entity name" })}
          allowClear
          style={{ maxWidth: 360 }}
        />
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

      {settings ? (
        <Space size="small" wrap style={{ marginBottom: "0.75rem" }}>
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
        <div className="h-[360px]">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphEmptyTitle", { defaultValue: "No seed" })}
            description={t("dashboard.charts.knowledgeGraphEmptyDescription", { defaultValue: "Enter a seed entity to explore" })}
          />
        </div>
      ) : loading ? (
        <div className="h-[360px] flex items-center">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : graph ? (
        <DashboardChart
          option={option}
          theme={echartsTheme}
          height={360}
        />
      ) : (
        <div className="h-[360px]">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphNotFoundTitle", { defaultValue: "Not found" })}
            description={t("dashboard.charts.knowledgeGraphNotFoundDescription", { defaultValue: "No graph data found for this seed" })}
          />
        </div>
      )}
    </>
  );
}

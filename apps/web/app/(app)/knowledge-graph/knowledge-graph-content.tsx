"use client";

import {
  AppstoreOutlined,
  CopyOutlined,
  FilterOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  List,
  Select,
  Skeleton,
  Slider,
  Space,
  Tag,
  Typography
} from "antd";
import cytoscape, { type Core, type EdgeSingular, type ElementDefinition, type NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import {
  useGetKnowledgeGraphSubgraphQuery,
  type GetKnowledgeGraphSubgraphQuery,
  useKnowledgeGraphEdgeEvidenceLazyQuery,
  useKnowledgeGraphSettingsQuery
} from "@/graphql/generated";
import { usePendingAction } from "@/hooks/use-pending-action";
import dayjs from "@/lib/dayjs";
import {
  buildKnowledgeGraphExplorerHref,
  formatKnowledgeGraphLabel,
  KNOWLEDGE_GRAPH_DEFAULT_EVIDENCE_LIMIT,
  KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH,
  KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES,
  KNOWLEDGE_GRAPH_MAX_DEPTH,
  KNOWLEDGE_GRAPH_MAX_NODES,
  KNOWLEDGE_GRAPH_MIN_DEPTH,
  KNOWLEDGE_GRAPH_MIN_NODES,
  KNOWLEDGE_GRAPH_RELATION_TYPES,
  normalizeKnowledgeGraphSeedType,
  parseKnowledgeGraphExplorerParams,
  type KnowledgeGraphRelationType,
  type KnowledgeGraphSeedType
} from "@/lib/knowledge-graph-explorer";

cytoscape.use(fcose);

const { Title, Text, Paragraph } = Typography;

const NODE_COLORS: Record<string, string> = {
  company: "#2563eb",
  industry: "#16a34a",
  person: "#f97316",
  policy: "#dc2626",
  commodity: "#9333ea",
  instrument: "#0891b2",
  organization: "#64748b"
};

const NODE_TYPE_OPTIONS: { label: string; value: KnowledgeGraphSeedType }[] = [
  { label: "Company", value: "company" },
  { label: "Industry", value: "industry" },
  { label: "Person", value: "person" },
  { label: "Policy", value: "policy" },
  { label: "Commodity", value: "commodity" },
  { label: "Instrument", value: "instrument" },
  { label: "Organization", value: "organization" }
];

type GraphNode = NonNullable<
  GetKnowledgeGraphSubgraphQuery["getKnowledgeGraphSubgraph"]
>["nodes"][number];
type GraphEdge = NonNullable<
  GetKnowledgeGraphSubgraphQuery["getKnowledgeGraphSubgraph"]
>["edges"][number];

function getNodeColor(type: string) {
  return NODE_COLORS[type.trim().toLowerCase()] ?? "#94a3b8";
}

function buildDegreeMap(edges: readonly GraphEdge[]) {
  const degreeMap = new Map<string, number>();
  for (const edge of edges) {
    degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + 1);
    degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + 1);
  }
  return degreeMap;
}

function readNestedString(value: unknown, path: readonly string[]) {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current.trim() : null;
}

function formatJson(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

export function KnowledgeGraphContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status: sessionStatus } = useSession();
  const authenticated = sessionStatus === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadDashboards = permissions.includes("dashboards.read");
  const canReadItems = permissions.includes("items.read");
  const [seedDraft, setSeedDraft] = useState("");
  const [depthDraft, setDepthDraft] = useState(KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH);
  const [maxNodesDraft, setMaxNodesDraft] = useState(KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  const routeState = useMemo(
    () => parseKnowledgeGraphExplorerParams(searchParams),
    [searchParams]
  );

  useEffect(() => {
    setSeedDraft(routeState.seedName);
  }, [routeState.seedName]);

  useEffect(() => {
    setDepthDraft(routeState.maxDepth);
  }, [routeState.maxDepth]);

  useEffect(() => {
    setMaxNodesDraft(routeState.maxNodes);
  }, [routeState.maxNodes]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const syncViewport = () => setIsMobile(window.innerWidth < 1024);
    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  const replaceRouteState = (next: Partial<typeof routeState>) => {
    const href = buildKnowledgeGraphExplorerHref({
      seedName: "seedName" in next ? next.seedName ?? "" : routeState.seedName,
      seedType: "seedType" in next ? next.seedType : routeState.seedType,
      maxDepth: "maxDepth" in next ? next.maxDepth ?? routeState.maxDepth : routeState.maxDepth,
      maxNodes: "maxNodes" in next ? next.maxNodes ?? routeState.maxNodes : routeState.maxNodes,
      relationTypes: "relationTypes" in next ? next.relationTypes ?? [] : routeState.relationTypes
    });
    router.replace(href, { scroll: false });
  };

  const {
    data: settingsData,
    loading: settingsLoading,
    error: settingsError,
    refetch: refetchSettings
  } = useKnowledgeGraphSettingsQuery({
    fetchPolicy: "cache-and-network",
    skip: !authenticated || !canReadDashboards
  });
  const { pending: refreshingSettings, run: refreshSettings } = usePendingAction(
    () => refetchSettings()
  );

  const settings = settingsData?.knowledgeGraphSettings;
  const isDisabledByAdmin = settings?.enabled === false;

  const {
    data,
    loading,
    error,
    refetch
  } = useGetKnowledgeGraphSubgraphQuery({
    variables: {
      input: {
        seedName: routeState.seedName,
        seedType: routeState.seedType,
        maxDepth: routeState.maxDepth,
        maxNodes: routeState.maxNodes,
        relationTypes: routeState.relationTypes
      }
    },
    fetchPolicy: "cache-first",
    skip: !authenticated || !canReadDashboards || isDisabledByAdmin || !routeState.seedName
  });
  const { pending: refreshingGraph, run: refreshGraph } = usePendingAction(
    () => refetch()
  );

  const [
    loadEvidence,
    {
      data: evidenceData,
      loading: evidenceLoading,
      error: evidenceError,
      refetch: refetchEvidence
    }
  ] = useKnowledgeGraphEdgeEvidenceLazyQuery({
    fetchPolicy: "cache-first"
  });
  const { pending: refreshingEvidence, run: refreshEvidence } = usePendingAction(
    async () => {
      if (!canReadItems) {
        return;
      }
      if (refetchEvidence) {
        await refetchEvidence();
        return;
      }
      if (selectedEdgeId) {
        await loadEvidence({
          variables: { edgeId: selectedEdgeId, limit: KNOWLEDGE_GRAPH_DEFAULT_EVIDENCE_LIMIT }
        });
      }
    }
  );

  const graph = data?.getKnowledgeGraphSubgraph ?? null;

  const graphData = useMemo(() => {
    if (!graph) {
      return null;
    }

    const nodeMap = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
      if (node.id.trim()) {
        nodeMap.set(node.id, node);
      }
    }

    const edges = graph.edges.filter(
      (edge) => nodeMap.has(edge.from) && nodeMap.has(edge.to) && edge.from !== edge.to
    );
    const degreeMap = buildDegreeMap(edges);

    return {
      nodeMap,
      edges,
      degreeMap,
      elements: [
        ...Array.from(nodeMap.values()).map((node): ElementDefinition => ({
          data: {
            id: node.id,
            label: node.name,
            type: node.type,
            degree: degreeMap.get(node.id) ?? 0,
            isSeed: node.id === graph.seed.id,
            properties: node.properties ?? null
          }
        })),
        ...edges.map(
          (edge): ElementDefinition => ({
            data: {
              id: edge.id,
              source: edge.from,
              target: edge.to,
              type: edge.type,
              weight: edge.weight,
              confidence: edge.confidence,
              properties: edge.properties ?? null
            }
          })
        )
      ]
    };
  }, [graph]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !graphData) {
      return null;
    }
    return graphData.nodeMap.get(selectedNodeId) ?? null;
  }, [graphData, selectedNodeId]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId || !graphData) {
      return null;
    }
    return graphData.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  }, [graphData, selectedEdgeId]);

  const edgeEvidence = evidenceData?.knowledgeGraphEdgeEvidence ?? [];

  const selectedEdgeDisplay = useMemo(() => {
    if (!selectedEdge || !graphData) {
      return null;
    }
    const sourceNode = graphData.nodeMap.get(selectedEdge.from);
    const targetNode = graphData.nodeMap.get(selectedEdge.to);
    return {
      ...selectedEdge,
      sourceName: sourceNode?.name ?? selectedEdge.from,
      targetName: targetNode?.name ?? selectedEdge.to
    };
  }, [graphData, selectedEdge]);

  useEffect(() => {
    if (!selectedEdgeId || !canReadItems) {
      return;
    }
    void loadEvidence({
      variables: {
        edgeId: selectedEdgeId,
        limit: KNOWLEDGE_GRAPH_DEFAULT_EVIDENCE_LIMIT
      }
    });
  }, [canReadItems, loadEvidence, selectedEdgeId]);

  useEffect(() => {
    if (!graphData) {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      return;
    }
    if (selectedNodeId && !graphData.nodeMap.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
    if (selectedEdgeId && !graphData.edges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [graphData, selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    if (!graphData || !containerRef.current) {
      return;
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements: graphData.elements,
      layout: {
        name: "fcose",
        animate: false,
        fit: true,
        padding: 32,
        nodeRepulsion: 8_000,
        idealEdgeLength: 140,
        edgeElasticity: 0.08,
        gravity: 0.18,
        quality: "proof"
      } as any,
      wheelSensitivity: 0.18,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele: NodeSingular) => getNodeColor(String(ele.data("type") ?? "")),
            label: "data(label)",
            color: "#0f172a",
            "font-size": 11,
            "font-weight": (ele: NodeSingular) => (ele.data("isSeed") ? 700 : 500),
            "border-width": (ele: NodeSingular) => (ele.data("isSeed") ? 3 : 1.5),
            "border-color": "#e2e8f0",
            width: (ele: NodeSingular) => Math.max(28, Math.min(68, 28 + Number(ele.data("degree") ?? 0) * 5)),
            height: (ele: NodeSingular) => Math.max(28, Math.min(68, 28 + Number(ele.data("degree") ?? 0) * 5)),
            "text-wrap": "wrap",
            "text-max-width": "110px",
            "text-valign": "bottom",
            "text-margin-y": 10
          }
        },
        {
          selector: "edge",
          style: {
            width: (ele: EdgeSingular) => Math.max(1.5, Math.min(6, Number(ele.data("weight") ?? 1))),
            "line-color": (ele: EdgeSingular) => {
              const confidence = Number(ele.data("confidence") ?? 0);
              if (confidence >= 0.85) return "#16a34a";
              if (confidence >= 0.7) return "#f59e0b";
              return "#ef4444";
            },
            opacity: (ele: EdgeSingular) => Math.max(0.3, Math.min(0.92, Number(ele.data("confidence") ?? 0.5))),
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "line-color"
          }
        },
        {
          selector: "node:selected",
          style: {
            "border-color": "#0f172a",
            "border-width": 4,
            "overlay-opacity": 0.08,
            "overlay-color": "#1d4ed8"
          }
        },
        {
          selector: "edge:selected",
          style: {
            width: 6,
            "overlay-opacity": 0.06,
            "overlay-color": "#0f172a"
          }
        }
      ]
    });

    cy.on("tap", "node", (event) => {
      const id = String(event.target.id());
      setSelectedNodeId(id);
      setSelectedEdgeId(null);
      if (isMobile) {
        setDetailDrawerOpen(true);
      }
    });

    cy.on("tap", "edge", (event) => {
      const id = String(event.target.id());
      setSelectedEdgeId(id);
      setSelectedNodeId(null);
      if (isMobile) {
        setDetailDrawerOpen(true);
      }
    });

    cy.on("tap", (event) => {
      if (event.target !== cy) {
        return;
      }
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graphData, isMobile]);

  const rerunLayout = () => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.layout({
      name: "fcose",
      animate: true,
      fit: true,
      padding: 32,
      nodeRepulsion: 8_000,
      idealEdgeLength: 140,
      edgeElasticity: 0.08,
      gravity: 0.18,
      quality: "proof"
    } as any).run();
  };

  const controlPanel = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Text type="secondary">
          {t("pages.knowledgeGraph.controls.seed", { defaultValue: "Seed entity" })}
        </Text>
        <Space.Compact className="w-full">
          <Input
            value={seedDraft}
            allowClear
            placeholder={t("pages.knowledgeGraph.controls.seedPlaceholder", {
              defaultValue: "Search a company, policy, commodity, or organization"
            })}
            onChange={(event) => setSeedDraft(event.target.value)}
            onPressEnter={() => replaceRouteState({ seedName: seedDraft.trim() })}
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            onClick={() => replaceRouteState({ seedName: seedDraft.trim() })}
          >
            {t("common.search", { defaultValue: "Search" })}
          </Button>
        </Space.Compact>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Text type="secondary">
            {t("pages.knowledgeGraph.controls.seedType", { defaultValue: "Seed type" })}
          </Text>
          <Select
            allowClear
            value={routeState.seedType}
            placeholder={t("pages.knowledgeGraph.controls.seedTypeAny", { defaultValue: "Any type" })}
            options={NODE_TYPE_OPTIONS.map((option) => ({
              value: option.value,
              label: t(`pages.knowledgeGraph.nodeTypes.${option.value}`, {
                defaultValue: option.label
              })
            }))}
            onChange={(value) => replaceRouteState({ seedType: value ?? undefined })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Text type="secondary">
            {t("pages.knowledgeGraph.controls.relations", { defaultValue: "Relation types" })}
          </Text>
          <Select
            mode="multiple"
            value={routeState.relationTypes}
            placeholder={t("pages.knowledgeGraph.controls.relationsAny", {
              defaultValue: "All relation types"
            })}
            options={KNOWLEDGE_GRAPH_RELATION_TYPES.map((value) => ({
              value,
              label: t(`pages.knowledgeGraph.relations.${value}`, {
                defaultValue: formatKnowledgeGraphLabel(value)
              })
            }))}
            onChange={(value) =>
              replaceRouteState({ relationTypes: value as KnowledgeGraphRelationType[] })
            }
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Text type="secondary">
              {t("pages.knowledgeGraph.controls.depth", { defaultValue: "Depth" })}
            </Text>
            <Text>{depthDraft}</Text>
          </div>
          <Slider
            min={KNOWLEDGE_GRAPH_MIN_DEPTH}
            max={KNOWLEDGE_GRAPH_MAX_DEPTH}
            step={1}
            value={depthDraft}
            onChange={(value) => {
              if (typeof value === "number") {
                setDepthDraft(value);
              }
            }}
            onChangeComplete={(value) => {
              if (typeof value === "number") {
                replaceRouteState({ maxDepth: value });
              }
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Text type="secondary">
              {t("pages.knowledgeGraph.controls.maxNodes", { defaultValue: "Max nodes" })}
            </Text>
            <Text>{maxNodesDraft}</Text>
          </div>
          <Slider
            min={KNOWLEDGE_GRAPH_MIN_NODES}
            max={KNOWLEDGE_GRAPH_MAX_NODES}
            step={25}
            value={maxNodesDraft}
            onChange={(value) => {
              if (typeof value === "number") {
                setMaxNodesDraft(value);
              }
            }}
            onChangeComplete={(value) => {
              if (typeof value === "number") {
                replaceRouteState({ maxNodes: value });
              }
            }}
          />
        </div>
      </div>
      <Space wrap>
        <Button icon={<ReloadOutlined />} onClick={rerunLayout} disabled={!graphData}>
          {t("pages.knowledgeGraph.actions.reflow", { defaultValue: "Reflow layout" })}
        </Button>
        <Button
          onClick={() =>
            replaceRouteState({
              seedName: routeState.seedName,
              seedType: undefined,
              maxDepth: KNOWLEDGE_GRAPH_DEFAULT_MAX_DEPTH,
              maxNodes: KNOWLEDGE_GRAPH_DEFAULT_MAX_NODES,
              relationTypes: []
            })
          }
        >
          {t("common.reset", { defaultValue: "Reset" })}
        </Button>
      </Space>
    </div>
  );

  const detailContent = selectedNode ? (
    <Space direction="vertical" size="middle" className="w-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Title level={5} style={{ margin: 0 }}>
            {selectedNode.name}
          </Title>
          <Text type="secondary">
            {t(`pages.knowledgeGraph.nodeTypes.${selectedNode.type}`, {
              defaultValue: formatKnowledgeGraphLabel(selectedNode.type)
            })}
          </Text>
        </div>
        <Tag color="blue">
          {t("pages.knowledgeGraph.details.degree", { defaultValue: "Degree" })}:{" "}
          {graphData?.degreeMap.get(selectedNode.id) ?? 0}
        </Tag>
      </div>
      <Space wrap>
        <Button
          type="primary"
          icon={<AppstoreOutlined />}
          onClick={() =>
            replaceRouteState({
              seedName: selectedNode.name,
              seedType: normalizeKnowledgeGraphSeedType(selectedNode.type)
            })
          }
        >
          {t("pages.knowledgeGraph.actions.centerNode", { defaultValue: "Set as seed" })}
        </Button>
        <Button
          icon={<SearchOutlined />}
          onClick={() => window.open(`/search?q=${encodeURIComponent(selectedNode.name)}`, "_blank", "noopener")}
        >
          {t("pages.knowledgeGraph.actions.openSearch", { defaultValue: "Open search" })}
        </Button>
        <Button
          icon={<CopyOutlined />}
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
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label={t("pages.knowledgeGraph.details.nodeId", { defaultValue: "Node ID" })}>
          <Text code>{selectedNode.id}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={t("pages.knowledgeGraph.details.type", { defaultValue: "Type" })}>
          {t(`pages.knowledgeGraph.nodeTypes.${selectedNode.type}`, {
            defaultValue: formatKnowledgeGraphLabel(selectedNode.type)
          })}
        </Descriptions.Item>
      </Descriptions>
      {selectedNode.properties ? (
        <Card size="small" title={t("pages.knowledgeGraph.details.properties", { defaultValue: "Properties" })}>
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-700">
            {formatJson(selectedNode.properties)}
          </pre>
        </Card>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("pages.knowledgeGraph.details.noProperties", {
            defaultValue: "No structured properties for this node."
          })}
        />
      )}
    </Space>
  ) : selectedEdgeDisplay ? (
    <Space direction="vertical" size="middle" className="w-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Title level={5} style={{ margin: 0 }}>
            {selectedEdgeDisplay.sourceName} → {selectedEdgeDisplay.targetName}
          </Title>
          <Text type="secondary">
            {t(`pages.knowledgeGraph.relations.${selectedEdgeDisplay.type}`, {
              defaultValue: formatKnowledgeGraphLabel(selectedEdgeDisplay.type)
            })}
          </Text>
        </div>
        <Space direction="vertical" size={4}>
          <Tag color="green">
            {t("pages.knowledgeGraph.details.confidence", { defaultValue: "Confidence" })}:{" "}
            {selectedEdgeDisplay.confidence.toFixed(2)}
          </Tag>
          <Tag color="purple">
            {t("pages.knowledgeGraph.details.weight", { defaultValue: "Weight" })}:{" "}
            {selectedEdgeDisplay.weight.toFixed(2)}
          </Tag>
        </Space>
      </div>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label={t("pages.knowledgeGraph.details.edgeId", { defaultValue: "Edge ID" })}>
          <Text code>{selectedEdgeDisplay.id}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={t("pages.knowledgeGraph.details.from", { defaultValue: "From" })}>
          {selectedEdgeDisplay.sourceName}
        </Descriptions.Item>
        <Descriptions.Item label={t("pages.knowledgeGraph.details.to", { defaultValue: "To" })}>
          {selectedEdgeDisplay.targetName}
        </Descriptions.Item>
      </Descriptions>
      {selectedEdgeDisplay.properties ? (
        <Card size="small" title={t("pages.knowledgeGraph.details.properties", { defaultValue: "Properties" })}>
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-700">
            {formatJson(selectedEdgeDisplay.properties)}
          </pre>
        </Card>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Title level={5} style={{ margin: 0 }}>
          {t("pages.knowledgeGraph.details.evidenceTitle", { defaultValue: "Evidence" })}
        </Title>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={refreshingEvidence}
          disabled={!canReadItems}
          onClick={() => {
            void refreshEvidence();
          }}
        >
          {t("dashboard.actions.retryFetch", { defaultValue: "Retry fetch" })}
        </Button>
      </div>
      {!canReadItems ? (
        <Alert
          type="warning"
          showIcon
          message={t("pages.knowledgeGraph.details.evidencePermissionTitle", {
            defaultValue: "Evidence is restricted"
          })}
          description={t("pages.knowledgeGraph.details.evidencePermissionDescription", {
            defaultValue: "Viewing edge evidence requires the items.read permission."
          })}
        />
      ) : evidenceError ? (
        <RequestErrorBanner
          error={evidenceError}
          presentation="banner"
          onRetry={() => {
            void refreshEvidence();
          }}
          actionLoading={refreshingEvidence}
        />
      ) : evidenceLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : edgeEvidence.length > 0 ? (
        <List
          dataSource={edgeEvidence}
          renderItem={(item) => {
            const quote = readNestedString(item.evidence, ["quote"]);
            const validationOutcome = readNestedString(item.evidence, ["validation", "outcome"]);
            const reviewStatus = readNestedString(item.evidence, ["review", "status"]);

            return (
              <List.Item className="!block rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-4 shadow-sm">
                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a
                        className="text-sm font-semibold text-slate-900 hover:text-blue-600"
                        href={item.article.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.article.title ??
                          t("pages.knowledgeGraph.details.untitledArticle", {
                            defaultValue: "Untitled article"
                          })}
                      </a>
                      <div className="mt-1 text-xs text-slate-500">
                        {dayjs(item.article.crawlAt).format("YYYY-MM-DD HH:mm")}
                      </div>
                    </div>
                    <Space size={4} wrap>
                      {typeof item.confidence === "number" ? (
                        <Tag color="blue">
                          {t("pages.knowledgeGraph.details.evidenceConfidence", {
                            defaultValue: "Evidence"
                          })}{" "}
                          {item.confidence.toFixed(2)}
                        </Tag>
                      ) : null}
                      {validationOutcome ? <Tag color="green">{validationOutcome}</Tag> : null}
                      {reviewStatus ? <Tag color="gold">{reviewStatus}</Tag> : null}
                    </Space>
                  </div>
                  {quote ? (
                    <blockquote className="rounded-xl border-l-4 border-blue-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      {quote}
                    </blockquote>
                  ) : null}
                  {item.article.summary ? (
                    <Paragraph className="!mb-0 text-sm text-slate-600">{item.article.summary}</Paragraph>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {item.extractorVersion ? (
                      <Tag>{item.extractorVersion}</Tag>
                    ) : null}
                    <a href={item.article.url} target="_blank" rel="noreferrer">
                      <Space size={4}>
                        <LinkOutlined />
                        <span>{t("pages.knowledgeGraph.actions.openArticle", { defaultValue: "Open article" })}</span>
                      </Space>
                    </a>
                  </div>
                </div>
              </List.Item>
            );
          }}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("pages.knowledgeGraph.details.noEvidence", {
            defaultValue: "No evidence records were found for this edge."
          })}
        />
      )}
    </Space>
  ) : (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={t("pages.knowledgeGraph.details.empty", {
        defaultValue: "Select a node or edge to inspect details."
      })}
    />
  );

  if (sessionStatus === "loading") {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  if (authenticated && !canReadDashboards) {
    return (
      <div className="min-h-[520px]">
        <ChartEmptyState
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("common.accessDeniedDescription", {
            defaultValue: "You don't have permission to view this data. Contact an administrator if you need access."
          })}
        />
      </div>
    );
  }

  if (settingsLoading) {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  if (settingsError) {
    return (
      <div className="min-h-[520px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={settingsError.message}
          actionLabel={t("dashboard.actions.retryFetch", { defaultValue: "Retry fetch" })}
          actionLoading={refreshingSettings}
          onAction={() => {
            void refreshSettings();
          }}
        />
      </div>
    );
  }

  if (isDisabledByAdmin) {
    return (
      <div className="min-h-[520px]">
        <ChartEmptyState
          variant="offline"
          title={t("dashboard.charts.knowledgeGraphDisabledTitle", { defaultValue: "Disabled" })}
          description={t("dashboard.charts.knowledgeGraphDisabledDescription", {
            defaultValue: "Disabled by admin"
          })}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Title level={4} style={{ margin: 0 }}>
              {t("pages.knowledgeGraph.title", { defaultValue: "Knowledge Graph Explorer" })}
            </Title>
            <Text type="secondary">
              {t("pages.knowledgeGraph.subtitle", {
                defaultValue: "Explore entity relationships, inspect edge evidence, and pivot graph searches without leaving the console."
              })}
            </Text>
          </div>
          {isMobile ? (
            <Button icon={<FilterOutlined />} onClick={() => setFiltersOpen(true)}>
              {t("pages.knowledgeGraph.actions.filters", { defaultValue: "Filters" })}
            </Button>
          ) : null}
        </div>
        <Space wrap>
          <Tag color="geekblue">
            {t("pages.knowledgeGraph.meta.scope", { defaultValue: "Scope" })}:{" "}
            {routeState.seedName || t("pages.knowledgeGraph.meta.scopeEmpty", { defaultValue: "No seed selected" })}
          </Tag>
          <Tag color="default">
            {t("pages.knowledgeGraph.meta.time", { defaultValue: "Time" })}:{" "}
            {t("pages.knowledgeGraph.meta.notRangeFiltered", {
              defaultValue: "Not range-filtered"
            })}
          </Tag>
          {routeState.relationTypes.length > 0 ? (
            <Tag color="purple">
              {t("pages.knowledgeGraph.meta.relationCount", { defaultValue: "Relations" })}:{" "}
              {routeState.relationTypes.length}
            </Tag>
          ) : null}
        </Space>
      </div>

      {isMobile ? null : (
        <div className="glass-panel border border-[var(--border)] p-5">{controlPanel}</div>
      )}

      {error ? (
        <RequestErrorBanner
          error={error}
          presentation="banner"
          onRetry={() => {
            void refreshGraph();
          }}
          actionLoading={refreshingGraph}
        />
      ) : null}

      {!routeState.seedName ? (
        <div className="glass-panel flex min-h-[540px] items-center justify-center border border-[var(--border)] p-6">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphEmptyTitle", { defaultValue: "No data" })}
            description={t("pages.knowledgeGraph.emptyDescription", {
              defaultValue: "Enter a seed entity to load a graph and inspect its evidence-backed relationships."
            })}
          />
        </div>
      ) : loading ? (
        <div className="glass-panel border border-[var(--border)] p-6">
          <Skeleton active paragraph={{ rows: 10 }} />
        </div>
      ) : graphData ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="glass-panel border border-[var(--border)] p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Space wrap>
                <Tag color="blue">
                  {t("pages.knowledgeGraph.meta.nodes", { defaultValue: "Nodes" })}: {graph?.metadata.totalNodes ?? 0}
                </Tag>
                <Tag color="cyan">
                  {t("pages.knowledgeGraph.meta.edges", { defaultValue: "Edges" })}: {graph?.metadata.totalEdges ?? 0}
                </Tag>
                <Tag color="default">
                  {t("pages.knowledgeGraph.meta.generatedAt", { defaultValue: "Generated" })}:{" "}
                  {graph?.metadata.generatedAt
                    ? dayjs(graph.metadata.generatedAt).format("YYYY-MM-DD HH:mm")
                    : "-"}
                </Tag>
              </Space>
              <Button icon={<ReloadOutlined />} onClick={() => {
                void refreshGraph();
              }} loading={refreshingGraph}>
                {t("dashboard.actions.fetchLatest", { defaultValue: "Fetch latest" })}
              </Button>
            </div>
            <div
              ref={containerRef}
              className="min-h-[640px] rounded-[28px] border border-slate-200/80 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.09),_transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.98))]"
            />
          </div>
          {!isMobile ? (
            <div className="glass-panel border border-[var(--border)] p-5">{detailContent}</div>
          ) : null}
        </div>
      ) : (
        <div className="glass-panel flex min-h-[540px] items-center justify-center border border-[var(--border)] p-6">
          <ChartEmptyState
            title={t("dashboard.charts.knowledgeGraphNotFoundTitle", { defaultValue: "Not found" })}
            description={t("dashboard.charts.knowledgeGraphNotFoundDescription", {
              defaultValue: "No graph data found for this entity"
            })}
          />
        </div>
      )}

      <Alert
        type="info"
        showIcon
        message={t("pages.knowledgeGraph.meta.notRangeFiltered", {
          defaultValue: "This graph is currently not filtered by dashboard time range."
        })}
      />

      <Drawer
        open={filtersOpen}
        title={t("pages.knowledgeGraph.actions.filters", { defaultValue: "Filters" })}
        placement="bottom"
        height="80vh"
        onClose={() => setFiltersOpen(false)}
      >
        {controlPanel}
      </Drawer>
      <Drawer
        open={detailDrawerOpen && isMobile && Boolean(selectedNode || selectedEdgeDisplay)}
        title={t("pages.knowledgeGraph.details.drawerTitle", { defaultValue: "Graph details" })}
        placement="bottom"
        height="78vh"
        onClose={() => setDetailDrawerOpen(false)}
      >
        {detailContent}
      </Drawer>
    </div>
  );
}

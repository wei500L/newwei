"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";

type AnyRecord = Record<string, unknown>;

type WorkflowNodeType =
  | "seed-discovery"
  | "list-discovery"
  | "deep-discovery"
  | "url-filter"
  | "content-filter"
  | "page-type-classifier"
  | "url-scorer"
  | "freshness-scorer"
  | "branch"
  | "budget-control"
  | "fallback-strategy"
  | "persist-result";

interface WorkflowSettings {
  executionMode: "layered" | "native" | "hybrid";
  maxDepth: number;
  maxPages: number;
  timeoutMs: number;
  concurrency: number;
  robotsPolicy: "respect" | "ignore";
  domainScope: "inherit_profile" | "registrable_domain" | "strict_hosts";
}

interface WorkflowDefinition {
  version: 1;
  metadata: {
    description?: string | null;
    template?: string | null;
    tags?: string[];
  };
  settings: WorkflowSettings;
  nodes: Array<{
    id: string;
    type: WorkflowNodeType;
    label: string;
    position: { x: number; y: number };
    config: AnyRecord;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }>;
}

interface WorkflowRecord {
  id: string;
  name: string;
  description?: string | null;
  draftDefinition: WorkflowDefinition;
  publishedVersionId?: string | null;
  versions: WorkflowVersionRecord[];
  updatedAt: string;
}

interface WorkflowVersionRecord {
  id: string;
  version: number;
  name: string;
  description?: string | null;
  definition: WorkflowDefinition;
  createdAt: string;
}

interface WorkflowNodeSchema {
  type: WorkflowNodeType;
  displayName: string;
  category: "discovery" | "filter" | "scorer" | "control" | "output";
  description: string;
  defaultLabel: string;
  configSchema: {
    properties?: Record<
      string,
      {
        type?: string;
        enum?: string[];
        default?: unknown;
        minimum?: number;
        maximum?: number;
        items?: { type?: string };
        properties?: Record<string, unknown>;
      }
    >;
  };
  defaults: AnyRecord;
}

interface WorkflowRunTraceEntry {
  timestamp: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  action: string;
  message: string;
  accepted?: boolean;
  ruleHits?: string[];
  scoreDelta?: number;
  freshnessDelta?: number;
  details?: AnyRecord;
}

interface WorkflowCandidate {
  id: string;
  url: string;
  title?: string;
  description?: string;
  pageType?: string;
  score?: number;
  freshnessScore?: number;
  relevanceScore?: number;
  status: "active" | "selected" | "rejected";
  rejectedReason?: string | null;
  trace: WorkflowRunTraceEntry[];
}

interface WorkflowTrialResult {
  runId: string;
  workflow: {
    id: string;
    name: string;
    versionId: string;
    version: number;
  };
  steps: Array<{
    nodeId: string;
    nodeType: WorkflowNodeType;
    label: string;
    status: "completed" | "failed" | "skipped";
    durationMs: number;
    inputCount: number;
    outputCount: number;
    rejectedCount: number;
    sampleUrls: string[];
    error?: string | null;
  }>;
  candidates: WorkflowCandidate[];
  selectedCandidates: WorkflowCandidate[];
  parameterSources: Array<{
    key: string;
    source: string;
    value: unknown;
  }>;
  systemEvents: Array<{
    level: "info" | "warn" | "error";
    message: string;
    details?: AnyRecord;
    timestamp: string;
  }>;
}

interface WorkflowBindingOption {
  label: string;
  value: string;
}

function stringify(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected object JSON");
  }
  return parsed as AnyRecord;
}

function nodeToCanvasNode(definitionNode: WorkflowDefinition["nodes"][number]): Node {
  return {
    id: definitionNode.id,
    type: "default",
    position: definitionNode.position,
    data: {
      label: (
        <div style={{ minWidth: 150 }}>
          <Typography.Text strong style={{ display: "block" }}>
            {definitionNode.label}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {definitionNode.type}
          </Typography.Text>
        </div>
      ),
    },
    style: {
      borderRadius: 14,
      border: "1px solid #d9d9d9",
      background: "#fffdf8",
      padding: 10,
      boxShadow: "0 10px 24px rgba(15, 23, 42, 0.06)",
    },
  };
}

function edgeToCanvasEdge(edge: WorkflowDefinition["edges"][number]): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    animated: false,
    style: { stroke: "#475569", strokeWidth: 1.5 },
  };
}

function workflowDefinitionFromCanvas(
  definition: WorkflowDefinition,
  nodes: Node[],
  edges: Edge[],
): WorkflowDefinition {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({
      ...node,
      position: {
        x: nodeMap.get(node.id)?.position.x ?? node.position.x,
        y: nodeMap.get(node.id)?.position.y ?? node.position.y,
      },
    })),
    edges: edges.map((edge, index) => ({
      id: edge.id || `edge-${index + 1}`,
      source: String(edge.source),
      target: String(edge.target),
      sourceHandle:
        typeof edge.sourceHandle === "string" ? edge.sourceHandle : null,
      targetHandle:
        typeof edge.targetHandle === "string" ? edge.targetHandle : null,
    })),
  };
}

function buildNodeConfigDefaults(schema?: WorkflowNodeSchema | null) {
  return { ...(schema?.defaults ?? {}) };
}

function WorkflowStudioInner({ canManage }: { canManage: boolean }) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const apiClient = useMemo(
    () => (token ? createApiClient({ accessToken: token }) : null),
    [token],
  );
  const [messageApi, messageContextHolder] = message.useMessage();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [trialLoading, setTrialLoading] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [nodeSchemas, setNodeSchemas] = useState<WorkflowNodeSchema[]>([]);
  const [profileOptions, setProfileOptions] = useState<WorkflowBindingOption[]>([]);
  const [newsSourceOptions, setNewsSourceOptions] = useState<WorkflowBindingOption[]>(
    [],
  );
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [trialResult, setTrialResult] = useState<WorkflowTrialResult | null>(null);
  const [candidateDrawer, setCandidateDrawer] = useState<WorkflowCandidate | null>(
    null,
  );
  const [workflowMeta, setWorkflowMeta] = useState({
    name: "",
    description: "",
  });
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [trialSeedUrl, setTrialSeedUrl] = useState("");
  const [trialProfileId, setTrialProfileId] = useState<string>();
  const [trialNewsSourceId, setTrialNewsSourceId] = useState<string>();
  const [trialMaxCandidates, setTrialMaxCandidates] = useState<number>(100);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );
  const selectedNodeDefinition = useMemo(
    () => definition?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [definition, selectedNodeId],
  );
  const selectedNodeSchema = useMemo(
    () =>
      nodeSchemas.find((schema) => schema.type === selectedNodeDefinition?.type) ??
      null,
    [nodeSchemas, selectedNodeDefinition?.type],
  );

  const loadData = useCallback(async () => {
    if (!apiClient) return;
    setLoading(true);
    try {
      const [workflowResponse, schemaResponse, profileResponse, sourceResponse] =
        await Promise.all([
          apiClient.get<WorkflowRecord[]>("admin/crawl-frontier/workflows"),
          apiClient.get<WorkflowNodeSchema[]>(
            "admin/crawl-frontier/workflows/node-schemas",
          ),
          apiClient.get<Array<{ id: string; name: string; matchHost: string }>>(
            "admin/crawl-frontier/profiles",
          ),
          apiClient.get<Array<{ id: string; name: string; url: string }>>(
            "admin/news-sources",
          ),
        ]);
      const workflowItems = workflowResponse.data ?? [];
      setWorkflows(workflowItems);
      setNodeSchemas(schemaResponse.data ?? []);
      setProfileOptions(
        (profileResponse.data ?? []).map((profile) => ({
          label: `${profile.name} (${profile.matchHost})`,
          value: profile.id,
        })),
      );
      setNewsSourceOptions(
        (sourceResponse.data ?? []).map((source) => ({
          label: `${source.name} (${source.url})`,
          value: source.id,
        })),
      );
      if (!selectedWorkflowId && workflowItems[0]) {
        setSelectedWorkflowId(workflowItems[0].id);
      }
    } catch (error) {
      console.warn("Failed to load crawl workflow studio", error);
      messageApi.error("Failed to load crawl strategy workflows");
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, selectedWorkflowId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!selectedWorkflow) {
      setDefinition(null);
      setWorkflowMeta({ name: "", description: "" });
      setNodes([]);
      setEdges([]);
      setSelectedNodeId(undefined);
      return;
    }
    setWorkflowMeta({
      name: selectedWorkflow.name,
      description: selectedWorkflow.description ?? "",
    });
    setDefinition(selectedWorkflow.draftDefinition);
    setNodes(selectedWorkflow.draftDefinition.nodes.map(nodeToCanvasNode));
    setEdges(selectedWorkflow.draftDefinition.edges.map(edgeToCanvasEdge));
    setSelectedNodeId(selectedWorkflow.draftDefinition.nodes[0]?.id);
    setTrialResult(null);
  }, [selectedWorkflow, setEdges, setNodes]);

  const syncDefinition = useCallback(
    (nextDefinition?: WorkflowDefinition | null) => {
      const target = nextDefinition ?? definition;
      if (!target) return;
      setDefinition(workflowDefinitionFromCanvas(target, nodes, edges));
    },
    [definition, edges, nodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `edge-${Date.now()}`,
            style: { stroke: "#475569", strokeWidth: 1.5 },
          },
          current,
        ),
      );
    },
    [setEdges],
  );

  const addNode = useCallback(
    (schema: WorkflowNodeSchema) => {
      if (!definition) return;
      const nextId = `${schema.type}-${Date.now()}`;
      const nextNode = {
        id: nextId,
        type: schema.type,
        label: schema.defaultLabel,
        position: { x: 180 + definition.nodes.length * 40, y: 320 },
        config: buildNodeConfigDefaults(schema),
      } satisfies WorkflowDefinition["nodes"][number];
      const nextDefinition = {
        ...definition,
        nodes: [...definition.nodes, nextNode],
      };
      setDefinition(nextDefinition);
      setNodes((current) => [...current, nodeToCanvasNode(nextNode)]);
      setSelectedNodeId(nextId);
    },
    [definition, setNodes],
  );

  const updateNodeDefinition = useCallback(
    (updater: (node: WorkflowDefinition["nodes"][number]) => WorkflowDefinition["nodes"][number]) => {
      if (!definition || !selectedNodeId) return;
      const nextDefinition = {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === selectedNodeId ? updater(node) : node,
        ),
      };
      setDefinition(nextDefinition);
      setNodes(nextDefinition.nodes.map(nodeToCanvasNode));
    },
    [definition, selectedNodeId, setNodes],
  );

  const saveDraft = useCallback(async () => {
    if (!apiClient || !selectedWorkflow || !definition) return;
    setSaving(true);
    try {
      const payload = {
        name: workflowMeta.name.trim() || selectedWorkflow.name,
        description: workflowMeta.description.trim() || undefined,
        draftDefinition: workflowDefinitionFromCanvas(definition, nodes, edges),
      };
      await apiClient.patch(
        `admin/crawl-frontier/workflows/${selectedWorkflow.id}/draft`,
        payload,
      );
      messageApi.success("Workflow draft saved");
      await loadData();
    } catch (error) {
      console.warn("Failed to save crawl workflow draft", error);
      messageApi.error("Failed to save workflow draft");
    } finally {
      setSaving(false);
    }
  }, [
    apiClient,
    definition,
    edges,
    loadData,
    messageApi,
    nodes,
    selectedWorkflow,
    workflowMeta.description,
    workflowMeta.name,
  ]);

  const publishWorkflow = useCallback(async () => {
    if (!apiClient || !selectedWorkflow) return;
    setPublishing(true);
    try {
      await saveDraft();
      await apiClient.post(
        `admin/crawl-frontier/workflows/${selectedWorkflow.id}/publish`,
        {},
      );
      messageApi.success("Workflow published");
      await loadData();
    } catch (error) {
      console.warn("Failed to publish crawl workflow", error);
      messageApi.error("Failed to publish workflow");
    } finally {
      setPublishing(false);
    }
  }, [apiClient, loadData, messageApi, saveDraft, selectedWorkflow]);

  const createWorkflow = useCallback(async () => {
    if (!apiClient) return;
    setSaving(true);
    try {
      const response = await apiClient.post<WorkflowRecord>(
        "admin/crawl-frontier/workflows",
        {
          name: `Workflow ${new Date().toLocaleTimeString()}`,
        },
      );
      const created = response.data;
      await loadData();
      if (created?.id) {
        setSelectedWorkflowId(created.id);
      }
    } catch (error) {
      console.warn("Failed to create crawl workflow", error);
      messageApi.error("Failed to create workflow");
    } finally {
      setSaving(false);
    }
  }, [apiClient, loadData, messageApi]);

  const runTrial = useCallback(async () => {
    if (!apiClient || !selectedWorkflow) return;
    setTrialLoading(true);
    try {
      await saveDraft();
      const response = await apiClient.post<WorkflowTrialResult>(
        `admin/crawl-frontier/workflows/${selectedWorkflow.id}/trial-run`,
        {
          seedUrl: trialSeedUrl.trim() || undefined,
          profileId: trialProfileId || undefined,
          newsSourceId: trialNewsSourceId || undefined,
          maxCandidates: trialMaxCandidates,
        },
      );
      setTrialResult(response.data ?? null);
      messageApi.success("Workflow trial run completed");
    } catch (error) {
      console.warn("Failed to trial run crawl workflow", error);
      messageApi.error("Failed to trial run workflow");
    } finally {
      setTrialLoading(false);
    }
  }, [
    apiClient,
    messageApi,
    saveDraft,
    selectedWorkflow,
    trialMaxCandidates,
    trialNewsSourceId,
    trialProfileId,
    trialSeedUrl,
  ]);

  const candidateColumns = useMemo<ColumnsType<WorkflowCandidate>>(
    () => [
      {
        title: "Candidate",
        key: "url",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong ellipsis={{ tooltip: record.url }}>
              {record.title || record.url}
            </Typography.Text>
            <Typography.Text type="secondary" ellipsis={{ tooltip: record.url }}>
              {record.url}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: "Status",
        key: "status",
        width: 120,
        render: (_, record) => (
          <Tag
            color={
              record.status === "selected"
                ? "green"
                : record.status === "rejected"
                  ? "red"
                  : "blue"
            }
          >
            {record.status}
          </Tag>
        ),
      },
      {
        title: "Signals",
        key: "signals",
        width: 240,
        render: (_, record) => (
          <Space wrap size={[4, 4]}>
            {record.pageType ? <Tag>{record.pageType}</Tag> : null}
            {typeof record.score === "number" ? (
              <Tag color="blue">{`score:${record.score.toFixed(2)}`}</Tag>
            ) : null}
            {typeof record.freshnessScore === "number" ? (
              <Tag color="gold">{`fresh:${record.freshnessScore.toFixed(2)}`}</Tag>
            ) : null}
            {typeof record.relevanceScore === "number" ? (
              <Tag color="purple">{`rel:${record.relevanceScore.toFixed(2)}`}</Tag>
            ) : null}
          </Space>
        ),
      },
      {
        title: "Reason",
        dataIndex: "rejectedReason",
        key: "rejectedReason",
        width: 140,
      },
      {
        title: "Actions",
        key: "actions",
        width: 110,
        render: (_, record) => (
          <Button size="small" onClick={() => setCandidateDrawer(record)}>
            Explain
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {messageContextHolder}
      <Card
        className="content-card"
        title="Workflow Strategy Studio"
        extra={
          <Space wrap>
            <Button onClick={() => void createWorkflow()} loading={saving} disabled={!canManage}>
              New Workflow
            </Button>
            <Button onClick={() => void saveDraft()} loading={saving} disabled={!canManage || !selectedWorkflow}>
              Save Draft
            </Button>
            <Button type="primary" onClick={() => void publishWorkflow()} loading={publishing} disabled={!canManage || !selectedWorkflow}>
              Publish
            </Button>
            <Button type="primary" ghost onClick={() => void runTrial()} loading={trialLoading} disabled={!selectedWorkflow}>
              Trial Run
            </Button>
          </Space>
        }
      >
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
            <Spin />
          </div>
        ) : (
          <Row gutter={[16, 16]} align="stretch">
            <Col xs={24} xl={5}>
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <Card size="small" title="Workflows" bodyStyle={{ padding: 12 }}>
                  <Select
                    showSearch
                    value={selectedWorkflowId}
                    onChange={setSelectedWorkflowId}
                    style={{ width: "100%" }}
                    options={workflows.map((workflow) => ({
                      label: workflow.name,
                      value: workflow.id,
                    }))}
                    placeholder="Select workflow"
                  />
                  <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 12 }}>
                    {selectedWorkflow ? (
                      <>
                        <Input
                          value={workflowMeta.name}
                          onChange={(event) =>
                            setWorkflowMeta((current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                          placeholder="Workflow name"
                        />
                        <Input.TextArea
                          value={workflowMeta.description}
                          onChange={(event) =>
                            setWorkflowMeta((current) => ({
                              ...current,
                              description: event.target.value,
                            }))
                          }
                          rows={3}
                          placeholder="Workflow description"
                        />
                        <Alert
                          type="info"
                          showIcon
                          message={
                            selectedWorkflow.publishedVersionId
                              ? `Published versions: ${selectedWorkflow.versions.length}`
                              : "Draft only"
                          }
                        />
                      </>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select or create a workflow" />
                    )}
                  </Space>
                </Card>
                <Card size="small" title="Node Palette" bodyStyle={{ padding: 12 }}>
                  <Space wrap size={[8, 8]}>
                    {nodeSchemas.map((schema) => (
                      <Tooltip key={schema.type} title={schema.description}>
                        <Button size="small" onClick={() => addNode(schema)} disabled={!selectedWorkflow}>
                          {schema.displayName}
                        </Button>
                      </Tooltip>
                    ))}
                  </Space>
                </Card>
                <Card size="small" title="Trial Run" bodyStyle={{ padding: 12 }}>
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    <Input
                      value={trialSeedUrl}
                      onChange={(event) => setTrialSeedUrl(event.target.value)}
                      placeholder="https://example.com/news"
                    />
                    <Select
                      allowClear
                      showSearch
                      placeholder="Bind a profile"
                      value={trialProfileId}
                      onChange={setTrialProfileId}
                      options={profileOptions}
                    />
                    <Select
                      allowClear
                      showSearch
                      placeholder="Bind a news source"
                      value={trialNewsSourceId}
                      onChange={setTrialNewsSourceId}
                      options={newsSourceOptions}
                    />
                    <InputNumber
                      min={1}
                      max={500}
                      value={trialMaxCandidates}
                      onChange={(value) => setTrialMaxCandidates(Number(value) || 100)}
                      style={{ width: "100%" }}
                    />
                    <Alert
                      type="warning"
                      showIcon
                      message="Trial run uses the same workflow engine as the backend strategy runtime."
                    />
                  </Space>
                </Card>
              </Space>
            </Col>
            <Col xs={24} xl={12}>
              <Card
                size="small"
                title="Canvas"
                bodyStyle={{ padding: 0, height: 720, background: "#f8fafc" }}
              >
                {definition ? (
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={(_, node) => {
                      syncDefinition();
                      setSelectedNodeId(node.id);
                    }}
                    onPaneClick={() => syncDefinition()}
                    fitView
                  >
                    <Background color="#dbe4f0" gap={18} />
                    <MiniMap />
                    <Controls />
                  </ReactFlow>
                ) : (
                  <div style={{ height: 720, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Empty description="Create a workflow to start editing" />
                  </div>
                )}
              </Card>
            </Col>
            <Col xs={24} xl={7}>
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <Card size="small" title="Inspector" bodyStyle={{ padding: 12 }}>
                  {!selectedNodeDefinition || !selectedNodeSchema ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select a node to inspect" />
                  ) : (
                    <Space direction="vertical" size={10} style={{ width: "100%" }}>
                      <Input
                        value={selectedNodeDefinition.label}
                        onChange={(event) =>
                          updateNodeDefinition((node) => ({
                            ...node,
                            label: event.target.value,
                          }))
                        }
                        placeholder="Node label"
                      />
                      {Object.entries(selectedNodeSchema.configSchema.properties ?? {}).map(
                        ([key, property]) => {
                          const value = selectedNodeDefinition.config[key];
                          if (property.enum?.length) {
                            return (
                              <div key={key}>
                                <Typography.Text type="secondary">{key}</Typography.Text>
                                <Select
                                  value={typeof value === "string" ? value : property.default}
                                  onChange={(nextValue) =>
                                    updateNodeDefinition((node) => ({
                                      ...node,
                                      config: { ...node.config, [key]: nextValue },
                                    }))
                                  }
                                  style={{ width: "100%", marginTop: 4 }}
                                  options={property.enum.map((entry) => ({
                                    label: entry,
                                    value: entry,
                                  }))}
                                />
                              </div>
                            );
                          }
                          if (property.type === "boolean") {
                            return (
                              <div key={key}>
                                <Typography.Text type="secondary">{key}</Typography.Text>
                                <Select
                                  value={value === true ? "true" : value === false ? "false" : String(property.default ?? "false")}
                                  onChange={(nextValue) =>
                                    updateNodeDefinition((node) => ({
                                      ...node,
                                      config: { ...node.config, [key]: nextValue === "true" },
                                    }))
                                  }
                                  style={{ width: "100%", marginTop: 4 }}
                                  options={[
                                    { label: "true", value: "true" },
                                    { label: "false", value: "false" },
                                  ]}
                                />
                              </div>
                            );
                          }
                          if (property.type === "number") {
                            return (
                              <div key={key}>
                                <Typography.Text type="secondary">{key}</Typography.Text>
                                <InputNumber
                                  value={typeof value === "number" ? value : Number(property.default ?? 0)}
                                  min={property.minimum}
                                  max={property.maximum}
                                  onChange={(nextValue) =>
                                    updateNodeDefinition((node) => ({
                                      ...node,
                                      config: {
                                        ...node.config,
                                        [key]: typeof nextValue === "number" ? nextValue : Number(property.default ?? 0),
                                      },
                                    }))
                                  }
                                  style={{ width: "100%", marginTop: 4 }}
                                />
                              </div>
                            );
                          }
                          if (property.type === "array" && property.items?.type === "string") {
                            return (
                              <div key={key}>
                                <Typography.Text type="secondary">{key}</Typography.Text>
                                <Select
                                  mode="tags"
                                  value={Array.isArray(value) ? (value as string[]) : []}
                                  onChange={(nextValue) =>
                                    updateNodeDefinition((node) => ({
                                      ...node,
                                      config: { ...node.config, [key]: nextValue },
                                    }))
                                  }
                                  style={{ width: "100%", marginTop: 4 }}
                                  tokenSeparators={[","]}
                                />
                              </div>
                            );
                          }
                          if (property.type === "object" || property.properties) {
                            return (
                              <div key={key}>
                                <Typography.Text type="secondary">{key}</Typography.Text>
                                <Input.TextArea
                                  rows={5}
                                  value={stringify(value ?? property.default ?? {})}
                                  onChange={(event) => {
                                    try {
                                      const parsed = parseObject(event.target.value);
                                      updateNodeDefinition((node) => ({
                                        ...node,
                                        config: { ...node.config, [key]: parsed },
                                      }));
                                    } catch {
                                      return;
                                    }
                                  }}
                                  style={{ marginTop: 4, fontFamily: "monospace" }}
                                />
                              </div>
                            );
                          }
                          return (
                            <div key={key}>
                              <Typography.Text type="secondary">{key}</Typography.Text>
                              <Input
                                value={typeof value === "string" ? value : String(property.default ?? "")}
                                onChange={(event) =>
                                  updateNodeDefinition((node) => ({
                                    ...node,
                                    config: { ...node.config, [key]: event.target.value },
                                  }))
                                }
                                style={{ marginTop: 4 }}
                              />
                            </div>
                          );
                        },
                      )}
                    </Space>
                  )}
                </Card>
                <Card size="small" title="Workflow Settings" bodyStyle={{ padding: 12 }}>
                  {definition ? (
                    <Form layout="vertical">
                      <Row gutter={[12, 0]}>
                        <Col span={12}>
                          <Form.Item label="Execution Mode">
                            <Select
                              value={definition.settings.executionMode}
                              onChange={(value) =>
                                setDefinition((current) =>
                                  current
                                    ? {
                                        ...current,
                                        settings: {
                                          ...current.settings,
                                          executionMode: value,
                                        },
                                      }
                                    : current,
                                )
                              }
                              options={["layered", "native", "hybrid"].map((value) => ({
                                label: value,
                                value,
                              }))}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="Robots Policy">
                            <Select
                              value={definition.settings.robotsPolicy}
                              onChange={(value) =>
                                setDefinition((current) =>
                                  current
                                    ? {
                                        ...current,
                                        settings: {
                                          ...current.settings,
                                          robotsPolicy: value,
                                        },
                                      }
                                    : current,
                                )
                              }
                              options={[
                                { label: "respect", value: "respect" },
                                { label: "ignore", value: "ignore" },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={[12, 0]}>
                        <Col span={12}>
                          <Form.Item label="Max Depth">
                            <InputNumber
                              min={1}
                              max={8}
                              value={definition.settings.maxDepth}
                              onChange={(value) =>
                                setDefinition((current) =>
                                  current
                                    ? {
                                        ...current,
                                        settings: {
                                          ...current.settings,
                                          maxDepth: Number(value) || 3,
                                        },
                                      }
                                    : current,
                                )
                              }
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="Max Pages">
                            <InputNumber
                              min={1}
                              max={500}
                              value={definition.settings.maxPages}
                              onChange={(value) =>
                                setDefinition((current) =>
                                  current
                                    ? {
                                        ...current,
                                        settings: {
                                          ...current.settings,
                                          maxPages: Number(value) || 60,
                                        },
                                      }
                                    : current,
                                )
                              }
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                    </Form>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No workflow selected" />
                  )}
                </Card>
              </Space>
            </Col>
          </Row>
        )}
      </Card>

      <Card className="content-card" size="small" title="Trial Run Result">
        {!trialResult ? (
          <Empty description="Run a workflow trial to inspect step logs and candidate flow" />
        ) : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Typography.Text type="secondary">Workflow</Typography.Text>
                  <Typography.Title level={5} style={{ marginTop: 8, marginBottom: 0 }}>
                    {trialResult.workflow.name}
                  </Typography.Title>
                  <Typography.Text type="secondary">
                    {`v${trialResult.workflow.version}`}
                  </Typography.Text>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Typography.Text type="secondary">Candidates</Typography.Text>
                  <Typography.Title level={5} style={{ marginTop: 8, marginBottom: 0 }}>
                    {trialResult.candidates.length}
                  </Typography.Title>
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Typography.Text type="secondary">Selected</Typography.Text>
                  <Typography.Title level={5} style={{ marginTop: 8, marginBottom: 0 }}>
                    {trialResult.selectedCandidates.length}
                  </Typography.Title>
                </Card>
              </Col>
            </Row>
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={9}>
                <Card size="small" title="Step Timeline">
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    {trialResult.steps.map((step) => (
                      <Card key={step.nodeId} size="small" style={{ background: "#fffdf8" }}>
                        <Space direction="vertical" size={4} style={{ width: "100%" }}>
                          <Space wrap size={[6, 6]}>
                            <Tag color={step.status === "completed" ? "green" : step.status === "failed" ? "red" : "default"}>
                              {step.status}
                            </Tag>
                            <Tag>{step.nodeType}</Tag>
                            <Tag color="blue">{`${step.durationMs}ms`}</Tag>
                          </Space>
                          <Typography.Text strong>{step.label}</Typography.Text>
                          <Typography.Text type="secondary">
                            {`in ${step.inputCount} / out ${step.outputCount} / rejected ${step.rejectedCount}`}
                          </Typography.Text>
                          {step.error ? <Alert type="error" showIcon message={step.error} /> : null}
                        </Space>
                      </Card>
                    ))}
                  </Space>
                </Card>
              </Col>
              <Col xs={24} xl={15}>
                <Card size="small" title="Candidate Flow">
                  <Table
                    rowKey="id"
                    columns={candidateColumns}
                    dataSource={trialResult.candidates}
                    pagination={{ pageSize: 8 }}
                    size="small"
                  />
                </Card>
              </Col>
            </Row>
            <Card size="small" title="Parameter Sources">
              <Space wrap size={[6, 6]}>
                {trialResult.parameterSources.length === 0 ? (
                  <Typography.Text type="secondary">
                    No workflow parameter overrides were recorded.
                  </Typography.Text>
                ) : (
                  trialResult.parameterSources.map((entry) => (
                    <Tag key={`${entry.key}-${entry.source}`}>
                      {`${entry.source}: ${entry.key}`}
                    </Tag>
                  ))
                )}
              </Space>
            </Card>
          </Space>
        )}
      </Card>

      <Drawer
        title="Candidate Explanation"
        open={Boolean(candidateDrawer)}
        onClose={() => setCandidateDrawer(null)}
        width={720}
      >
        {candidateDrawer ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card size="small">
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Typography.Text strong>{candidateDrawer.title || candidateDrawer.url}</Typography.Text>
                <Typography.Text type="secondary">{candidateDrawer.url}</Typography.Text>
                <Space wrap size={[4, 4]}>
                  <Tag color={candidateDrawer.status === "selected" ? "green" : candidateDrawer.status === "rejected" ? "red" : "blue"}>
                    {candidateDrawer.status}
                  </Tag>
                  {candidateDrawer.pageType ? <Tag>{candidateDrawer.pageType}</Tag> : null}
                  {candidateDrawer.rejectedReason ? <Tag color="red">{candidateDrawer.rejectedReason}</Tag> : null}
                </Space>
              </Space>
            </Card>
            <Card size="small" title="Trace">
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                {candidateDrawer.trace.map((entry, index) => (
                  <Card key={`${entry.nodeId}-${index}`} size="small">
                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                      <Space wrap size={[6, 6]}>
                        <Tag>{entry.nodeType}</Tag>
                        <Tag color={entry.accepted === false ? "red" : "green"}>
                          {entry.action}
                        </Tag>
                        <Typography.Text type="secondary">
                          {new Date(entry.timestamp).toLocaleString()}
                        </Typography.Text>
                      </Space>
                      <Typography.Text>{entry.message}</Typography.Text>
                      {entry.ruleHits?.length ? (
                        <Space wrap size={[4, 4]}>
                          {entry.ruleHits.map((rule) => (
                            <Tag key={`${entry.nodeId}-${rule}`} color="orange">
                              {rule}
                            </Tag>
                          ))}
                        </Space>
                      ) : null}
                      {entry.details ? (
                        <Typography.Paragraph
                          style={{
                            marginBottom: 0,
                            whiteSpace: "pre-wrap",
                            fontFamily: "monospace",
                          }}
                        >
                          {stringify(entry.details)}
                        </Typography.Paragraph>
                      ) : null}
                    </Space>
                  </Card>
                ))}
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}

export function CrawlWorkflowStudio({ canManage }: { canManage: boolean }) {
  return (
    <ReactFlowProvider>
      <WorkflowStudioInner canManage={canManage} />
    </ReactFlowProvider>
  );
}

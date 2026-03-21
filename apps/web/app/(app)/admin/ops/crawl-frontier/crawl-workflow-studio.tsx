"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
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
import {
  buildWorkflowCandidateTraceChain,
  buildWorkflowCandidateTraceSummary,
  buildWorkflowTraceEntryDiffRows,
  buildWorkflowCompareSummary,
  formatWorkflowStepSummary,
  type WorkflowRunEvent,
  type WorkflowVersionCompareResult,
} from "./crawl-workflow-view-model";

type AnyRecord = Record<string, unknown>;

type WorkflowNodeType = string;

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
  rejectedReason?: string | null;
  beforeSnapshot?: AnyRecord;
  afterSnapshot?: AnyRecord;
  details?: AnyRecord;
}

interface WorkflowCandidate {
  id: string;
  sourceNodeId: string;
  url: string;
  title?: string;
  description?: string;
  pageType?: string;
  score?: number;
  freshnessScore?: number;
  relevanceScore?: number;
  status: "active" | "selected" | "rejected";
  rejectedReason?: string | null;
  metadata?: AnyRecord;
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
    level: WorkflowRunEvent["level"];
    eventType: string;
    message: string;
    nodeId?: string | null;
    nodeType?: WorkflowNodeType | null;
    triggerReason?: string | null;
    beforeCount?: number | null;
    afterCount?: number | null;
    rescuedCount?: number | null;
    details?: AnyRecord;
    timestamp: string;
  }>;
}

interface WorkflowBindingOption {
  label: string;
  value: string;
}

interface LinkedFrontierRunRecord {
  id: string;
  workflowRunId?: string | null;
  seedUrl: string;
  status: string;
  createdAt: string;
  metadata?: AnyRecord | null;
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

function WorkflowStudioInner({
  canManage,
  selectedWorkflowIdHint,
}: {
  canManage: boolean;
  selectedWorkflowIdHint?: string | null;
}) {
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
  const [frontierRuns, setFrontierRuns] = useState<LinkedFrontierRunRecord[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [trialResult, setTrialResult] = useState<WorkflowTrialResult | null>(null);
  const [candidateDrawer, setCandidateDrawer] = useState<WorkflowCandidate | null>(
    null,
  );
  const [compareLeftVersionId, setCompareLeftVersionId] = useState<string>();
  const [compareRightVersionId, setCompareRightVersionId] = useState<string>();
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareResult, setCompareResult] =
    useState<WorkflowVersionCompareResult | null>(null);
  const [replayingRunId, setReplayingRunId] = useState<string | null>(null);
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
  const linkedFrontierRuns = useMemo(
    () =>
      frontierRuns.filter((run) => {
        const metadata =
          run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
            ? (run.metadata as AnyRecord)
            : null;
        return metadata?.workflowId === selectedWorkflowId;
      }),
    [frontierRuns, selectedWorkflowId],
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
  const compareSummary = useMemo(
    () => (compareResult ? buildWorkflowCompareSummary(compareResult) : null),
    [compareResult],
  );
  const compareLeftVersion = useMemo(
    () =>
      (selectedWorkflow?.versions ?? []).find(
        (version) => version.id === compareLeftVersionId,
      ) ?? null,
    [compareLeftVersionId, selectedWorkflow?.versions],
  );
  const compareRightVersion = useMemo(
    () =>
      (selectedWorkflow?.versions ?? []).find(
        (version) => version.id === compareRightVersionId,
      ) ?? null,
    [compareRightVersionId, selectedWorkflow?.versions],
  );

  const loadData = useCallback(async () => {
    if (!apiClient) return;
    setLoading(true);
    try {
      const [
        workflowResponse,
        schemaResponse,
        profileResponse,
        sourceResponse,
        frontierRunResponse,
      ] =
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
          apiClient.get<LinkedFrontierRunRecord[]>("admin/crawl-frontier/runs"),
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
      setFrontierRuns(frontierRunResponse.data ?? []);
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

  useEffect(() => {
    const versions = [...(selectedWorkflow?.versions ?? [])].sort(
      (left, right) => right.version - left.version,
    );
    setCompareRightVersionId(versions[0]?.id);
    setCompareLeftVersionId(versions[1]?.id ?? versions[0]?.id);
    setCompareResult(null);
  }, [selectedWorkflow]);

  useEffect(() => {
    if (!selectedWorkflowIdHint) {
      return;
    }
    setSelectedWorkflowId(selectedWorkflowIdHint);
  }, [selectedWorkflowIdHint]);

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

  const runTrial = useCallback(async (workflowVersionId?: string, successLabel?: string) => {
    if (!apiClient || !selectedWorkflow) return;
    setTrialLoading(true);
    try {
      await saveDraft();
      const response = await apiClient.post<WorkflowTrialResult>(
        `admin/crawl-frontier/workflows/${selectedWorkflow.id}/trial-run`,
        {
          workflowVersionId: workflowVersionId || undefined,
          seedUrl: trialSeedUrl.trim() || undefined,
          profileId: trialProfileId || undefined,
          newsSourceId: trialNewsSourceId || undefined,
          maxCandidates: trialMaxCandidates,
        },
      );
      setTrialResult(response.data ?? null);
      messageApi.success(successLabel ?? "Workflow trial run completed");
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

  const loadCompare = useCallback(async () => {
    if (!apiClient || !compareLeftVersionId || !compareRightVersionId) return;
    setCompareLoading(true);
    try {
      const response = await apiClient.post<WorkflowVersionCompareResult>(
        "admin/crawl-frontier/workflows/compare",
        {
          leftVersionId: compareLeftVersionId,
          rightVersionId: compareRightVersionId,
        },
      );
      setCompareResult(response.data ?? null);
    } catch (error) {
      console.warn("Failed to compare crawl workflow versions", error);
      messageApi.error("Failed to compare workflow versions");
    } finally {
      setCompareLoading(false);
    }
  }, [apiClient, compareLeftVersionId, compareRightVersionId, messageApi]);

  const replayWorkflowRun = useCallback(
    async (runId: string) => {
      if (!apiClient) return;
      setReplayingRunId(runId);
      try {
        const response = await apiClient.post<{ runId: string }>(
          `admin/crawl-frontier/workflow-runs/${runId}/replay`,
          {},
        );
        messageApi.success(
          response.data?.runId
            ? `Replay created: ${response.data.runId}`
            : "Workflow replay completed",
        );
      } catch (error) {
        console.warn("Failed to replay crawl workflow run", error);
        messageApi.error("Failed to replay workflow run");
      } finally {
        setReplayingRunId(null);
      }
    },
    [apiClient, messageApi],
  );

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
            {trialResult ? (
              <Button
                onClick={() => void replayWorkflowRun(trialResult.runId)}
                loading={replayingRunId === trialResult.runId}
              >
                Replay Last Run
              </Button>
            ) : null}
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
                <Card size="small" title="Version Compare" bodyStyle={{ padding: 12 }}>
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    <Select
                      allowClear
                      placeholder="Left version"
                      value={compareLeftVersionId}
                      onChange={setCompareLeftVersionId}
                      options={(selectedWorkflow?.versions ?? []).map((version) => ({
                        label: `v${version.version} · ${version.name}`,
                        value: version.id,
                      }))}
                    />
                    <Select
                      allowClear
                      placeholder="Right version"
                      value={compareRightVersionId}
                      onChange={setCompareRightVersionId}
                      options={(selectedWorkflow?.versions ?? []).map((version) => ({
                        label: `v${version.version} · ${version.name}`,
                        value: version.id,
                      }))}
                    />
                    <Space wrap>
                      <Button
                        onClick={() => void loadCompare()}
                        loading={compareLoading}
                        disabled={!compareLeftVersionId || !compareRightVersionId}
                      >
                        Compare Versions
                      </Button>
                      <Button
                        onClick={() =>
                          void runTrial(
                            compareLeftVersionId,
                            compareLeftVersion
                              ? `Trial run started from v${compareLeftVersion.version}`
                              : "Workflow trial run completed",
                          )
                        }
                        disabled={!compareLeftVersionId}
                      >
                        Run Left
                      </Button>
                      <Button
                        onClick={() =>
                          void runTrial(
                            compareRightVersionId,
                            compareRightVersion
                              ? `Trial run started from v${compareRightVersion.version}`
                              : "Workflow trial run completed",
                          )
                        }
                        disabled={!compareRightVersionId}
                      >
                        Run Right
                      </Button>
                    </Space>
                    {compareSummary ? (
                      <Space direction="vertical" size={10} style={{ width: "100%" }}>
                        <Descriptions size="small" column={1} bordered>
                          <Descriptions.Item label="Node delta">
                            {compareSummary.nodeCountDelta}
                          </Descriptions.Item>
                          <Descriptions.Item label="Edge delta">
                            {compareSummary.edgeCountDelta}
                          </Descriptions.Item>
                          <Descriptions.Item label="Changed settings">
                            {compareSummary.changedSettings.length > 0
                              ? compareSummary.changedSettings.join(", ")
                              : "-"}
                          </Descriptions.Item>
                          <Descriptions.Item label="Changed nodes">
                            {compareSummary.changedNodeIds.length > 0
                              ? compareSummary.changedNodeIds.join(", ")
                              : "-"}
                          </Descriptions.Item>
                          <Descriptions.Item label="Binding impact">
                            {`${compareSummary.profileImpactCount} profiles / ${compareSummary.newsSourceImpactCount} news sources`}
                          </Descriptions.Item>
                        </Descriptions>
                        {(compareResult!.definitionDiff.settings ?? []).length > 0 ? (
                          <Card size="small" title="Settings Diff">
                            <Space direction="vertical" size={8} style={{ width: "100%" }}>
                              {(compareResult!.definitionDiff.settings ?? []).map((entry) => (
                                <Card key={entry.key} size="small">
                                  <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                    <Typography.Text strong>{entry.key}</Typography.Text>
                                    <Typography.Text type="secondary">
                                      {`${JSON.stringify(entry.left)} -> ${JSON.stringify(entry.right)}`}
                                    </Typography.Text>
                                  </Space>
                                </Card>
                              ))}
                            </Space>
                          </Card>
                        ) : null}
                        <Card size="small" title="Node Diff">
                          <Space direction="vertical" size={8} style={{ width: "100%" }}>
                            {(compareResult!.definitionDiff.nodes?.added ?? []).map((node) => (
                              <Card key={`added-${node.id}`} size="small">
                                <Space wrap size={[6, 6]}>
                                  <Tag color="green">added</Tag>
                                  <Tag>{node.type}</Tag>
                                  <Typography.Text strong>{node.label}</Typography.Text>
                                </Space>
                              </Card>
                            ))}
                            {(compareResult!.definitionDiff.nodes?.removed ?? []).map((node) => (
                              <Card key={`removed-${node.id}`} size="small">
                                <Space wrap size={[6, 6]}>
                                  <Tag color="red">removed</Tag>
                                  <Tag>{node.type}</Tag>
                                  <Typography.Text strong>{node.label}</Typography.Text>
                                </Space>
                              </Card>
                            ))}
                            {(compareResult!.definitionDiff.nodes?.changed ?? []).map((node) => (
                              <Card key={`changed-${node.id}`} size="small">
                                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                  <Space wrap size={[6, 6]}>
                                    <Tag color="gold">changed</Tag>
                                    <Tag>{node.right.type}</Tag>
                                    <Typography.Text strong>{node.right.label}</Typography.Text>
                                  </Space>
                                  <Typography.Text type="secondary">
                                    {`fields: ${node.changedFields.join(", ")}`}
                                  </Typography.Text>
                                </Space>
                              </Card>
                            ))}
                            {(compareResult!.definitionDiff.nodes?.added.length ?? 0) === 0 &&
                            (compareResult!.definitionDiff.nodes?.removed.length ?? 0) === 0 &&
                            (compareResult!.definitionDiff.nodes?.changed.length ?? 0) === 0 ? (
                              <Typography.Text type="secondary">
                                No node-level differences detected.
                              </Typography.Text>
                            ) : null}
                          </Space>
                        </Card>
                        <Card size="small" title="Edge Diff">
                          <Space direction="vertical" size={8} style={{ width: "100%" }}>
                            {(compareResult!.definitionDiff.edges?.added ?? []).map((edge) => (
                              <Typography.Text key={`edge-added-${edge.id}`}>
                                {`+ ${edge.source} -> ${edge.target}`}
                              </Typography.Text>
                            ))}
                            {(compareResult!.definitionDiff.edges?.removed ?? []).map((edge) => (
                              <Typography.Text key={`edge-removed-${edge.id}`} type="secondary">
                                {`- ${edge.source} -> ${edge.target}`}
                              </Typography.Text>
                            ))}
                            {(compareResult!.definitionDiff.edges?.added.length ?? 0) === 0 &&
                            (compareResult!.definitionDiff.edges?.removed.length ?? 0) === 0 ? (
                              <Typography.Text type="secondary">
                                No edge-level differences detected.
                              </Typography.Text>
                            ) : null}
                          </Space>
                        </Card>
                        {compareResult!.bindingImpact ? (
                          <Card size="small" title="Binding Impact">
                            <Space direction="vertical" size={10} style={{ width: "100%" }}>
                              <Descriptions size="small" column={1} bordered>
                                <Descriptions.Item label="Profiles">
                                  {`${compareResult!.bindingImpact.profiles.total} total · ${compareResult!.bindingImpact.profiles.followingPublishedCount} following published`}
                                </Descriptions.Item>
                                <Descriptions.Item label="News sources">
                                  {`${compareResult!.bindingImpact.newsSources.total} total · ${compareResult!.bindingImpact.newsSources.followingPublishedCount} following published`}
                                </Descriptions.Item>
                              </Descriptions>
                              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                                {compareResult!.bindingImpact.profiles.items.slice(0, 4).map((entry) => (
                                  <Card key={`profile-impact-${entry.id}`} size="small">
                                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                      <Space wrap size={[6, 6]}>
                                        <Tag color="geekblue">profile</Tag>
                                        <Tag>{entry.workflowBindingMode}</Tag>
                                        <Tag color="cyan">{entry.appliesTo}</Tag>
                                      </Space>
                                      <Typography.Text strong>{entry.name}</Typography.Text>
                                      {entry.matchHost ? (
                                        <Typography.Text type="secondary">
                                          {entry.matchHost}
                                        </Typography.Text>
                                      ) : null}
                                    </Space>
                                  </Card>
                                ))}
                                {compareResult!.bindingImpact.newsSources.items.slice(0, 4).map((entry) => (
                                  <Card key={`news-impact-${entry.id}`} size="small">
                                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                                      <Space wrap size={[6, 6]}>
                                        <Tag color="purple">news source</Tag>
                                        <Tag>{entry.workflowBindingMode}</Tag>
                                        <Tag color="cyan">{entry.appliesTo}</Tag>
                                      </Space>
                                      <Typography.Text strong>{entry.name}</Typography.Text>
                                      {entry.url ? (
                                        <Typography.Text type="secondary" ellipsis={{ tooltip: entry.url }}>
                                          {entry.url}
                                        </Typography.Text>
                                      ) : null}
                                    </Space>
                                  </Card>
                                ))}
                              </Space>
                            </Space>
                          </Card>
                        ) : null}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">
                        Select two versions to inspect workflow drift.
                      </Typography.Text>
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
                <Card size="small" title="Linked Frontier Runs" bodyStyle={{ padding: 12 }}>
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    {linkedFrontierRuns.length === 0 ? (
                      <Typography.Text type="secondary">
                        No production frontier runs are currently linked to this workflow.
                      </Typography.Text>
                    ) : (
                      linkedFrontierRuns.slice(0, 6).map((run) => (
                        <Card key={run.id} size="small">
                          <Space
                            direction="vertical"
                            size={4}
                            style={{ width: "100%" }}
                          >
                            <Typography.Text ellipsis={{ tooltip: run.seedUrl }}>
                              {run.seedUrl}
                            </Typography.Text>
                            <Space wrap size={[6, 6]}>
                              <Tag color={run.status === "completed" ? "green" : run.status === "failed" ? "red" : "blue"}>
                                {run.status}
                              </Tag>
                              {run.workflowRunId ? <Tag color="geekblue">trace</Tag> : null}
                            </Space>
                            <Typography.Text type="secondary">
                              {new Date(run.createdAt).toLocaleString()}
                            </Typography.Text>
                          </Space>
                        </Card>
                      ))
                    )}
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
                            {formatWorkflowStepSummary(step)}
                          </Typography.Text>
                          {step.error ? <Alert type="error" showIcon message={step.error} /> : null}
                        </Space>
                      </Card>
                    ))}
                  </Space>
                </Card>
              </Col>
              <Col xs={24} xl={15}>
                <Space direction="vertical" size="large" style={{ width: "100%" }}>
                  <Card size="small" title="Candidate Flow">
                    <Table
                      rowKey="id"
                      columns={candidateColumns}
                      dataSource={trialResult.candidates}
                      pagination={{ pageSize: 8 }}
                      size="small"
                    />
                  </Card>
                  <Card size="small" title="System Events">
                    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                      {trialResult.systemEvents.length === 0 ? (
                        <Typography.Text type="secondary">
                          No system events were recorded during this run.
                        </Typography.Text>
                      ) : (
                        trialResult.systemEvents.map((event, index) => (
                          <Card key={`${event.eventType}-${index}`} size="small">
                            <Space direction="vertical" size={4} style={{ width: "100%" }}>
                              <Space wrap size={[6, 6]}>
                                <Tag
                                  color={
                                    event.level === "error"
                                      ? "red"
                                      : event.level === "warn"
                                        ? "gold"
                                        : "blue"
                                  }
                                >
                                  {event.level}
                                </Tag>
                                <Tag>{event.eventType}</Tag>
                                {event.nodeType ? <Tag>{event.nodeType}</Tag> : null}
                                {event.nodeId ? <Tag>{`node:${event.nodeId}`}</Tag> : null}
                                {event.triggerReason ? (
                                  <Tag color="purple">{event.triggerReason}</Tag>
                                ) : null}
                              </Space>
                              <Typography.Text>{event.message}</Typography.Text>
                              <Typography.Text type="secondary">
                                {new Date(event.timestamp).toLocaleString()}
                              </Typography.Text>
                              {(event.beforeCount !== null && event.beforeCount !== undefined) ||
                              (event.afterCount !== null && event.afterCount !== undefined) ? (
                                <Space wrap size={[4, 4]}>
                                  <Tag color="blue">{`before:${event.beforeCount ?? 0}`}</Tag>
                                  <Tag color="geekblue">{`after:${event.afterCount ?? 0}`}</Tag>
                                  <Tag color="green">{`rescued:${event.rescuedCount ?? 0}`}</Tag>
                                </Space>
                              ) : null}
                              {event.details ? (
                                <Typography.Paragraph
                                  style={{
                                    marginBottom: 0,
                                    whiteSpace: "pre-wrap",
                                    fontFamily: "monospace",
                                  }}
                                >
                                  {stringify(event.details)}
                                </Typography.Paragraph>
                              ) : null}
                            </Space>
                          </Card>
                        ))
                      )}
                    </Space>
                  </Card>
                </Space>
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
                  <Tag>{`source:${candidateDrawer.sourceNodeId}`}</Tag>
                  {candidateDrawer.pageType ? <Tag>{candidateDrawer.pageType}</Tag> : null}
                  {candidateDrawer.rejectedReason ? <Tag color="red">{candidateDrawer.rejectedReason}</Tag> : null}
                </Space>
              </Space>
            </Card>
            <Card size="small" title="Trace Summary">
              {(() => {
                const summary = buildWorkflowCandidateTraceSummary(candidateDrawer);
                const traceChain = buildWorkflowCandidateTraceChain(candidateDrawer);
                return (
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label="Total score delta">
                      {summary.totalScoreDelta.toFixed(2)}
                    </Descriptions.Item>
                    <Descriptions.Item label="Total freshness delta">
                      {summary.totalFreshnessDelta.toFixed(2)}
                    </Descriptions.Item>
                    <Descriptions.Item label="Changed fields" span={2}>
                      <Space wrap>
                        {summary.changedFields.map((field) => (
                          <Tag key={`field-${field}`}>{field}</Tag>
                        ))}
                        {summary.changedFields.length === 0 ? "-" : null}
                      </Space>
                    </Descriptions.Item>
                    <Descriptions.Item label="Rule hits" span={2}>
                      <Space wrap>
                        {summary.ruleHits.map((rule) => (
                          <Tag key={`rule-${rule}`} color="orange">
                            {rule}
                          </Tag>
                        ))}
                        {summary.ruleHits.length === 0 ? "-" : null}
                      </Space>
                    </Descriptions.Item>
                    <Descriptions.Item label="Step chain" span={2}>
                      <Space wrap size={[4, 4]}>
                        {traceChain.map((step) => (
                          <Tag
                            key={step.key}
                            color={
                              step.status === "selected"
                                ? "green"
                                : step.status === "rejected"
                                  ? "red"
                                  : "blue"
                            }
                          >
                            {`${step.index}. ${step.label}`}
                          </Tag>
                        ))}
                      </Space>
                    </Descriptions.Item>
                  </Descriptions>
                );
              })()}
            </Card>
            <Card size="small" title="Trace">
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                {buildWorkflowCandidateTraceChain(candidateDrawer).map((step) => {
                  const entry = step.entry;
                  const diffRows = buildWorkflowTraceEntryDiffRows(entry);
                  return (
                  <Card key={step.key} size="small">
                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                      <Space wrap size={[6, 6]}>
                        <Tag>{entry.nodeType}</Tag>
                        <Tag
                          color={
                            step.status === "selected"
                              ? "green"
                              : step.status === "rejected"
                                ? "red"
                                : "blue"
                          }
                        >
                          {entry.action}
                        </Tag>
                        {step.rejectedReason ? (
                          <Tag color="red">{step.rejectedReason}</Tag>
                        ) : null}
                        <Typography.Text type="secondary">
                          {new Date(entry.timestamp).toLocaleString()}
                        </Typography.Text>
                      </Space>
                      <Typography.Text>{entry.message}</Typography.Text>
                      {step.deltaSummary.length > 0 ? (
                        <Space wrap size={[4, 4]}>
                          {step.deltaSummary.map((delta) => (
                            <Tag key={`${step.key}-${delta}`} color="cyan">
                              {delta}
                            </Tag>
                          ))}
                        </Space>
                      ) : null}
                      {step.changedFields.length > 0 ? (
                        <Space wrap size={[4, 4]}>
                          {step.changedFields.map((field) => (
                            <Tag key={`${step.key}-${field}`}>{field}</Tag>
                          ))}
                        </Space>
                      ) : null}
                      {diffRows.length > 0 ? (
                        <Descriptions size="small" column={1} bordered>
                          {diffRows.map((diff) => (
                            <Descriptions.Item key={`${step.key}-${diff.field}`} label={diff.field}>
                              <Space direction="vertical" size={2} style={{ width: "100%" }}>
                                <Typography.Text type="secondary">
                                  {`before: ${diff.beforeValue}`}
                                </Typography.Text>
                                <Typography.Text>{`after: ${diff.afterValue}`}</Typography.Text>
                              </Space>
                            </Descriptions.Item>
                          ))}
                        </Descriptions>
                      ) : null}
                      {entry.ruleHits?.length ? (
                        <Space wrap size={[4, 4]}>
                          {entry.ruleHits.map((rule) => (
                            <Tag key={`${entry.nodeId}-${rule}`} color="orange">
                              {rule}
                            </Tag>
                          ))}
                        </Space>
                      ) : null}
                      <Collapse
                        size="small"
                        ghost
                        items={[
                          {
                            key: `${step.key}-snapshots`,
                            label: "Raw snapshots",
                            children: (
                              <Row gutter={[12, 12]}>
                                <Col xs={24} md={12}>
                                  <Card size="small" title="Before">
                                    <Typography.Paragraph
                                      style={{
                                        marginBottom: 0,
                                        whiteSpace: "pre-wrap",
                                        fontFamily: "monospace",
                                      }}
                                    >
                                      {stringify(entry.beforeSnapshot ?? {})}
                                    </Typography.Paragraph>
                                  </Card>
                                </Col>
                                <Col xs={24} md={12}>
                                  <Card size="small" title="After">
                                    <Typography.Paragraph
                                      style={{
                                        marginBottom: 0,
                                        whiteSpace: "pre-wrap",
                                        fontFamily: "monospace",
                                      }}
                                    >
                                      {stringify(entry.afterSnapshot ?? {})}
                                    </Typography.Paragraph>
                                  </Card>
                                </Col>
                              </Row>
                            ),
                          },
                        ]}
                      />
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
                )})}
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}

export function CrawlWorkflowStudio({
  canManage,
  selectedWorkflowIdHint,
}: {
  canManage: boolean;
  selectedWorkflowIdHint?: string | null;
}) {
  return (
    <ReactFlowProvider>
      <WorkflowStudioInner
        canManage={canManage}
        selectedWorkflowIdHint={selectedWorkflowIdHint}
      />
    </ReactFlowProvider>
  );
}

"use client";

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
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import "@xyflow/react/dist/style.css";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { SectionHeader } from "@/components/section-header";
import { createApiClient } from "@/lib/api-client";
import {
  findUnsupportedWorkflowProxyIssues,
  getCrawlConfigPolicyIssueTranslationKey,
} from "@/lib/crawl-config-policy";
import { WORKFLOW_CANVAS_GRID_COLOR } from "@/lib/graph-tokens";

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
  nodes: {
    id: string;
    type: WorkflowNodeType;
    label: string;
    position: { x: number; y: number };
    config: AnyRecord;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }[];
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
  steps: {
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
  }[];
  candidates: WorkflowCandidate[];
  selectedCandidates: WorkflowCandidate[];
  parameterSources: {
    key: string;
    source: string;
    value: unknown;
  }[];
  systemEvents: {
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
  }[];
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

function formatPolicyIssues(
  issues: ReturnType<typeof findUnsupportedWorkflowProxyIssues>,
  t: ReturnType<typeof useTranslation>["t"],
) {
  return issues
    .map(
      (issue) =>
        `${issue.path}: ${t(getCrawlConfigPolicyIssueTranslationKey(issue.code), {
          defaultValue: issue.code,
        })}`,
    )
    .join(" ");
}

function nodeToCanvasNode(
  definitionNode: WorkflowDefinition["nodes"][number],
): Node {
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
      borderRadius: 6,
      border: "1px solid var(--border)",
      background: "var(--surface)",
      padding: 10,
      boxShadow: "var(--shadow-surface)",
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
  const { t } = useTranslation();
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
  const [profileOptions, setProfileOptions] = useState<WorkflowBindingOption[]>(
    [],
  );
  const [newsSourceOptions, setNewsSourceOptions] = useState<
    WorkflowBindingOption[]
  >([]);
  const [frontierRuns, setFrontierRuns] = useState<LinkedFrontierRunRecord[]>(
    [],
  );
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [trialResult, setTrialResult] = useState<WorkflowTrialResult | null>(
    null,
  );
  const [candidateDrawer, setCandidateDrawer] =
    useState<WorkflowCandidate | null>(null);
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

  const workflowPolicyIssues = useMemo(
    () => findUnsupportedWorkflowProxyIssues(definition, "draftDefinition"),
    [definition],
  );
  const hasWorkflowPolicyIssues = workflowPolicyIssues.length > 0;
  const workflowPolicyBlockedHint = useMemo(
    () =>
      hasWorkflowPolicyIssues
        ? t("crawl.policy.actionBlockedByUnsupportedProxy")
        : undefined,
    [hasWorkflowPolicyIssues, t],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const selectedWorkflow = useMemo(
    () =>
      workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );
  const linkedFrontierRuns = useMemo(
    () =>
      frontierRuns.filter((run) => {
        const metadata =
          run.metadata &&
          typeof run.metadata === "object" &&
          !Array.isArray(run.metadata)
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
      nodeSchemas.find(
        (schema) => schema.type === selectedNodeDefinition?.type,
      ) ?? null,
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
      ] = await Promise.all([
        apiClient.get<WorkflowRecord[]>("admin/crawl-frontier/workflows"),
        apiClient.get<WorkflowNodeSchema[]>(
          "admin/crawl-frontier/workflows/node-schemas",
        ),
        apiClient.get<{ id: string; name: string; matchHost: string }[]>(
          "admin/crawl-frontier/profiles",
        ),
        apiClient.get<{ id: string; name: string; url: string }[]>(
          "admin/news-sources/options",
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
      messageApi.error(
        t("crawlFrontier.workflowStudio.errors.load"),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, selectedWorkflowId, t]);

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
    (
      updater: (
        node: WorkflowDefinition["nodes"][number],
      ) => WorkflowDefinition["nodes"][number],
    ) => {
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

  const validateWorkflowDefinition = useCallback(
    (nextDefinition: WorkflowDefinition) => {
      const issues = findUnsupportedWorkflowProxyIssues(
        nextDefinition,
        "draftDefinition",
      );
      if (issues.length === 0) {
        return true;
      }
      messageApi.error(formatPolicyIssues(issues, t));
      return false;
    },
    [messageApi, t],
  );

  const saveDraft = useCallback(async () => {
    if (!apiClient || !selectedWorkflow || !definition) return;
    const nextDefinition = workflowDefinitionFromCanvas(definition, nodes, edges);
    if (!validateWorkflowDefinition(nextDefinition)) {
      return false;
    }
    setSaving(true);
    try {
      const payload = {
        name: workflowMeta.name.trim() || selectedWorkflow.name,
        description: workflowMeta.description.trim() || undefined,
        draftDefinition: nextDefinition,
      };
      await apiClient.patch(
        `admin/crawl-frontier/workflows/${selectedWorkflow.id}/draft`,
        payload,
      );
      messageApi.success(
        t("crawlFrontier.workflowStudio.messages.draftSaved"),
      );
      await loadData();
      return true;
    } catch (error) {
      console.warn("Failed to save crawl workflow draft", error);
      messageApi.error(
        t("crawlFrontier.workflowStudio.errors.saveDraft"),
      );
      return false;
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
    t,
    validateWorkflowDefinition,
    workflowMeta.description,
    workflowMeta.name,
  ]);

  const publishWorkflow = useCallback(async () => {
    if (!apiClient || !selectedWorkflow) return;
    setPublishing(true);
    try {
      const saved = await saveDraft();
      if (!saved) {
        return;
      }
      await apiClient.post(
        `admin/crawl-frontier/workflows/${selectedWorkflow.id}/publish`,
        {},
      );
      messageApi.success(
        t("crawlFrontier.workflowStudio.messages.published"),
      );
      await loadData();
    } catch (error) {
      console.warn("Failed to publish crawl workflow", error);
      messageApi.error(
        t("crawlFrontier.workflowStudio.errors.publish"),
      );
    } finally {
      setPublishing(false);
    }
  }, [apiClient, loadData, messageApi, saveDraft, selectedWorkflow, t]);

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
      messageApi.error(
        t("crawlFrontier.workflowStudio.errors.create"),
      );
    } finally {
      setSaving(false);
    }
  }, [apiClient, loadData, messageApi, t]);

  const runTrial = useCallback(
    async (workflowVersionId?: string, successLabel?: string) => {
      if (!apiClient || !selectedWorkflow) return;
      setTrialLoading(true);
      try {
        const saved = await saveDraft();
        if (!saved) {
          return;
        }
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
        messageApi.success(
          successLabel ??
            t("crawlFrontier.workflowStudio.messages.trialCompleted"),
        );
      } catch (error) {
        console.warn("Failed to trial run crawl workflow", error);
        messageApi.error(
          t("crawlFrontier.workflowStudio.errors.trial"),
        );
      } finally {
        setTrialLoading(false);
      }
    },
    [
      apiClient,
      messageApi,
      saveDraft,
      selectedWorkflow,
      trialMaxCandidates,
      trialNewsSourceId,
      trialProfileId,
      trialSeedUrl,
      t,
    ],
  );

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
      messageApi.error(
        t("crawlFrontier.workflowStudio.errors.compare"),
      );
    } finally {
      setCompareLoading(false);
    }
  }, [apiClient, compareLeftVersionId, compareRightVersionId, messageApi, t]);

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
            ? t("crawlFrontier.workflowStudio.messages.replayCreated", {
                runId: response.data.runId,
              })
            : t("crawlFrontier.workflowStudio.messages.replayCompleted"),
        );
      } catch (error) {
        console.warn("Failed to replay crawl workflow run", error);
        messageApi.error(
          t("crawlFrontier.workflowStudio.errors.replay"),
        );
      } finally {
        setReplayingRunId(null);
      }
    },
    [apiClient, messageApi, t],
  );

  const candidateColumns = useMemo<ColumnsType<WorkflowCandidate>>(
    () => [
      {
        title: t("crawlFrontier.workflowStudio.candidates.columns.candidate"),
        key: "url",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong ellipsis={{ tooltip: record.url }}>
              {record.title || record.url}
            </Typography.Text>
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: record.url }}
            >
              {record.url}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: t("crawlFrontier.workflowStudio.candidates.columns.status"),
        key: "status",
        width: 120,
        render: (_, record) => (
          <Tag
            color={
              record.status === "selected"
                ? "success"
                : record.status === "rejected"
                  ? "error"
                  : undefined
            }
          >
            {record.status}
          </Tag>
        ),
      },
      {
        title: t("crawlFrontier.workflowStudio.candidates.columns.signals"),
        key: "signals",
        width: 240,
        render: (_, record) => (
          <Space wrap size={[4, 4]}>
            {record.pageType ? <Tag>{record.pageType}</Tag> : null}
            {typeof record.score === "number" ? (
              <span className="font-mono text-xs text-muted-foreground">{`score ${record.score.toFixed(2)}`}</span>
            ) : null}
            {typeof record.freshnessScore === "number" ? (
              <span className="font-mono text-xs text-muted-foreground">{`fresh ${record.freshnessScore.toFixed(2)}`}</span>
            ) : null}
            {typeof record.relevanceScore === "number" ? (
              <span className="font-mono text-xs text-muted-foreground">{`rel ${record.relevanceScore.toFixed(2)}`}</span>
            ) : null}
          </Space>
        ),
      },
      {
        title: t("crawlFrontier.workflowStudio.candidates.columns.reason"),
        dataIndex: "rejectedReason",
        key: "rejectedReason",
        width: 140,
      },
      {
        title: t("crawlFrontier.workflowStudio.candidates.columns.actions"),
        key: "actions",
        width: 110,
        render: (_, record) => (
          <Button size="small" onClick={() => setCandidateDrawer(record)}>
            {t("crawlFrontier.workflowStudio.candidates.actions.explain")}
          </Button>
        ),
      },
    ],
    [t],
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {messageContextHolder}
      <Card
        className="content-card"
        title={t("crawlFrontier.workflowStudio.title")}
        extra={
          <Space wrap>
            <Button
              onClick={() => void createWorkflow()}
              loading={saving}
              disabled={!canManage}
            >
              {t("crawlFrontier.workflowStudio.actions.newWorkflow")}
            </Button>
            <Button
              onClick={() => void saveDraft()}
              loading={saving}
              disabled={!canManage || !selectedWorkflow || hasWorkflowPolicyIssues}
            >
              {t("crawlFrontier.workflowStudio.actions.saveDraft")}
            </Button>
            <Tooltip title={workflowPolicyBlockedHint}>
              <span>
                <Button
                  type="primary"
                  onClick={() => void publishWorkflow()}
                  loading={publishing}
                  disabled={
                    !canManage || !selectedWorkflow || hasWorkflowPolicyIssues
                  }
                >
                  {t("crawlFrontier.workflowStudio.actions.publish")}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={workflowPolicyBlockedHint}>
              <span>
                <Button
                  type="primary"
                  ghost
                  onClick={() => void runTrial()}
                  loading={trialLoading}
                  disabled={!selectedWorkflow || hasWorkflowPolicyIssues}
                >
                  {t("crawlFrontier.workflowStudio.actions.trialRun")}
                </Button>
              </span>
            </Tooltip>
            {trialResult ? (
              <Button
                onClick={() => void replayWorkflowRun(trialResult.runId)}
                loading={replayingRunId === trialResult.runId}
              >
                {t("crawlFrontier.workflowStudio.actions.replayLastRun")}
              </Button>
            ) : null}
          </Space>
        }
      >
        {loading ? (
          <div
            style={{ display: "flex", justifyContent: "center", padding: 48 }}
          >
            <Spin />
          </div>
        ) : (
          <>
            {workflowPolicyIssues.length > 0 ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message={t("crawl.proxy.unsupportedLegacyTitle")}
                description={formatPolicyIssues(workflowPolicyIssues, t)}
              />
            ) : null}
            <Row gutter={[16, 16]} align="stretch">
            <Col xs={24} xl={5}>
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader title={t("crawlFrontier.workflowStudio.sections.workflows")} />
                  <Select
                    showSearch
                    value={selectedWorkflowId}
                    onChange={setSelectedWorkflowId}
                    style={{ width: "100%" }}
                    options={workflows.map((workflow) => ({
                      label: workflow.name,
                      value: workflow.id,
                    }))}
                    placeholder={t(
                      "crawlFrontier.workflowStudio.placeholders.selectWorkflow",
                    )}
                  />
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
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
                          placeholder={t(
                            "crawlFrontier.workflowStudio.placeholders.workflowName",
                          )}
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
                          placeholder={t(
                            "crawlFrontier.workflowStudio.placeholders.workflowDescription",
                          )}
                        />
                        <Alert
                          type="info"
                          showIcon
                          message={
                            selectedWorkflow.publishedVersionId
                              ? t(
                                  "crawlFrontier.workflowStudio.status.publishedVersions",
                                  {
                                    count: selectedWorkflow.versions.length,
                                  },
                                )
                              : t("crawlFrontier.workflowStudio.status.draftOnly")
                          }
                        />
                      </>
                    ) : (
                      <ChartEmptyState
                        presentation="banner"
                        description={t(
                          "crawlFrontier.workflowStudio.empty.selectWorkflow",
                        )}
                      />
                    )}
                  </Space>
                </section>
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader title={t("crawlFrontier.workflowStudio.sections.compare")} />
                  <Space
                    direction="vertical"
                    size={10}
                    style={{ width: "100%" }}
                  >
                    <Select
                      allowClear
                      placeholder={t(
                        "crawlFrontier.workflowStudio.placeholders.leftVersion",
                      )}
                      value={compareLeftVersionId}
                      onChange={setCompareLeftVersionId}
                      options={(selectedWorkflow?.versions ?? []).map(
                        (version) => ({
                          label: `v${version.version} · ${version.name}`,
                          value: version.id,
                        }),
                      )}
                    />
                    <Select
                      allowClear
                      placeholder={t(
                        "crawlFrontier.workflowStudio.placeholders.rightVersion",
                      )}
                      value={compareRightVersionId}
                      onChange={setCompareRightVersionId}
                      options={(selectedWorkflow?.versions ?? []).map(
                        (version) => ({
                          label: `v${version.version} · ${version.name}`,
                          value: version.id,
                        }),
                      )}
                    />
                    <Space wrap>
                      <Button
                        onClick={() => void loadCompare()}
                        loading={compareLoading}
                        disabled={
                          !compareLeftVersionId || !compareRightVersionId
                        }
                      >
                        {t("crawlFrontier.workflowStudio.actions.compareVersions")}
                      </Button>
                      <Tooltip title={workflowPolicyBlockedHint}>
                        <span>
                          <Button
                            onClick={() =>
                              void runTrial(
                                compareLeftVersionId,
                                compareLeftVersion
                                  ? t(
                                      "crawlFrontier.workflowStudio.messages.trialStartedFromVersion",
                                      {
                                        version: compareLeftVersion.version,
                                      },
                                    )
                                  : t(
                                      "crawlFrontier.workflowStudio.messages.trialCompleted",
                                    ),
                              )
                            }
                            disabled={!compareLeftVersionId || hasWorkflowPolicyIssues}
                          >
                            {t("crawlFrontier.workflowStudio.actions.runLeft")}
                          </Button>
                        </span>
                      </Tooltip>
                      <Tooltip title={workflowPolicyBlockedHint}>
                        <span>
                          <Button
                            onClick={() =>
                              void runTrial(
                                compareRightVersionId,
                                compareRightVersion
                                  ? t(
                                      "crawlFrontier.workflowStudio.messages.trialStartedFromVersion",
                                      {
                                        version: compareRightVersion.version,
                                      },
                                    )
                                  : t(
                                      "crawlFrontier.workflowStudio.messages.trialCompleted",
                                    ),
                              )
                            }
                            disabled={
                              !compareRightVersionId || hasWorkflowPolicyIssues
                            }
                          >
                            {t("crawlFrontier.workflowStudio.actions.runRight")}
                          </Button>
                        </span>
                      </Tooltip>
                    </Space>
                    {compareSummary ? (
                      <Space
                        direction="vertical"
                        size={10}
                        style={{ width: "100%" }}
                      >
                        <Descriptions size="small" column={1} bordered>
                          <Descriptions.Item
                            label={t(
                              "crawlFrontier.workflowStudio.compare.labels.nodeDelta",
                            )}
                          >
                            {compareSummary.nodeCountDelta}
                          </Descriptions.Item>
                          <Descriptions.Item
                            label={t(
                              "crawlFrontier.workflowStudio.compare.labels.edgeDelta",
                            )}
                          >
                            {compareSummary.edgeCountDelta}
                          </Descriptions.Item>
                          <Descriptions.Item
                            label={t(
                              "crawlFrontier.workflowStudio.compare.labels.changedSettings",
                            )}
                          >
                            {compareSummary.changedSettings.length > 0
                              ? compareSummary.changedSettings.join(", ")
                              : "-"}
                          </Descriptions.Item>
                          <Descriptions.Item
                            label={t(
                              "crawlFrontier.workflowStudio.compare.labels.changedNodes",
                            )}
                          >
                            {compareSummary.changedNodeIds.length > 0
                              ? compareSummary.changedNodeIds.join(", ")
                              : "-"}
                          </Descriptions.Item>
                          <Descriptions.Item
                            label={t(
                              "crawlFrontier.workflowStudio.compare.labels.bindingImpact",
                            )}
                          >
                            {`${compareSummary.profileImpactCount} profiles / ${compareSummary.newsSourceImpactCount} news sources`}
                          </Descriptions.Item>
                        </Descriptions>
                        {(compareResult!.definitionDiff.settings ?? []).length >
                        0 ? (
                          <div className="surface-inset">
                            <div className="kicker mb-2">
                              {t(
                                "crawlFrontier.workflowStudio.compare.cards.settingsDiff",
                              )}
                            </div>
                            <Space
                              direction="vertical"
                              size={8}
                              style={{ width: "100%" }}
                            >
                              {(
                                compareResult!.definitionDiff.settings ?? []
                              ).map((entry) => (
                                <div key={entry.key} className="hairline-b py-2">
                                  <Space
                                    direction="vertical"
                                    size={4}
                                    style={{ width: "100%" }}
                                  >
                                    <Typography.Text strong>
                                      {entry.key}
                                    </Typography.Text>
                                    <Typography.Text type="secondary">
                                      {`${JSON.stringify(entry.left)} -> ${JSON.stringify(entry.right)}`}
                                    </Typography.Text>
                                  </Space>
                                </div>
                              ))}
                            </Space>
                          </div>
                        ) : null}
                        <div className="surface-inset">
                          <div className="kicker mb-2">
                            {t(
                              "crawlFrontier.workflowStudio.compare.cards.nodeDiff",
                            )}
                          </div>
                          <Space
                            direction="vertical"
                            size={8}
                            style={{ width: "100%" }}
                          >
                            {(
                              compareResult!.definitionDiff.nodes?.added ?? []
                            ).map((node) => (
                              <div key={`added-${node.id}`} className="hairline-b py-2">
                                <Space wrap size={[6, 6]}>
                                  <Tag color="success">
                                    {t(
                                      "crawlFrontier.workflowStudio.compare.tags.added",
                                    )}
                                  </Tag>
                                  <Tag>{node.type}</Tag>
                                  <Typography.Text strong>
                                    {node.label}
                                  </Typography.Text>
                                </Space>
                              </div>
                            ))}
                            {(
                              compareResult!.definitionDiff.nodes?.removed ?? []
                            ).map((node) => (
                              <div key={`removed-${node.id}`} className="hairline-b py-2">
                                <Space wrap size={[6, 6]}>
                                  <Tag color="error">
                                    {t(
                                      "crawlFrontier.workflowStudio.compare.tags.removed",
                                    )}
                                  </Tag>
                                  <Tag>{node.type}</Tag>
                                  <Typography.Text strong>
                                    {node.label}
                                  </Typography.Text>
                                </Space>
                              </div>
                            ))}
                            {(
                              compareResult!.definitionDiff.nodes?.changed ?? []
                            ).map((node) => (
                              <div key={`changed-${node.id}`} className="hairline-b py-2">
                                <Space
                                  direction="vertical"
                                  size={4}
                                  style={{ width: "100%" }}
                                >
                                  <Space wrap size={[6, 6]}>
                                    <Tag color="warning">
                                      {t(
                                        "crawlFrontier.workflowStudio.compare.tags.changed",
                                      )}
                                    </Tag>
                                    <Tag>{node.right.type}</Tag>
                                    <Typography.Text strong>
                                      {node.right.label}
                                    </Typography.Text>
                                  </Space>
                                  <Typography.Text type="secondary">
                                    {`fields: ${node.changedFields.join(", ")}`}
                                  </Typography.Text>
                                </Space>
                              </div>
                            ))}
                            {(compareResult!.definitionDiff.nodes?.added
                              .length ?? 0) === 0 &&
                            (compareResult!.definitionDiff.nodes?.removed
                              .length ?? 0) === 0 &&
                            (compareResult!.definitionDiff.nodes?.changed
                              .length ?? 0) === 0 ? (
                              <Typography.Text type="secondary">
                                {t(
                                  "crawlFrontier.workflowStudio.compare.empty.nodeDiff",
                                )}
                              </Typography.Text>
                            ) : null}
                          </Space>
                        </div>
                        <div className="flex flex-col gap-2">
                          <p className="kicker m-0">
                            {t(
                              "crawlFrontier.workflowStudio.compare.cards.edgeDiff",
                            )}
                          </p>
                          <Space
                            direction="vertical"
                            size={8}
                            style={{ width: "100%" }}
                          >
                            {(
                              compareResult!.definitionDiff.edges?.added ?? []
                            ).map((edge) => (
                              <Typography.Text key={`edge-added-${edge.id}`}>
                                {`+ ${edge.source} -> ${edge.target}`}
                              </Typography.Text>
                            ))}
                            {(
                              compareResult!.definitionDiff.edges?.removed ?? []
                            ).map((edge) => (
                              <Typography.Text
                                key={`edge-removed-${edge.id}`}
                                type="secondary"
                              >
                                {`- ${edge.source} -> ${edge.target}`}
                              </Typography.Text>
                            ))}
                            {(compareResult!.definitionDiff.edges?.added
                              .length ?? 0) === 0 &&
                            (compareResult!.definitionDiff.edges?.removed
                              .length ?? 0) === 0 ? (
                              <Typography.Text type="secondary">
                                {t(
                                  "crawlFrontier.workflowStudio.compare.empty.edgeDiff",
                                )}
                              </Typography.Text>
                            ) : null}
                          </Space>
                        </div>
                        {compareResult!.bindingImpact ? (
                          <div className="flex flex-col gap-2">
                            <p className="kicker m-0">
                              {t(
                                "crawlFrontier.workflowStudio.compare.cards.bindingImpact",
                              )}
                            </p>
                            <Space
                              direction="vertical"
                              size={10}
                              style={{ width: "100%" }}
                            >
                              <Descriptions size="small" column={1} bordered>
                                <Descriptions.Item
                                  label={t(
                                    "crawlFrontier.workflowStudio.compare.labels.profiles",
                                  )}
                                >
                                  {`${compareResult!.bindingImpact.profiles.total} total · ${compareResult!.bindingImpact.profiles.followingPublishedCount} following published`}
                                </Descriptions.Item>
                                <Descriptions.Item
                                  label={t(
                                    "crawlFrontier.workflowStudio.compare.labels.newsSources",
                                  )}
                                >
                                  {`${compareResult!.bindingImpact.newsSources.total} total · ${compareResult!.bindingImpact.newsSources.followingPublishedCount} following published`}
                                </Descriptions.Item>
                              </Descriptions>
                              <Space
                                direction="vertical"
                                size={6}
                                style={{ width: "100%" }}
                              >
                                {compareResult!.bindingImpact.profiles.items
                                  .slice(0, 4)
                                  .map((entry) => (
                                    <div
                                      key={`profile-impact-${entry.id}`}
                                      className="hairline-b py-2 last:border-b-0"
                                    >
                                      <Space
                                        direction="vertical"
                                        size={4}
                                        style={{ width: "100%" }}
                                      >
                                        <Space wrap size={[6, 6]}>
                                          <Tag>profile</Tag>
                                          <Tag>{entry.workflowBindingMode}</Tag>
                                          <Tag>{entry.appliesTo}</Tag>
                                        </Space>
                                        <Typography.Text strong>
                                          {entry.name}
                                        </Typography.Text>
                                        {entry.matchHost ? (
                                          <Typography.Text type="secondary">
                                            {entry.matchHost}
                                          </Typography.Text>
                                        ) : null}
                                      </Space>
                                    </div>
                                  ))}
                                {compareResult!.bindingImpact.newsSources.items
                                  .slice(0, 4)
                                  .map((entry) => (
                                    <div
                                      key={`news-impact-${entry.id}`}
                                      className="hairline-b py-2 last:border-b-0"
                                    >
                                      <Space
                                        direction="vertical"
                                        size={4}
                                        style={{ width: "100%" }}
                                      >
                                        <Space wrap size={[6, 6]}>
                                          <Tag>news source</Tag>
                                          <Tag>{entry.workflowBindingMode}</Tag>
                                          <Tag>{entry.appliesTo}</Tag>
                                        </Space>
                                        <Typography.Text strong>
                                          {entry.name}
                                        </Typography.Text>
                                        {entry.url ? (
                                          <Typography.Text
                                            type="secondary"
                                            ellipsis={{ tooltip: entry.url }}
                                          >
                                            {entry.url}
                                          </Typography.Text>
                                        ) : null}
                                      </Space>
                                    </div>
                                  ))}
                              </Space>
                            </Space>
                          </div>
                        ) : null}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">
                        {t(
                          "crawlFrontier.workflowStudio.compare.empty.selectVersions",
                        )}
                      </Typography.Text>
                    )}
                  </Space>
                </section>
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader title={t("crawlFrontier.workflowStudio.sections.nodePalette")} />
                  <Space wrap size={[8, 8]}>
                    {nodeSchemas.map((schema) => (
                      <Tooltip key={schema.type} title={schema.description}>
                        <Button
                          size="small"
                          onClick={() => addNode(schema)}
                          disabled={!selectedWorkflow}
                        >
                          {schema.displayName}
                        </Button>
                      </Tooltip>
                    ))}
                  </Space>
                </section>
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader title={t("crawlFrontier.workflowStudio.sections.trialRun")} />
                  <Space
                    direction="vertical"
                    size={10}
                    style={{ width: "100%" }}
                  >
                    <Input
                      value={trialSeedUrl}
                      onChange={(event) => setTrialSeedUrl(event.target.value)}
                      placeholder={t(
                        "crawlFrontier.workflowStudio.placeholders.trialSeedUrl",
                      )}
                    />
                    <Select
                      allowClear
                      showSearch
                      placeholder={t(
                        "crawlFrontier.workflowStudio.placeholders.bindProfile",
                      )}
                      value={trialProfileId}
                      onChange={setTrialProfileId}
                      options={profileOptions}
                    />
                    <Select
                      allowClear
                      showSearch
                      placeholder={t(
                        "crawlFrontier.workflowStudio.placeholders.bindNewsSource",
                      )}
                      value={trialNewsSourceId}
                      onChange={setTrialNewsSourceId}
                      options={newsSourceOptions}
                    />
                    <InputNumber
                      min={1}
                      max={500}
                      value={trialMaxCandidates}
                      onChange={(value) =>
                        setTrialMaxCandidates(Number(value) || 100)
                      }
                      style={{ width: "100%" }}
                    />
                    <Alert
                      type="warning"
                      showIcon
                      message={t(
                        "crawlFrontier.workflowStudio.hints.trialRuntime",
                      )}
                    />
                  </Space>
                </section>
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader
                    title={t(
                      "crawlFrontier.workflowStudio.sections.linkedFrontierRuns",
                    )}
                  />
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    {linkedFrontierRuns.length === 0 ? (
                      <Typography.Text type="secondary">
                        {t(
                          "crawlFrontier.workflowStudio.empty.noLinkedFrontierRuns",
                        )}
                      </Typography.Text>
                    ) : (
                      linkedFrontierRuns.slice(0, 6).map((run) => (
                        <div key={run.id} className="hairline-b py-2 last:border-b-0">
                          <Space
                            direction="vertical"
                            size={4}
                            style={{ width: "100%" }}
                          >
                            <Typography.Text
                              ellipsis={{ tooltip: run.seedUrl }}
                            >
                              {run.seedUrl}
                            </Typography.Text>
                            <Space wrap size={[6, 6]}>
                              <Tag
                                color={
                                  run.status === "completed"
                                    ? "success"
                                    : run.status === "failed"
                                      ? "error"
                                      : undefined
                                }
                              >
                                {run.status}
                              </Tag>
                              {run.workflowRunId ? (
                                <Tag>trace</Tag>
                              ) : null}
                            </Space>
                            <Typography.Text type="secondary">
                              {new Date(run.createdAt).toLocaleString()}
                            </Typography.Text>
                          </Space>
                        </div>
                      ))
                    )}
                  </Space>
                </section>
              </Space>
            </Col>
            <Col xs={24} xl={12}>
              <section className="flex flex-col gap-2">
                <SectionHeader title={t("crawlFrontier.workflowStudio.sections.canvas")} />
                <div className="overflow-hidden rounded-md border border-[var(--border)]">
                  <div className="h-[min(720px,70dvh)] bg-[var(--surface-muted)]">
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
                      <Background color={WORKFLOW_CANVAS_GRID_COLOR} gap={18} />
                      <MiniMap />
                      <Controls />
                    </ReactFlow>
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <ChartEmptyState
                        presentation="banner"
                        description={t(
                          "crawlFrontier.workflowStudio.empty.createToEdit",
                        )}
                      />
                    </div>
                  )}
                  </div>
                </div>
              </section>
            </Col>
            <Col xs={24} xl={7}>
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader title={t("crawlFrontier.workflowStudio.sections.inspector")} />
                  {!selectedNodeDefinition || !selectedNodeSchema ? (
                    <ChartEmptyState
                      presentation="banner"
                      description={t(
                        "crawlFrontier.workflowStudio.empty.selectNode",
                      )}
                    />
                  ) : (
                    <Space
                      direction="vertical"
                      size={10}
                      style={{ width: "100%" }}
                    >
                      <Input
                        value={selectedNodeDefinition.label}
                        onChange={(event) =>
                          updateNodeDefinition((node) => ({
                            ...node,
                            label: event.target.value,
                          }))
                        }
                        placeholder={t(
                          "crawlFrontier.workflowStudio.placeholders.nodeLabel",
                        )}
                      />
                      {Object.entries(
                        selectedNodeSchema.configSchema.properties ?? {},
                      ).map(([key, property]) => {
                        const value = selectedNodeDefinition.config[key];
                        if (property.enum?.length) {
                          return (
                            <div key={key}>
                              <Typography.Text type="secondary">
                                {key}
                              </Typography.Text>
                              <Select
                                value={
                                  typeof value === "string"
                                    ? value
                                    : property.default
                                }
                                onChange={(nextValue) =>
                                  updateNodeDefinition((node) => ({
                                    ...node,
                                    config: {
                                      ...node.config,
                                      [key]: nextValue,
                                    },
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
                              <Typography.Text type="secondary">
                                {key}
                              </Typography.Text>
                              <Select
                                value={
                                  value === true
                                    ? "true"
                                    : value === false
                                      ? "false"
                                      : String(property.default ?? "false")
                                }
                                onChange={(nextValue) =>
                                  updateNodeDefinition((node) => ({
                                    ...node,
                                    config: {
                                      ...node.config,
                                      [key]: nextValue === "true",
                                    },
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
                              <Typography.Text type="secondary">
                                {key}
                              </Typography.Text>
                              <InputNumber
                                value={
                                  typeof value === "number"
                                    ? value
                                    : Number(property.default ?? 0)
                                }
                                min={property.minimum}
                                max={property.maximum}
                                onChange={(nextValue) =>
                                  updateNodeDefinition((node) => ({
                                    ...node,
                                    config: {
                                      ...node.config,
                                      [key]:
                                        typeof nextValue === "number"
                                          ? nextValue
                                          : Number(property.default ?? 0),
                                    },
                                  }))
                                }
                                style={{ width: "100%", marginTop: 4 }}
                              />
                            </div>
                          );
                        }
                        if (
                          property.type === "array" &&
                          property.items?.type === "string"
                        ) {
                          return (
                            <div key={key}>
                              <Typography.Text type="secondary">
                                {key}
                              </Typography.Text>
                              <Select
                                mode="tags"
                                value={
                                  Array.isArray(value)
                                    ? (value as string[])
                                    : []
                                }
                                onChange={(nextValue) =>
                                  updateNodeDefinition((node) => ({
                                    ...node,
                                    config: {
                                      ...node.config,
                                      [key]: nextValue,
                                    },
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
                              <Typography.Text type="secondary">
                                {key}
                              </Typography.Text>
                              <Input.TextArea
                                rows={5}
                                value={stringify(
                                  value ?? property.default ?? {},
                                )}
                                onChange={(event) => {
                                  try {
                                    const parsed = parseObject(
                                      event.target.value,
                                    );
                                    updateNodeDefinition((node) => ({
                                      ...node,
                                      config: { ...node.config, [key]: parsed },
                                    }));
                                  } catch {
                                    return;
                                  }
                                }}
                                style={{
                                  marginTop: 4,
                                  fontFamily: "monospace",
                                }}
                              />
                            </div>
                          );
                        }
                        return (
                          <div key={key}>
                            <Typography.Text type="secondary">
                              {key}
                            </Typography.Text>
                            <Input
                              value={
                                typeof value === "string"
                                  ? value
                                  : String(property.default ?? "")
                              }
                              onChange={(event) =>
                                updateNodeDefinition((node) => ({
                                  ...node,
                                  config: {
                                    ...node.config,
                                    [key]: event.target.value,
                                  },
                                }))
                              }
                              style={{ marginTop: 4 }}
                            />
                          </div>
                        );
                      })}
                    </Space>
                  )}
                </section>
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader
                    title={t(
                      "crawlFrontier.workflowStudio.sections.workflowSettings",
                    )}
                  />
                  {definition ? (
                    <Form layout="vertical">
                      <Row gutter={[12, 0]}>
                        <Col xs={24} md={12}>
                          <Form.Item
                            label={t(
                              "crawlFrontier.workflowStudio.settings.executionMode",
                            )}
                          >
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
                              options={["layered", "native", "hybrid"].map(
                                (value) => ({
                                  label: value,
                                  value,
                                }),
                              )}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item
                            label={t(
                              "crawlFrontier.workflowStudio.settings.robotsPolicy",
                            )}
                          >
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
                        <Col xs={24} md={12}>
                          <Form.Item
                            label={t(
                              "crawlFrontier.workflowStudio.settings.maxDepth",
                            )}
                          >
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
                        <Col xs={24} md={12}>
                          <Form.Item
                            label={t(
                              "crawlFrontier.workflowStudio.settings.maxPages",
                            )}
                          >
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
                    <ChartEmptyState
                      presentation="banner"
                      description={t(
                        "crawlFrontier.workflowStudio.empty.noWorkflowSelected",
                      )}
                    />
                  )}
                </section>
              </Space>
            </Col>
            </Row>
          </>
        )}
      </Card>

      <section className="content-card flex flex-col gap-4 p-4">
        <SectionHeader title={t("crawlFrontier.workflowStudio.sections.trialResult")} />
        {!trialResult ? (
          <ChartEmptyState
            presentation="banner"
            description={t(
              "crawlFrontier.workflowStudio.empty.trialResult",
            )}
          />
        ) : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Statistic
                title={t("crawlFrontier.workflowStudio.trial.workflow")}
                value={trialResult.workflow.name}
                suffix={`v${trialResult.workflow.version}`}
              />
              <div className="md:border-l md:border-[var(--border)] md:pl-4">
                <Statistic
                  title={t("crawlFrontier.workflowStudio.trial.candidates")}
                  value={trialResult.candidates.length}
                />
              </div>
              <div className="md:border-l md:border-[var(--border)] md:pl-4">
                <Statistic
                  title={t("crawlFrontier.workflowStudio.trial.selected")}
                  value={trialResult.selectedCandidates.length}
                />
              </div>
            </div>
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={9}>
                <section className="surface-inset flex flex-col gap-3">
                  <SectionHeader title={t("crawlFrontier.workflowStudio.trial.cards.stepTimeline")} />
                  <Space
                    direction="vertical"
                    size={10}
                    style={{ width: "100%" }}
                  >
                    {trialResult.steps.map((step) => (
                      <div key={step.nodeId} className="hairline-b py-2 last:border-b-0">
                        <Space
                          direction="vertical"
                          size={4}
                          style={{ width: "100%" }}
                        >
                          <Space wrap size={[6, 6]}>
                            <Tag
                              color={
                                step.status === "completed"
                                  ? "success"
                                  : step.status === "failed"
                                    ? "error"
                                    : undefined
                              }
                            >
                              {step.status}
                            </Tag>
                            <Tag>{step.nodeType}</Tag>
                            <span className="font-mono text-xs text-muted-foreground">{`${step.durationMs}ms`}</span>
                          </Space>
                          <Typography.Text strong>{step.label}</Typography.Text>
                          <Typography.Text type="secondary">
                            {formatWorkflowStepSummary(step)}
                          </Typography.Text>
                          {step.error ? (
                            <Alert type="error" showIcon message={step.error} />
                          ) : null}
                        </Space>
                      </div>
                    ))}
                  </Space>
                </section>
              </Col>
              <Col xs={24} xl={15}>
                <Space
                  direction="vertical"
                  size="large"
                  style={{ width: "100%" }}
                >
                  <section className="surface-inset flex flex-col gap-3">
                    <SectionHeader title={t("crawlFrontier.workflowStudio.trial.cards.candidateFlow")} />
                    <Table
                      rowKey="id"
                      columns={candidateColumns}
                      dataSource={trialResult.candidates}
                      pagination={{ pageSize: 8 }}
                      size="small"
                      scroll={{ x: "max-content" }}
                    />
                  </section>
                  <section className="surface-inset flex flex-col gap-3">
                    <SectionHeader title={t("crawlFrontier.workflowStudio.trial.cards.systemEvents")} />
                    <Space
                      direction="vertical"
                      size="middle"
                      style={{ width: "100%" }}
                    >
                      {trialResult.systemEvents.length === 0 ? (
                        <Typography.Text type="secondary">
                          {t(
                            "crawlFrontier.workflowStudio.trial.empty.systemEvents",
                          )}
                        </Typography.Text>
                      ) : (
                        trialResult.systemEvents.map((event, index) => (
                          <div
                            key={`${event.eventType}-${index}`}
                            className="hairline-b py-2 last:border-b-0"
                          >
                            <Space
                              direction="vertical"
                              size={4}
                              style={{ width: "100%" }}
                            >
                              <Space wrap size={[6, 6]}>
                                <Tag
                                  color={
                                    event.level === "error"
                                      ? "error"
                                      : event.level === "warn"
                                        ? "warning"
                                        : undefined
                                  }
                                >
                                  {event.level}
                                </Tag>
                                <Tag>{event.eventType}</Tag>
                                {event.nodeType ? (
                                  <Tag>{event.nodeType}</Tag>
                                ) : null}
                                {event.nodeId ? (
                                  <Tag>{`node:${event.nodeId}`}</Tag>
                                ) : null}
                                {event.triggerReason ? (
                                  <Tag>
                                    {event.triggerReason}
                                  </Tag>
                                ) : null}
                              </Space>
                              <Typography.Text>{event.message}</Typography.Text>
                              <Typography.Text type="secondary">
                                {new Date(event.timestamp).toLocaleString()}
                              </Typography.Text>
                              {(event.beforeCount !== null &&
                                event.beforeCount !== undefined) ||
                              (event.afterCount !== null &&
                                event.afterCount !== undefined) ? (
                                <Space wrap size={[4, 4]}>
                                  <span className="font-mono text-xs text-muted-foreground">{`before ${event.beforeCount ?? 0}`}</span>
                                  <span className="font-mono text-xs text-muted-foreground">{`after ${event.afterCount ?? 0}`}</span>
                                  <span className="font-mono text-xs text-muted-foreground">{`rescued ${event.rescuedCount ?? 0}`}</span>
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
                          </div>
                        ))
                      )}
                    </Space>
                  </section>
                </Space>
              </Col>
            </Row>
            <section className="surface-inset flex flex-col gap-3">
              <SectionHeader title={t("crawlFrontier.workflowStudio.trial.cards.parameterSources")} />
              <Space wrap size={[6, 6]}>
                {trialResult.parameterSources.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t(
                      "crawlFrontier.workflowStudio.trial.empty.parameterSources",
                    )}
                  </Typography.Text>
                ) : (
                  trialResult.parameterSources.map((entry) => (
                    <Tag key={`${entry.key}-${entry.source}`}>
                      {`${entry.source}: ${entry.key}`}
                    </Tag>
                  ))
                )}
              </Space>
            </section>
          </Space>
        )}
      </section>

      <Drawer
        title={t("crawlFrontier.workflowStudio.drawer.candidateExplanation")}
        open={Boolean(candidateDrawer)}
        onClose={() => setCandidateDrawer(null)}
        width="min(720px, 100vw)"
      >
        {candidateDrawer ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <div className="surface-inset flex flex-col gap-2">
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {candidateDrawer.title || candidateDrawer.url}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {candidateDrawer.url}
                </Typography.Text>
                <Space wrap size={[4, 4]}>
                  <Tag
                    color={
                      candidateDrawer.status === "selected"
                        ? "success"
                        : candidateDrawer.status === "rejected"
                          ? "error"
                          : undefined
                    }
                  >
                    {candidateDrawer.status}
                  </Tag>
                  <Tag>{`source:${candidateDrawer.sourceNodeId}`}</Tag>
                  {candidateDrawer.pageType ? (
                    <Tag>{candidateDrawer.pageType}</Tag>
                  ) : null}
                  {candidateDrawer.rejectedReason ? (
                    <Tag>{candidateDrawer.rejectedReason}</Tag>
                  ) : null}
                </Space>
              </Space>
            </div>
            <div className="flex flex-col gap-2">
              <p className="kicker m-0">
                {t("crawlFrontier.workflowStudio.drawer.traceSummary")}
              </p>
              {(() => {
                const summary =
                  buildWorkflowCandidateTraceSummary(candidateDrawer);
                const traceChain =
                  buildWorkflowCandidateTraceChain(candidateDrawer);
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
                          <Tag key={`rule-${rule}`}>
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
                                ? "success"
                                : step.status === "rejected"
                                  ? "error"
                                  : undefined
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
            </div>
            <div className="flex flex-col gap-2">
              <p className="kicker m-0">
                {t("crawlFrontier.workflowStudio.drawer.trace")}
              </p>
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                {buildWorkflowCandidateTraceChain(candidateDrawer).map(
                  (step) => {
                    const entry = step.entry;
                    const diffRows = buildWorkflowTraceEntryDiffRows(entry);
                    return (
                      <div key={step.key} className="hairline-b py-2 last:border-b-0">
                        <Space
                          direction="vertical"
                          size={4}
                          style={{ width: "100%" }}
                        >
                          <Space wrap size={[6, 6]}>
                            <Tag>{entry.nodeType}</Tag>
                            <Tag
                              color={
                                step.status === "selected"
                                  ? "success"
                                  : step.status === "rejected"
                                    ? "error"
                                    : undefined
                              }
                            >
                              {entry.action}
                            </Tag>
                            {step.rejectedReason ? (
                              <Tag>{step.rejectedReason}</Tag>
                            ) : null}
                            <Typography.Text type="secondary">
                              {new Date(entry.timestamp).toLocaleString()}
                            </Typography.Text>
                          </Space>
                          <Typography.Text>{entry.message}</Typography.Text>
                          {step.deltaSummary.length > 0 ? (
                            <Space wrap size={[4, 4]}>
                              {step.deltaSummary.map((delta) => (
                                <Tag key={`${step.key}-${delta}`}>
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
                                <Descriptions.Item
                                  key={`${step.key}-${diff.field}`}
                                  label={diff.field}
                                >
                                  <Space
                                    direction="vertical"
                                    size={2}
                                    style={{ width: "100%" }}
                                  >
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
                                <Tag
                                  key={`${entry.nodeId}-${rule}`}
                                >
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
                                label: t(
                                  "crawlFrontier.workflowStudio.drawer.rawSnapshots",
                                ),
                                children: (
                                  <Row gutter={[12, 12]}>
                                    <Col xs={24} md={12}>
                                      <div className="flex flex-col gap-2">
                                        <p className="kicker m-0">
                                          {t(
                                            "crawlFrontier.workflowStudio.drawer.before",
                                          )}
                                        </p>
                                        <Typography.Paragraph
                                          style={{
                                            marginBottom: 0,
                                            whiteSpace: "pre-wrap",
                                            fontFamily: "monospace",
                                          }}
                                        >
                                          {stringify(
                                            entry.beforeSnapshot ?? {},
                                          )}
                                        </Typography.Paragraph>
                                      </div>
                                    </Col>
                                    <Col xs={24} md={12}>
                                      <div className="flex flex-col gap-2">
                                        <p className="kicker m-0">
                                          {t(
                                            "crawlFrontier.workflowStudio.drawer.after",
                                          )}
                                        </p>
                                        <Typography.Paragraph
                                          style={{
                                            marginBottom: 0,
                                            whiteSpace: "pre-wrap",
                                            fontFamily: "monospace",
                                          }}
                                        >
                                          {stringify(entry.afterSnapshot ?? {})}
                                        </Typography.Paragraph>
                                      </div>
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
                      </div>
                    );
                  },
                )}
              </Space>
            </div>
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

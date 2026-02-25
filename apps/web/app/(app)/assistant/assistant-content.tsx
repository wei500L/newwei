'use client';

import {
  BarChartOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { gql, useLazyQuery, useMutation, useQuery, useSubscription } from '@apollo/client';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { debounce } from 'lodash';
import { useSession } from 'next-auth/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  asRecord,
  buildUserPromptFromRun,
  extractAssistantModelInfo,
  isTerminalStatus,
  resolveAssistantReply,
  type AssistantRunLike,
  type BuildUserPromptStrings,
  type ResolveAssistantReplyStrings,
} from '@/lib/assistant-chat';
import {
  DEFAULT_ASSISTANT_KNOWLEDGE_SOURCE,
  isAssistantWebSearchUnsupportedError,
  isAssistantKnowledgeSourceSupported,
  type AssistantKnowledgeSource,
} from '@/lib/assistant-knowledge-source';
import { MarkdownViewer } from '@/components/markdown-viewer';
import dayjs from '@/lib/dayjs';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

import styles from './assistant-content.module.css';

type AssistantRunType = AssistantRunLike['type'];
type AssistantRunStatus = AssistantRunLike['status'];

interface AssistantRun extends AssistantRunLike {
  id: string;
  type: AssistantRunType;
  status: AssistantRunStatus;
  createdAt: string;
  conversationId?: string | null;
}

interface AssistantRunsQueryData {
  assistantRuns: AssistantRun[];
}

interface AssistantRunsQueryVariables {
  limit?: number | null;
}

interface RequestAssistantQueryData {
  requestAssistantQuery: Pick<AssistantRun, 'id' | 'type' | 'status' | 'createdAt' | 'conversationId'>;
}

interface RequestAssistantQueryVariables {
  input: { message: string; conversationId?: string; knowledgeSource?: AssistantKnowledgeSource };
}

interface RequestAssistantReportData {
  requestAssistantReport: Pick<AssistantRun, 'id' | 'type' | 'status' | 'createdAt'>;
}

interface RequestAssistantReportVariables {
  input: { period: 'daily' | 'weekly'; topic?: string | null; limit?: number | null };
}

interface RequestAssistantForecastData {
  requestAssistantForecast: Pick<AssistantRun, 'id' | 'type' | 'status' | 'createdAt'>;
}

interface RequestAssistantForecastVariables {
  input: {
    series: string;
    lookbackDays?: number | null;
    sourceField?: string | null;
    modelKind?: 'ets' | 'arima' | null;
    seasonalPeriod?: number | null;
    confidenceLevel?: number | null;
  };
}

interface DeleteAssistantRunData {
  deleteAssistantRun: boolean;
}

interface DeleteAssistantRunVariables {
  runId: string;
}

interface AssistantEventsSubscriptionData {
  assistantEvents: Pick<AssistantRun, 'id' | 'type' | 'status' | 'summary' | 'error' | 'createdAt'>;
}

interface AssistantRuntimeCapabilities {
  assistantModel?: string | null;
  apiSurface?: 'chat_completions' | 'responses' | null;
  webSearchSupported: boolean;
}

interface AssistantRuntimeCapabilitiesQueryData {
  assistantRuntimeCapabilities: AssistantRuntimeCapabilities;
}

interface AssistantBlockedInfo {
  message: string;
  code?: string | null;
  appliedGuardrails: string[];
  upstreamStatus: number | null;
}

interface SuggestionItem {
  slug: string;
  displayName: string;
  description?: string;
}

type LiveUpdateRecord = Pick<AssistantRun, 'id' | 'type' | 'status' | 'summary' | 'error' | 'createdAt'> & {
  summaryText: string;
};

const DEFAULT_REPORT_VALUES = { period: 'daily' as const, topic: '', limit: 40 };
const DEFAULT_FORECAST_VALUES = {
  series: '',
  lookbackDays: 365,
  sourceField: '',
  modelKind: 'ets' as const,
  seasonalPeriod: 0,
  confidenceLevel: 0.95,
};
const STREAM_UI_FLUSH_MS = 90;
const CHAT_AUTO_SCROLL_THRESHOLD_PX = 120;

const ASSISTANT_RUNS_QUERY = gql`
  query AssistantRuns($limit: Int) {
    assistantRuns(limit: $limit) {
      id
      type
      status
      summary
      error
      input
      output
      conversationId
      createdAt
    }
  }
`;

const ASSISTANT_EVENTS_SUBSCRIPTION = gql`
  subscription AssistantEvents {
    assistantEvents {
      id
      type
      status
      summary
      error
      createdAt
    }
  }
`;

const ASSISTANT_RUNTIME_CAPABILITIES_QUERY = gql`
  query AssistantRuntimeCapabilities {
    assistantRuntimeCapabilities {
      assistantModel
      apiSurface
      webSearchSupported
    }
  }
`;

const REQUEST_ASSISTANT_QUERY_MUTATION = gql`
  mutation RequestAssistantQuery($input: AssistantQueryInput!) {
    requestAssistantQuery(input: $input) {
      id
      type
      status
      conversationId
      createdAt
    }
  }
`;

const REQUEST_ASSISTANT_REPORT_MUTATION = gql`
  mutation RequestAssistantReport($input: AssistantReportInput!) {
    requestAssistantReport(input: $input) {
      id
      type
      status
      createdAt
    }
  }
`;

const REQUEST_ASSISTANT_FORECAST_MUTATION = gql`
  mutation RequestAssistantForecast($input: AssistantForecastInput!) {
    requestAssistantForecast(input: $input) {
      id
      type
      status
      createdAt
    }
  }
`;

const DELETE_ASSISTANT_RUN_MUTATION = gql`
  mutation DeleteAssistantRun($runId: String!) {
    deleteAssistantRun(runId: $runId)
  }
`;

const ASSISTANT_ECONOMIC_SERIES_SUGGESTIONS = gql`
  query AssistantEconomicSeriesSuggestions($term: String!, $limit: Int) {
    assistantEconomicSeriesSuggestions(term: $term, limit: $limit) {
      slug
      displayName
      description
    }
  }
`;

const getStatusChipClass = (status: AssistantRunStatus): string => {
  switch (status) {
    case 'pending':
      return 'bg-slate-100 text-slate-600 ring-slate-300/60';
    case 'running':
      return 'bg-sky-100 text-sky-700 ring-sky-300/60';
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 ring-emerald-300/60';
    case 'failed':
      return 'bg-rose-100 text-rose-700 ring-rose-300/60';
    default:
      return 'bg-slate-100 text-slate-600 ring-slate-300/60';
  }
};

const getStatusRailClass = (status: AssistantRunStatus): string => {
  switch (status) {
    case 'pending':
      return 'bg-slate-400/70';
    case 'running':
      return 'bg-sky-500';
    case 'completed':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-rose-500';
    default:
      return 'bg-slate-400/70';
  }
};

export function AssistantContent() {
  const { t, i18n } = useTranslation();
  const { message: messageApi } = App.useApp();
  const locale = resolveLocale(i18n.language);

  const { data: session, status } = useSession();
  const authenticated = status === 'authenticated';
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canRunAssistant = permissions.includes('assistant.run');
  const canViewAssistantJson = permissions.includes('settings.manage');

  const [queryDraft, setQueryDraft] = useState('');
  const [knowledgeSource, setKnowledgeSource] = useState<AssistantKnowledgeSource>(
    DEFAULT_ASSISTANT_KNOWLEDGE_SOURCE,
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [forecastModalOpen, setForecastModalOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [deletedRuns, setDeletedRuns] = useState<Record<string, true>>({});

  const [reportForm] = Form.useForm<{ period: 'daily' | 'weekly'; topic?: string; limit?: number }>();
  const [forecastForm] = Form.useForm<{
    series: string;
    lookbackDays?: number;
    sourceField?: string;
    modelKind?: 'ets' | 'arima';
    seasonalPeriod?: number;
    confidenceLevel?: number;
  }>();

  const completedRunsRef = useRef<Set<string>>(new Set());
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<TextAreaRef | null>(null);
  const conversationSessionRef = useRef(0);
  const composerCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousActiveRunIdRef = useRef<string | null>(null);

  const [liveUpdates, setLiveUpdates] = useState<Record<string, LiveUpdateRecord>>({});
  const [optimisticRuns, setOptimisticRuns] = useState<Record<string, AssistantRun>>({});
  const liveUpdatesRef = useRef<Record<string, LiveUpdateRecord>>({});
  const pendingLiveUpdatesRef = useRef<Record<string, LiveUpdateRecord>>({});
  const liveUpdatesFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingLiveUpdates = () => {
    if (liveUpdatesFlushTimerRef.current) {
      clearTimeout(liveUpdatesFlushTimerRef.current);
      liveUpdatesFlushTimerRef.current = null;
    }

    const pending = pendingLiveUpdatesRef.current;
    const ids = Object.keys(pending);
    if (ids.length === 0) {
      return;
    }
    pendingLiveUpdatesRef.current = {};

    setLiveUpdates((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const id of ids) {
        const incoming = pending[id];
        if (!incoming) {
          continue;
        }

        const existing = next[id];
        if (
          existing &&
          existing.status === incoming.status &&
          existing.type === incoming.type &&
          existing.error === incoming.error &&
          existing.createdAt === incoming.createdAt &&
          existing.summaryText === incoming.summaryText
        ) {
          continue;
        }

        next[id] = incoming;
        changed = true;
      }

      return changed ? next : prev;
    });
  };

  const schedulePendingLiveUpdatesFlush = (immediate = false) => {
    if (immediate) {
      flushPendingLiveUpdates();
      return;
    }
    if (liveUpdatesFlushTimerRef.current) {
      return;
    }
    liveUpdatesFlushTimerRef.current = setTimeout(() => {
      liveUpdatesFlushTimerRef.current = null;
      flushPendingLiveUpdates();
    }, STREAM_UI_FLUSH_MS);
  };

  const [fetchSuggestions, { data: suggestionsData, loading: suggestionsLoading }] = useLazyQuery(
    ASSISTANT_ECONOMIC_SERIES_SUGGESTIONS,
  );

  const handleSearch = useMemo(
    () =>
      debounce((value: string) => {
        if (value.length >= 2) {
          fetchSuggestions({ variables: { term: value, limit: 8 } });
        }
      }, 300),
    [fetchSuggestions],
  );

  useEffect(() => {
    return () => handleSearch.cancel();
  }, [handleSearch]);

  useEffect(() => {
    liveUpdatesRef.current = liveUpdates;
  }, [liveUpdates]);

  useEffect(() => {
    return () => {
      if (liveUpdatesFlushTimerRef.current) {
        clearTimeout(liveUpdatesFlushTimerRef.current);
      }
      pendingLiveUpdatesRef.current = {};
    };
  }, []);

  const clearComposerCollapseTimer = () => {
    if (composerCollapseTimerRef.current) {
      clearTimeout(composerCollapseTimerRef.current);
      composerCollapseTimerRef.current = null;
    }
  };

  const expandComposer = () => {
    clearComposerCollapseTimer();
    setComposerExpanded(true);
  };

  const scheduleComposerCollapse = () => {
    clearComposerCollapseTimer();
    composerCollapseTimerRef.current = setTimeout(() => {
      composerCollapseTimerRef.current = null;
      const hasDraft = queryDraft.trim().length > 0;
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      const focusInsideComposer = Boolean(activeElement && composerRef.current?.contains(activeElement));
      if (!hasDraft && !focusInsideComposer) {
        setComposerExpanded(false);
      }
    }, 140);
  };

  useEffect(() => {
    return () => {
      clearComposerCollapseTimer();
    };
  }, []);

  const seriesOptions = useMemo(() => {
    return (suggestionsData?.assistantEconomicSeriesSuggestions ?? []).map((item: SuggestionItem) => ({
      value: item.slug,
      label: (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{item.displayName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.slug}
          </Typography.Text>
        </Space>
      ),
    }));
  }, [suggestionsData]);

  const { data, loading, refetch, error } = useQuery<AssistantRunsQueryData, AssistantRunsQueryVariables>(
    ASSISTANT_RUNS_QUERY,
    {
      variables: { limit: 40 },
      skip: !authenticated,
    },
  );
  const { data: runtimeCapabilitiesData, loading: runtimeCapabilitiesLoading } =
    useQuery<AssistantRuntimeCapabilitiesQueryData>(ASSISTANT_RUNTIME_CAPABILITIES_QUERY, {
      skip: !authenticated,
      fetchPolicy: 'network-only',
      nextFetchPolicy: 'network-only',
    });

  useSubscription<AssistantEventsSubscriptionData>(ASSISTANT_EVENTS_SUBSCRIPTION, {
    skip: !authenticated,
    onData: ({ data: subscription }) => {
      const event = subscription.data?.assistantEvents;
      if (!event) {
        return;
      }

      if (isTerminalStatus(event.status)) {
        const seen = completedRunsRef.current;
        if (!seen.has(event.id)) {
          seen.add(event.id);
          void refetch();
        }
      }

      const existing = pendingLiveUpdatesRef.current[event.id] ?? liveUpdatesRef.current[event.id];
      const previousText = existing?.summaryText ?? '';
      const delta = typeof event.summary === 'string' ? event.summary : '';
      const summaryText = event.status === 'running' ? previousText + delta : delta || previousText;
      const next: LiveUpdateRecord = {
        ...event,
        summaryText,
      };

      if (
        existing &&
        existing.status === next.status &&
        existing.type === next.type &&
        existing.error === next.error &&
        existing.createdAt === next.createdAt &&
        existing.summaryText === next.summaryText
      ) {
        return;
      }

      pendingLiveUpdatesRef.current[event.id] = next;
      schedulePendingLiveUpdatesFlush(isTerminalStatus(event.status));
    },
    onError: (err) => {
      const errMessage = err instanceof Error ? err.message : String(err);
      messageApi.error(
        t('assistant.streamError', {
          defaultValue: 'Assistant stream error: {{error}}',
          error: errMessage,
        }),
      );
    },
  });

  const [requestAssistantQuery, { loading: querySaving }] = useMutation<
    RequestAssistantQueryData,
    RequestAssistantQueryVariables
  >(REQUEST_ASSISTANT_QUERY_MUTATION);

  const [requestAssistantReport, { loading: reportSaving }] = useMutation<
    RequestAssistantReportData,
    RequestAssistantReportVariables
  >(REQUEST_ASSISTANT_REPORT_MUTATION);

  const [requestAssistantForecast, { loading: forecastSaving }] = useMutation<
    RequestAssistantForecastData,
    RequestAssistantForecastVariables
  >(REQUEST_ASSISTANT_FORECAST_MUTATION);

  const [deleteAssistantRun, { loading: deleteRunSaving }] = useMutation<
    DeleteAssistantRunData,
    DeleteAssistantRunVariables
  >(DELETE_ASSISTANT_RUN_MUTATION);

  const pushOptimisticRun = (
    run: Pick<AssistantRun, 'id' | 'type' | 'status' | 'createdAt' | 'conversationId'>,
    input: AssistantRun['input'],
  ) => {
    setOptimisticRuns((prev) => ({
      ...prev,
      [run.id]: {
        id: run.id,
        type: run.type,
        status: run.status,
        createdAt: run.createdAt,
        summary: null,
        error: null,
        input,
        output: null,
        conversationId: run.conversationId ?? null,
      },
    }));
    shouldAutoScrollRef.current = true;
    setActiveRunId(run.id);
  };

  useEffect(() => {
    const serverRuns = data?.assistantRuns;
    if (!serverRuns || serverRuns.length === 0) {
      return;
    }

    setOptimisticRuns((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const run of serverRuns) {
        if (next[run.id]) {
          delete next[run.id];
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [data?.assistantRuns]);

  const runs = useMemo(() => {
    const byId = new Map<string, AssistantRun>();

    for (const run of data?.assistantRuns ?? []) {
      if (deletedRuns[run.id]) {
        continue;
      }
      byId.set(run.id, run);
    }

    for (const optimisticRun of Object.values(optimisticRuns)) {
      if (deletedRuns[optimisticRun.id]) {
        continue;
      }
      if (!byId.has(optimisticRun.id)) {
        byId.set(optimisticRun.id, optimisticRun);
      }
    }

    for (const live of Object.values(liveUpdates)) {
      if (deletedRuns[live.id]) {
        continue;
      }
      const existing = byId.get(live.id);

      if (!existing) {
        byId.set(live.id, {
          id: live.id,
          type: live.type,
          status: live.status,
          summary: live.summaryText,
          error: live.error ?? null,
          createdAt: live.createdAt,
          input: null,
          output: null,
        });
        continue;
      }

      if (isTerminalStatus(existing.status) && !isTerminalStatus(live.status)) {
        continue;
      }

      byId.set(live.id, {
        ...existing,
        type: live.type,
        status: live.status,
        createdAt: live.createdAt,
        summary: live.summaryText || existing.summary || null,
        error: live.error ?? existing.error ?? null,
      });
    }

    return Array.from(byId.values()).sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
  }, [data?.assistantRuns, optimisticRuns, liveUpdates, deletedRuns]);

  useEffect(() => {
    if (runs.length === 0) {
      setActiveRunId(null);
      return;
    }

    setActiveRunId((prev) => {
      if (prev && runs.some((run) => run.id === prev)) {
        return prev;
      }
      return runs[0]?.id ?? null;
    });
  }, [runs]);

  const activeRun = useMemo(() => {
    if (!activeRunId) {
      return null;
    }
    return runs.find((run) => run.id === activeRunId) ?? null;
  }, [activeRunId, runs]);

  const promptStrings = useMemo<BuildUserPromptStrings>(
    () => ({
      queryFallback: t('assistant.chat.queryFallback', { defaultValue: 'New query' }),
      reportLabel: t('assistant.chat.reportLabel', { defaultValue: 'Report' }),
      forecastLabel: t('assistant.chat.forecastLabel', { defaultValue: 'Forecast' }),
      dailyLabel: t('assistant.chat.daily', { defaultValue: 'Daily' }),
      weeklyLabel: t('assistant.chat.weekly', { defaultValue: 'Weekly' }),
      unknownIndicator: t('assistant.chat.unknownIndicator', { defaultValue: 'Unknown indicator' }),
      topicLabel: t('assistant.chat.topicLabel', { defaultValue: 'Topic' }),
      limitLabel: t('assistant.chat.limitLabel', { defaultValue: 'Limit' }),
      lookbackLabel: t('assistant.chat.lookbackLabel', { defaultValue: 'Lookback' }),
      modelLabel: t('assistant.chat.modelLabel', { defaultValue: 'Model' }),
    }),
    [t],
  );

  const replyStrings = useMemo<ResolveAssistantReplyStrings>(
    () => ({
      thinking: t('assistant.chat.thinking', { defaultValue: 'Thinking…' }),
      queued: t('assistant.chat.queued', { defaultValue: 'Queued…' }),
      blockedFallback: t('assistant.blocked.title', { defaultValue: 'Blocked by safety checks' }),
    }),
    [t],
  );

  const getBlockedInfo = (run: AssistantRun | null): AssistantBlockedInfo | null => {
    if (!run) {
      return null;
    }

    const output = asRecord(run.output);
    if (!output || output.blocked !== true) {
      return null;
    }

    const rawMessage =
      typeof output.summary === 'string' && output.summary.trim().length > 0
        ? output.summary.trim()
        : typeof run.summary === 'string' && run.summary.trim().length > 0
          ? run.summary.trim()
          : t('assistant.blocked.title', { defaultValue: 'Blocked by safety checks' });

    const appliedGuardrailsRaw = output.appliedGuardrails;
    const appliedGuardrails = Array.isArray(appliedGuardrailsRaw)
      ? appliedGuardrailsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];

    const codeRaw = output.code;
    const code = typeof codeRaw === 'string' && codeRaw.trim().length > 0 ? codeRaw.trim() : null;

    const upstreamStatusRaw = output.upstreamStatus;
    const upstreamStatus =
      typeof upstreamStatusRaw === 'number' && Number.isFinite(upstreamStatusRaw) ? upstreamStatusRaw : null;

    const message = code
      ? t(`assistant.blocked.codes.${code}`, {
          defaultValue: rawMessage,
        })
      : rawMessage;

    return {
      message,
      code,
      appliedGuardrails,
      upstreamStatus,
    };
  };

  const activeUserPrompt = activeRun ? buildUserPromptFromRun(activeRun, promptStrings) : '';
  const activeAssistantText = activeRun ? resolveAssistantReply(activeRun, replyStrings) : '';
  const activeModelInfo = activeRun ? extractAssistantModelInfo(activeRun) : null;
  const hasActiveModelInfo = Boolean(
    activeModelInfo &&
      (activeModelInfo.llmModel || activeModelInfo.forecastModel || activeModelInfo.modelServiceUsed !== null),
  );
  const activeBlocked = getBlockedInfo(activeRun);
  const activeIsStreaming = Boolean(activeRun && !isTerminalStatus(activeRun.status));

  const handleChatScroll = () => {
    const node = chatScrollRef.current;
    if (!node) {
      return;
    }
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    shouldAutoScrollRef.current = distanceToBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
  };

  useEffect(() => {
    const node = chatScrollRef.current;
    if (!node) {
      return;
    }
    const runChanged = previousActiveRunIdRef.current !== activeRunId;
    if (runChanged) {
      shouldAutoScrollRef.current = true;
    }

    if (runChanged || shouldAutoScrollRef.current) {
      node.scrollTop = node.scrollHeight;
    }

    previousActiveRunIdRef.current = activeRunId;
  }, [activeRunId, activeAssistantText, activeRun?.status]);

  const handleNewConversation = () => {
    conversationSessionRef.current += 1;
    setActiveRunId(null);
    setQueryDraft('');
    setConversationId(null);
  };

  const title = t('pages.assistant.title', { defaultValue: 'AI Assistant' });
  const subtitle = t('pages.assistant.subtitle', {
    defaultValue: 'Natural language analysis powered by your data pipeline.',
  });
  const placeholder = t('assistant.chat.placeholder', {
    defaultValue: 'Ask anything about your pipeline data…',
  });
  const runtimeCapabilities = runtimeCapabilitiesData?.assistantRuntimeCapabilities ?? null;
  const webSearchCapabilityChecking = runtimeCapabilitiesLoading && runtimeCapabilities === null;
  const webSearchCapabilityKnown = runtimeCapabilities !== null;
  const webSearchSupportedByModel = runtimeCapabilities?.webSearchSupported === true;
  const webSearchOptionDisabled = webSearchCapabilityChecking || !webSearchSupportedByModel;
  const knowledgeSourceSupported = isAssistantKnowledgeSourceSupported(knowledgeSource, runtimeCapabilities);
  const knowledgeSourceBlocked = knowledgeSource === 'web_search' && !knowledgeSourceSupported;
  const knowledgeSourceUnsupportedMessage = t('assistant.chat.knowledgeSource.unsupported', {
    defaultValue: 'Web search is unavailable for the active assistant model profile.',
  });
  const knowledgeSourceDetectingMessage = t('assistant.chat.knowledgeSource.detecting', {
    defaultValue: 'Detecting model capability for web search…',
  });
  const knowledgeSourceFallbackMessage = t('assistant.chat.knowledgeSource.switchedToSiteDb', {
    defaultValue:
      'Web search is unavailable for the active assistant model profile. Switched to site database.',
  });
  const knowledgeSourceHint =
    knowledgeSource === 'web_search'
      ? t('assistant.chat.knowledgeSource.hintWebSearch', {
          defaultValue: 'Use web search for latest external facts and include source links.',
        })
      : t('assistant.chat.knowledgeSource.hintSiteDb', {
          defaultValue: 'Use your site database for grounded answers on collected content.',
        });
  const knowledgeSourceCapabilityMessage = webSearchCapabilityChecking
    ? knowledgeSourceDetectingMessage
    : webSearchSupportedByModel
      ? t('assistant.chat.knowledgeSource.configReady', {
          defaultValue: 'Web search is enabled by the active model profile (apiSurface=responses).',
        })
      : runtimeCapabilities?.apiSurface && runtimeCapabilities.apiSurface !== 'responses'
        ? t('assistant.chat.knowledgeSource.configNeedsResponses', {
            defaultValue:
              'Active model profile uses apiSurface={{apiSurface}}. Switch to responses to enable web search.',
            apiSurface: runtimeCapabilities.apiSurface,
          })
        : t('assistant.chat.knowledgeSource.configNeedsToggle', {
            defaultValue:
              'Active model profile has Assistant web search turned off. Enable it in LLM Gateway settings.',
          });
  const knowledgeSourceCapabilityClass = webSearchCapabilityChecking
    ? 'text-slate-500'
    : webSearchSupportedByModel
      ? 'text-emerald-700'
      : 'text-amber-700';

  useEffect(() => {
    if (knowledgeSource !== 'web_search') {
      return;
    }
    if (!webSearchCapabilityKnown || webSearchSupportedByModel) {
      return;
    }
    setKnowledgeSource(DEFAULT_ASSISTANT_KNOWLEDGE_SOURCE);
    messageApi.warning(knowledgeSourceFallbackMessage);
  }, [
    knowledgeSource,
    webSearchCapabilityKnown,
    webSearchSupportedByModel,
    messageApi,
    knowledgeSourceFallbackMessage,
  ]);

  const getStatusLabel = (statusValue: AssistantRunStatus): string => {
    return t(`assistant.status.${statusValue}`, { defaultValue: statusValue });
  };

  const getTypeLabel = (typeValue: AssistantRunType): string => {
    return t(`assistant.types.${typeValue}`, { defaultValue: typeValue });
  };

  const submitQuery = async () => {
    const messageRaw = queryDraft;
    const messageValue = messageRaw.trim();

    if (!messageValue) {
      messageApi.warning(t('assistant.messageRequired', { defaultValue: 'Please enter a question.' }));
      return;
    }

    if (!canRunAssistant) {
      messageApi.warning(t('common.accessDenied', { defaultValue: 'Access denied' }));
      return;
    }

    if (knowledgeSourceBlocked) {
      messageApi.warning(knowledgeSourceUnsupportedMessage);
      return;
    }

    try {
      shouldAutoScrollRef.current = true;
      const sessionAtSend = conversationSessionRef.current;
      const activeRunConversationId =
        activeRun?.type === 'query' &&
        typeof activeRun.conversationId === 'string' &&
        activeRun.conversationId.trim().length > 0
          ? activeRun.conversationId.trim()
          : null;
      const requestConversationId = activeRunConversationId ?? conversationId;
      const requestInput: RequestAssistantQueryVariables['input'] = requestConversationId
        ? { message: messageValue, conversationId: requestConversationId, knowledgeSource }
        : { message: messageValue, knowledgeSource };
      const res = await requestAssistantQuery({
        variables: { input: requestInput },
      });

      const created = res.data?.requestAssistantQuery;
      const isCurrentSession = sessionAtSend === conversationSessionRef.current;
      const createdConversationId =
        typeof created?.conversationId === 'string' && created.conversationId.trim().length > 0
          ? created.conversationId.trim()
          : null;
      if (createdConversationId && isCurrentSession) {
        setConversationId(createdConversationId);
      }
      if (created?.id && isCurrentSession) {
        pushOptimisticRun(
          created,
          createdConversationId
            ? { message: messageValue, conversationId: createdConversationId, knowledgeSource }
            : { message: messageValue, knowledgeSource },
        );
      }

      if (isCurrentSession) {
        setQueryDraft('');
      }
      void refetch();
    } catch (err) {
      if (isAssistantWebSearchUnsupportedError(err)) {
        setKnowledgeSource(DEFAULT_ASSISTANT_KNOWLEDGE_SOURCE);
        messageApi.warning(knowledgeSourceFallbackMessage);
        return;
      }
      const errMessage = err instanceof Error ? err.message : String(err);
      messageApi.error(
        t('assistant.requestFailed', { defaultValue: 'Request failed: {{error}}', error: errMessage }),
      );
    }
  };

  const handleDeleteRun = async (run: AssistantRun) => {
    if (!canRunAssistant) {
      messageApi.warning(t('common.accessDenied', { defaultValue: 'Access denied' }));
      return;
    }

    if (run.status === 'running') {
      messageApi.warning(
        t('assistant.chat.deleteRunningDenied', {
          defaultValue: 'Cannot delete a running conversation. Please wait until it finishes.',
        }),
      );
      return;
    }

    setDeletingRunId(run.id);
    try {
      const response = await deleteAssistantRun({ variables: { runId: run.id } });
      if (response.data?.deleteAssistantRun) {
        setDeletedRuns((prev) => ({ ...prev, [run.id]: true }));
        setOptimisticRuns((prev) => {
          if (!prev[run.id]) {
            return prev;
          }
          const next = { ...prev };
          delete next[run.id];
          return next;
        });
        setLiveUpdates((prev) => {
          if (!prev[run.id]) {
            return prev;
          }
          const next = { ...prev };
          delete next[run.id];
          return next;
        });
        delete liveUpdatesRef.current[run.id];
        delete pendingLiveUpdatesRef.current[run.id];
        completedRunsRef.current.delete(run.id);

        setActiveRunId((current) => (current === run.id ? null : current));
        messageApi.success(
          t('assistant.chat.deleteSuccess', {
            defaultValue: 'Conversation deleted.',
          }),
        );
        void refetch();
        return;
      }

      messageApi.warning(
        t('assistant.chat.deleteNotFound', {
          defaultValue: 'Conversation no longer exists.',
        }),
      );
      void refetch();
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      messageApi.error(
        t('assistant.chat.deleteFailed', {
          defaultValue: 'Failed to delete conversation: {{error}}',
          error: errMessage,
        }),
      );
    } finally {
      setDeletingRunId((current) => (current === run.id ? null : current));
    }
  };

  const confirmDeleteRun = (run: AssistantRun) => {
    Modal.confirm({
      title: t('assistant.chat.deleteConfirmTitle', { defaultValue: 'Delete this conversation?' }),
      content: t('assistant.chat.deleteConfirmDescription', {
        defaultValue: 'This action cannot be undone.',
      }),
      okText: t('common.delete', { defaultValue: 'Delete' }),
      cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
      okButtonProps: { danger: true },
      onOk: async () => {
        await handleDeleteRun(run);
      },
    });
  };

  const runListEmpty = t('assistant.chat.emptyHistory', { defaultValue: 'No assistant runs yet.' });
  const designKicker = t('assistant.hero.kicker', { defaultValue: 'INTELLIGENCE CONSOLE' });

  const renderRunHistory = (containerClassName: string, onRunSelect?: () => void) => (
    <div className={`${styles.historyScroll} ${containerClassName}`}>
      <List<AssistantRun>
        split={false}
        dataSource={runs}
        locale={{ emptyText: runListEmpty }}
        renderItem={(run) => {
          const selected = run.id === activeRunId;
          const blocked = getBlockedInfo(run);
          const userPrompt = buildUserPromptFromRun(run, promptStrings);
          const preview = resolveAssistantReply(run, replyStrings);

          return (
            <List.Item className="!border-none !px-0 !py-0">
              <div
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                className={`group relative mb-2 w-full overflow-hidden rounded-2xl border px-4 py-3 text-left transition-all last:mb-0 ${
                  selected
                    ? 'border-sky-200/80 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.12)]'
                    : 'border-transparent bg-white/55 hover:border-slate-200/80 hover:bg-white/80'
                }`}
                onClick={() => {
                  setActiveRunId(run.id);
                  onRunSelect?.();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActiveRunId(run.id);
                    onRunSelect?.();
                  }
                }}
              >
                <span
                  className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${getStatusRailClass(run.status)}`}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  loading={deletingRunId === run.id && deleteRunSaving}
                  disabled={!canRunAssistant}
                  className="absolute right-2 top-2 text-slate-400 transition-colors hover:text-rose-600"
                  onClick={(event) => {
                    event.stopPropagation();
                    void confirmDeleteRun(run);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                  }}
                  aria-label={t('assistant.chat.deleteConversation', { defaultValue: 'Delete conversation' })}
                />
                <div className="ml-2 w-full">
                  <Space size={6} wrap style={{ marginBottom: 8 }}>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${getStatusChipClass(run.status)}`}
                    >
                      {getStatusLabel(run.status)}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-300/60">
                      {getTypeLabel(run.type)}
                    </span>
                    {blocked ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-300/60">
                        {t('assistant.blocked.tag', { defaultValue: 'Blocked' })}
                      </span>
                    ) : null}
                  </Space>

                  <div className="mb-1 truncate text-sm font-semibold text-slate-900">{userPrompt}</div>
                  <div className="mb-2 line-clamp-2 text-sm text-slate-600">{preview}</div>

                  <span className="text-xs font-medium text-slate-400">
                    {formatDateTime(new Date(run.createdAt), locale, {
                      year: 'numeric',
                      month: 'short',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            </List.Item>
          );
        }}
      />
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-5">
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t('common.unexpectedError', { defaultValue: 'Unexpected error' })}
          description={error instanceof Error ? error.message : String(error)}
        />
      ) : null}

      <section className={styles.pageFrame}>
        <header className="relative z-[1] border-b border-white/70 px-5 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-2">
              <p className={styles.heroKicker}>{designKicker}</p>
              <h1 className="text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
              <p className="max-w-3xl text-sm font-medium text-slate-600 sm:text-[15px]">{subtitle}</p>
            </div>
            <Space size={8} wrap>
              <Button
                icon={<PlusOutlined />}
                onClick={handleNewConversation}
                disabled={!activeRun || querySaving}
                className="rounded-xl border-white/80 bg-white/85 text-slate-700 shadow-sm transition-all hover:border-sky-300 hover:bg-white hover:text-sky-700 hover:shadow-md"
              >
                {t('assistant.chat.newConversation', { defaultValue: 'New' })}
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => refetch()}
                loading={loading}
                className="rounded-xl border-white/80 bg-white/85 text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:shadow-md"
              >
                {t('common.refresh', { defaultValue: 'Refresh' })}
              </Button>
              <Button
                icon={<HistoryOutlined />}
                className="rounded-xl border-white/80 bg-white/85 text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:shadow-md xl:hidden"
                onClick={() => setHistoryDrawerOpen(true)}
              >
                {t('assistant.chat.historyTitle', { defaultValue: 'History' })} ({runs.length})
              </Button>
            </Space>
          </div>
        </header>

        <div
          className={`relative z-[1] grid gap-4 p-4 lg:p-5 ${styles.historyLayout} ${
            historyCollapsed ? styles.historyLayoutCollapsed : styles.historyLayoutExpanded
          }`}
        >
          <aside
            className={`${styles.panel} ${styles.historyPanel} ${
              historyCollapsed ? styles.historyPanelCollapsed : styles.historyPanelExpanded
            } hidden min-h-[40rem] flex-col xl:flex xl:h-[min(80dvh,68rem)]`}
          >
            <div className="flex items-center justify-between border-b border-slate-200/70 px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {t('assistant.chat.historyTitle', { defaultValue: 'History' })}
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {t('assistant.chat.recentConversations', { defaultValue: 'Recent conversations' })}
                </p>
              </div>
              <Space size={8}>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-inset ring-slate-300/60">
                  {runs.length}
                </span>
                <Button
                  type="text"
                  icon={<MenuFoldOutlined />}
                  className={`hidden xl:inline-flex transition-transform duration-300 ${
                    historyCollapsed ? '' : 'rotate-180'
                  }`}
                  onClick={() => setHistoryCollapsed(true)}
                  aria-label={t('assistant.chat.hideHistory', { defaultValue: 'Hide history' })}
                />
              </Space>
            </div>
            <div className="min-h-0 flex-1 px-3 py-3">{renderRunHistory('h-full overflow-y-auto')}</div>
          </aside>

          <section className={`${styles.panel} overflow-hidden`}>
            <div className="flex min-h-[40rem] flex-col lg:h-[min(80dvh,68rem)]">
              <div className="border-b border-slate-200/70 px-4 py-4 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Space size={8} wrap>
                    <Button
                      type="text"
                      icon={historyCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                      className={`hidden xl:inline-flex transition-transform duration-300 ${
                        historyCollapsed ? '' : 'rotate-180'
                      }`}
                      onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
                      aria-label={
                        historyCollapsed
                          ? t('assistant.chat.showHistory', { defaultValue: 'Show history' })
                          : t('assistant.chat.hideHistory', { defaultValue: 'Hide history' })
                      }
                    />
                    <span className="text-base font-bold text-slate-900">
                      {t('assistant.chat.conversationTitle', { defaultValue: 'Conversation' })}
                    </span>
                    {activeRun ? (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-300/60">
                        {getTypeLabel(activeRun.type)}
                      </span>
                    ) : null}
                    {activeRun ? (
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${getStatusChipClass(activeRun.status)}`}
                      >
                        {getStatusLabel(activeRun.status)}
                      </span>
                    ) : null}
                    {activeBlocked ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-300/60">
                        {t('assistant.blocked.tag', { defaultValue: 'Blocked' })}
                      </span>
                    ) : null}
                  </Space>
                  <Space size={8} wrap>
                    <Button
                      icon={<HistoryOutlined />}
                      className="rounded-xl border-slate-200/80 bg-white/80 text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:shadow-md xl:hidden"
                      onClick={() => setHistoryDrawerOpen(true)}
                    >
                      {t('assistant.chat.historyTitle', { defaultValue: 'History' })} ({runs.length})
                    </Button>
                    {activeRun ? (
                      <span className="text-xs font-semibold text-slate-500">
                        {formatDateTime(new Date(activeRun.createdAt), locale, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    ) : null}
                  </Space>
                </div>
              </div>

              <div
                ref={chatScrollRef}
                onScroll={handleChatScroll}
                className={`${styles.chatStage} min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-6 sm:px-6`}
              >
                {!activeRun ? (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                    <div className={styles.emptyOrb}>
                      <RobotOutlined className="text-3xl text-slate-400" />
                    </div>
                    <p className="mt-4 max-w-sm text-sm font-semibold text-slate-500">
                      {t('assistant.chat.emptyConversation', {
                        defaultValue: 'Start by sending a message. Your latest run will appear here.',
                      })}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className={`${styles.messageEnter} ml-auto min-w-0 max-w-[95%] sm:max-w-[88%] xl:max-w-[84%]`}>
                      <div className={styles.userBubble}>
                        <div className="whitespace-pre-wrap text-[15px] font-medium leading-relaxed text-white">
                          {activeUserPrompt}
                        </div>
                      </div>
                    </div>

                    <div className={`${styles.messageEnter} mr-auto min-w-0 max-w-[98%] sm:max-w-[96%] xl:max-w-[93%]`}>
                      <div className={styles.assistantBubble}>
                        <Space size={8} align="center" style={{ marginBottom: 14 }}>
                          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs text-white">
                            <RobotOutlined />
                          </div>
                          <span className="text-[15px] font-bold text-slate-900">
                            {t('assistant.chat.assistantLabel', { defaultValue: 'Assistant' })}
                          </span>
                          {activeIsStreaming ? <Spin size="small" className="text-sky-600" /> : null}
                        </Space>

                        <MarkdownViewer
                          markdown={activeAssistantText}
                          variant='chat'
                          enableMermaid
                          isStreaming={activeIsStreaming}
                          className={styles.assistantMarkdown}
                        />

                        {hasActiveModelInfo ? (
                          <div className={styles.modelInfoCard}>
                            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
                              {t('assistant.chat.modelInfoTitle', { defaultValue: 'Model info' })}
                            </span>
                            <Space wrap style={{ marginTop: 10 }}>
                              {activeModelInfo?.llmModel ? (
                                <span className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-sky-700 ring-1 ring-sky-200/70">
                                  {t('assistant.chat.modelLabel', { defaultValue: 'Model' })}: {activeModelInfo.llmModel}
                                </span>
                              ) : null}
                              {activeModelInfo?.forecastModel ? (
                                <span className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200/70">
                                  {t('assistant.chat.forecastModelLabel', { defaultValue: 'Forecast model' })}:{' '}
                                  {activeModelInfo.forecastModel}
                                </span>
                              ) : null}
                              {activeModelInfo?.modelServiceUsed !== null ? (
                                <span
                                  className={`inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ${
                                    activeModelInfo?.modelServiceUsed
                                      ? 'bg-white text-emerald-700 ring-emerald-200/70'
                                      : 'bg-white text-slate-600 ring-slate-200/70'
                                  }`}
                                >
                                  {t('assistant.chat.modelServiceLabel', { defaultValue: 'Model service' })}:{' '}
                                  {activeModelInfo?.modelServiceUsed
                                    ? t('assistant.chat.modelServiceUsed', { defaultValue: 'Used' })
                                    : t('assistant.chat.modelServiceNotUsed', { defaultValue: 'Not used' })}
                                </span>
                              ) : null}
                            </Space>
                          </div>
                        ) : null}

                        {activeRun.error ? (
                          <Alert
                            style={{ marginTop: 16, borderRadius: 14 }}
                            type="error"
                            showIcon
                            icon={<CloseCircleOutlined />}
                            message={t('assistant.chat.errorLabel', { defaultValue: 'Error details' })}
                            description={activeRun.error}
                          />
                        ) : null}

                        {activeBlocked ? (
                          <Alert
                            style={{ marginTop: 16, borderRadius: 14 }}
                            type="warning"
                            showIcon
                            message={t('assistant.blocked.title', { defaultValue: 'Blocked by safety checks' })}
                            description={
                              <Space direction="vertical" size={4}>
                                <span className="font-semibold text-slate-900">{activeBlocked.message}</span>
                                {activeBlocked.code ? (
                                  <span className="text-slate-600">
                                    {t('assistant.blocked.details.code', { defaultValue: 'Reason code' })}:{' '}
                                    {activeBlocked.code}
                                  </span>
                                ) : null}
                                {activeBlocked.upstreamStatus !== null ? (
                                  <span className="text-slate-600">
                                    {t('assistant.blocked.details.upstreamStatus', {
                                      defaultValue: 'Upstream status',
                                    })}
                                    : {activeBlocked.upstreamStatus}
                                  </span>
                                ) : null}
                                {activeBlocked.appliedGuardrails.length > 0 ? (
                                  <Space wrap>
                                    <span className="text-slate-600">
                                      {t('assistant.blocked.details.guardrails', {
                                        defaultValue: 'Applied guardrails',
                                      })}
                                      :
                                    </span>
                                    {activeBlocked.appliedGuardrails.map((name) => (
                                      <span
                                        key={name}
                                        className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700 ring-1 ring-inset ring-sky-300/50"
                                      >
                                        {name}
                                      </span>
                                    ))}
                                  </Space>
                                ) : null}
                              </Space>
                            }
                          />
                        ) : null}

                        {canViewAssistantJson ? (
                          <details className="mt-4 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-1">
                            <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-slate-700 hover:text-slate-900">
                              {t('assistant.chat.adminDetailsTitle', { defaultValue: 'Admin debug details (JSON)' })}
                            </summary>
                            <div className="space-y-4 px-4 pb-4 pt-2">
                              <div>
                                <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
                                  {t('assistant.chat.inputJsonTitle', { defaultValue: 'Input JSON' })}
                                </span>
                                <pre className="mt-2 max-h-48 overflow-auto rounded-xl border border-slate-200 bg-white p-4 text-xs font-mono text-slate-600 whitespace-pre-wrap">
                                  {JSON.stringify(activeRun.input ?? null, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
                                  {t('assistant.chat.outputJsonTitle', { defaultValue: 'Output JSON' })}
                                </span>
                                <pre className="mt-2 max-h-64 overflow-auto rounded-xl border border-slate-200 bg-white p-4 text-xs font-mono text-slate-600 whitespace-pre-wrap">
                                  {JSON.stringify(activeRun.output ?? null, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="border-t border-slate-200/70 px-4 py-3 sm:px-6 sm:py-3.5">
                {!canRunAssistant ? (
                  <Alert
                    style={{ marginBottom: 16, borderRadius: 14 }}
                    type="warning"
                    showIcon
                    message={t('common.accessDenied', { defaultValue: 'Access denied' })}
                    description={t('assistant.runPermissionRequired', {
                      defaultValue: 'You do not have permission to run assistant tasks.',
                    })}
                  />
                ) : null}

                <div
                  ref={composerRef}
                  className={`${styles.composerSurface} ${
                    composerExpanded ? styles.composerExpanded : styles.composerCollapsed
                  }`}
                  onClick={() => {
                    if (!composerExpanded) {
                      expandComposer();
                      setTimeout(() => composerInputRef.current?.focus(), 0);
                    }
                  }}
                >
                  <Input.TextArea
                    ref={composerInputRef}
                    value={queryDraft}
                    onChange={(event) => {
                      setQueryDraft(event.target.value);
                      if (event.target.value.trim().length > 0) {
                        expandComposer();
                      }
                    }}
                    onFocus={() => expandComposer()}
                    onBlur={() => scheduleComposerCollapse()}
                    autoSize={composerExpanded ? { minRows: 2, maxRows: 6 } : { minRows: 1, maxRows: 1 }}
                    placeholder={placeholder}
                    aria-label={t('assistant.chat.inputAriaLabel', {
                      defaultValue: 'Assistant message input',
                    })}
                    disabled={!canRunAssistant || querySaving}
                    className={`rounded-2xl border-slate-300/70 bg-white/90 px-5 text-[15px] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-4 focus:ring-sky-500/10 ${
                      composerExpanded ? 'py-4' : 'py-2.5'
                    }`}
                    onPressEnter={(event) => {
                      if (event.shiftKey) {
                        return;
                      }
                      event.preventDefault();
                      void submitQuery();
                    }}
                  />

                  <div
                    className={`${styles.composerDetails} ${
                      composerExpanded ? styles.composerDetailsExpanded : styles.composerDetailsCollapsed
                    }`}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                      <div className="flex flex-wrap items-center gap-2">
                        <Space size={8} wrap>
                          <span className="text-xs font-semibold text-slate-500">
                            {t('assistant.chat.knowledgeSource.label', { defaultValue: 'Knowledge source' })}
                          </span>
                          <Segmented
                            size="small"
                            value={knowledgeSource}
                            onChange={(value) => setKnowledgeSource(value as AssistantKnowledgeSource)}
                            options={[
                              {
                                label: t('assistant.chat.knowledgeSource.siteDb', { defaultValue: 'Site database' }),
                                value: 'site_db',
                              },
                              {
                                label: webSearchCapabilityChecking
                                  ? t('assistant.chat.knowledgeSource.webSearchChecking', {
                                      defaultValue: 'Web search (checking capability...)',
                                    })
                                  : webSearchOptionDisabled
                                  ? t('assistant.chat.knowledgeSource.webSearchDisabled', {
                                      defaultValue: 'Web search (model unsupported)',
                                    })
                                  : t('assistant.chat.knowledgeSource.webSearch', { defaultValue: 'Web search' }),
                                value: 'web_search',
                                disabled: webSearchOptionDisabled,
                              },
                            ]}
                            disabled={!canRunAssistant || querySaving}
                          />
                        </Space>
                        <Button
                          icon={<BarChartOutlined />}
                          className="rounded-xl border-slate-200/80 bg-white text-slate-700 shadow-sm transition-all hover:border-sky-300 hover:text-sky-700 hover:shadow-md"
                          onClick={() => setReportModalOpen(true)}
                          disabled={!canRunAssistant}
                        >
                          {t('assistant.chat.quickReport', { defaultValue: 'Quick Report' })}
                        </Button>
                        <Button
                          icon={<RobotOutlined />}
                          className="rounded-xl border-slate-200/80 bg-white text-slate-700 shadow-sm transition-all hover:border-indigo-300 hover:text-indigo-700 hover:shadow-md"
                          onClick={() => setForecastModalOpen(true)}
                          disabled={!canRunAssistant}
                        >
                          {t('assistant.chat.quickForecast', { defaultValue: 'Quick Forecast' })}
                        </Button>
                        <span className="text-xs font-semibold text-slate-500">
                          {t('assistant.chat.enterHint', { defaultValue: 'Enter to send, Shift+Enter for newline.' })}
                        </span>
                      </div>
                      <Button
                        icon={<SendOutlined />}
                        className="h-10 w-full rounded-xl border-none bg-sky-600 px-8 font-bold text-white shadow-[0_12px_24px_rgba(14,116,217,0.28)] transition-all hover:bg-sky-700 hover:shadow-[0_16px_26px_rgba(14,116,217,0.34)] active:scale-[0.98] disabled:opacity-50 sm:w-auto"
                        type="primary"
                        loading={querySaving}
                        disabled={!canRunAssistant || knowledgeSourceBlocked}
                        onClick={() => void submitQuery()}
                      >
                        {t('assistant.chat.send', { defaultValue: 'Send' })}
                      </Button>
                    </div>
                    {knowledgeSourceBlocked ? (
                      <span className="mt-1 text-xs font-semibold text-amber-700">{knowledgeSourceUnsupportedMessage}</span>
                    ) : null}
                    <span className={`mt-1 text-xs ${knowledgeSourceCapabilityClass}`}>
                      {knowledgeSourceCapabilityMessage}
                    </span>
                    <span className="mt-1 text-xs text-slate-500">{knowledgeSourceHint}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>

      <Drawer
        title={
          <span className="text-base font-semibold text-slate-900">
            {t('assistant.chat.historyTitle', { defaultValue: 'History' })}
          </span>
        }
        placement="left"
        width="min(92vw, 360px)"
        open={historyDrawerOpen}
        destroyOnClose
        onClose={() => setHistoryDrawerOpen(false)}
        classNames={{
          body: styles.historyDrawerBody,
          content: styles.historyDrawerContent,
          wrapper: styles.historyDrawerWrapper,
        }}
        extra={
          <Space size={8}>
            <Button
              icon={<PlusOutlined />}
              onClick={handleNewConversation}
              disabled={!activeRun || querySaving}
              className="rounded-xl border-slate-200 bg-white text-slate-700 shadow-sm transition-all hover:border-sky-300 hover:text-sky-700 hover:shadow-md"
            >
              {t('assistant.chat.newConversation', { defaultValue: 'New' })}
            </Button>
            <Button
              onClick={() => refetch()}
              loading={loading}
              className="rounded-xl border-slate-200 bg-white text-slate-700 shadow-sm transition-all hover:shadow-md"
            >
              {t('common.refresh', { defaultValue: 'Refresh' })}
            </Button>
          </Space>
        }
      >
        {renderRunHistory(
          'max-h-[calc(100svh-180px)] overflow-y-auto',
          () => setHistoryDrawerOpen(false),
        )}
      </Drawer>

      <Modal
        title={t('assistant.chat.quickReportTitle', { defaultValue: 'Quick Report' })}
        open={reportModalOpen}
        onCancel={() => setReportModalOpen(false)}
        onOk={() => reportForm.submit()}
        confirmLoading={reportSaving}
        okText={t('assistant.submit', { defaultValue: 'Run' })}
      >
        <Form
          form={reportForm}
          layout="vertical"
          initialValues={DEFAULT_REPORT_VALUES}
          onFinish={async (values) => {
            if (!canRunAssistant) {
              messageApi.warning(t('common.accessDenied', { defaultValue: 'Access denied' }));
              return;
            }

            const period = values.period === 'weekly' ? 'weekly' : 'daily';
            const topic = typeof values.topic === 'string' ? values.topic.trim() : '';
            const limit = typeof values.limit === 'number' && Number.isFinite(values.limit) ? values.limit : null;

            try {
              const res = await requestAssistantReport({
                variables: {
                  input: {
                    period,
                    topic: topic || null,
                    limit,
                  },
                },
              });

              const created = res.data?.requestAssistantReport;
              if (created?.id) {
                pushOptimisticRun(created, {
                  period,
                  topic: topic || null,
                  limit,
                });
              }

              setReportModalOpen(false);
              reportForm.setFieldsValue(DEFAULT_REPORT_VALUES);
              void refetch();
            } catch (err) {
              const errMessage = err instanceof Error ? err.message : String(err);
              messageApi.error(
                t('assistant.requestFailed', { defaultValue: 'Request failed: {{error}}', error: errMessage }),
              );
            }
          }}
        >
          <Form.Item
            name="period"
            label={t('assistant.report.period', { defaultValue: 'Period' })}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 'daily', label: t('assistant.report.daily', { defaultValue: 'Daily' }) },
                { value: 'weekly', label: t('assistant.report.weekly', { defaultValue: 'Weekly' }) },
              ]}
            />
          </Form.Item>
          <Form.Item name="topic" label={t('assistant.report.topic', { defaultValue: 'Topic filter (optional)' })}>
            <Input placeholder={t('assistant.report.topicPlaceholder', { defaultValue: 'e.g. new energy' })} />
          </Form.Item>
          <Form.Item name="limit" label={t('assistant.report.limit', { defaultValue: 'Max items' })}>
            <InputNumber min={1} max={100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('assistant.chat.quickForecastTitle', { defaultValue: 'Quick Forecast' })}
        open={forecastModalOpen}
        onCancel={() => setForecastModalOpen(false)}
        onOk={() => forecastForm.submit()}
        confirmLoading={forecastSaving}
        okText={t('assistant.submit', { defaultValue: 'Run' })}
      >
        <Form
          form={forecastForm}
          layout="vertical"
          initialValues={DEFAULT_FORECAST_VALUES}
          onFinish={async (values) => {
            if (!canRunAssistant) {
              messageApi.warning(t('common.accessDenied', { defaultValue: 'Access denied' }));
              return;
            }

            const series = typeof values.series === 'string' ? values.series.trim() : '';
            if (!series) {
              messageApi.warning(
                t('assistant.forecast.seriesRequired', {
                  defaultValue: 'Please enter a series.',
                }),
              );
              return;
            }

            const lookbackDays =
              typeof values.lookbackDays === 'number' && Number.isFinite(values.lookbackDays)
                ? values.lookbackDays
                : null;
            const seasonalPeriod =
              typeof values.seasonalPeriod === 'number' && Number.isFinite(values.seasonalPeriod)
                ? values.seasonalPeriod
                : null;
            const confidenceLevel =
              typeof values.confidenceLevel === 'number' && Number.isFinite(values.confidenceLevel)
                ? values.confidenceLevel
                : null;
            const modelKind = values.modelKind === 'arima' ? 'arima' : values.modelKind === 'ets' ? 'ets' : null;
            const sourceField = typeof values.sourceField === 'string' ? values.sourceField.trim() : '';

            try {
              const res = await requestAssistantForecast({
                variables: {
                  input: {
                    series,
                    lookbackDays,
                    sourceField: sourceField || null,
                    modelKind,
                    seasonalPeriod,
                    confidenceLevel,
                  },
                },
              });

              const created = res.data?.requestAssistantForecast;
              if (created?.id) {
                pushOptimisticRun(created, {
                  series,
                  lookbackDays,
                  sourceField: sourceField || null,
                  modelKind,
                  seasonalPeriod,
                  confidenceLevel,
                });
              }

              setForecastModalOpen(false);
              forecastForm.setFieldsValue(DEFAULT_FORECAST_VALUES);
              void refetch();
            } catch (err) {
              const errMessage = err instanceof Error ? err.message : String(err);
              messageApi.error(
                t('assistant.requestFailed', { defaultValue: 'Request failed: {{error}}', error: errMessage }),
              );
            }
          }}
        >
          <Form.Item
            name="series"
            label={t('assistant.forecast.series', { defaultValue: 'Economic indicator' })}
            rules={[{ required: true }]}
            extra={t('assistant.forecast.seriesHelp', {
              defaultValue:
                "Enter indicator name or identifier. Advanced formats like 'slug.field' or 'economic:slug:latest' are also supported.",
            })}
          >
            <AutoComplete
              options={seriesOptions}
              onSearch={handleSearch}
              dropdownMatchSelectWidth={false}
              notFoundContent={suggestionsLoading ? <Spin size="small" /> : null}
            >
              <Input
                placeholder={t('assistant.forecast.seriesPlaceholder', {
                  defaultValue: 'Enter indicator name or identifier, e.g. USD Index, GDP...',
                })}
                suffix={suggestionsLoading ? <Spin size="small" /> : null}
              />
            </AutoComplete>
          </Form.Item>

          <Form.Item
            name="lookbackDays"
            label={t('assistant.forecast.lookbackDays', { defaultValue: 'Lookback days' })}
          >
            <InputNumber min={7} max={3650} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="modelKind" label={t('assistant.forecast.modelKind', { defaultValue: 'Model' })}>
            <Select
              options={[
                { value: 'ets', label: t('assistant.forecast.model.ets', { defaultValue: 'ETS' }) },
                { value: 'arima', label: t('assistant.forecast.model.arima', { defaultValue: 'ARIMA' }) },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="seasonalPeriod"
            label={t('assistant.forecast.seasonalPeriod', { defaultValue: 'Seasonal period' })}
          >
            <InputNumber min={0} max={366} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="confidenceLevel"
            label={t('assistant.forecast.confidenceLevel', { defaultValue: 'Confidence level' })}
          >
            <InputNumber min={0.5} max={0.999} step={0.01} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="sourceField"
            label={t('assistant.forecast.sourceField', { defaultValue: 'Source field (optional)' })}
          >
            <Input placeholder={t('assistant.forecast.sourceFieldPlaceholder', { defaultValue: 'e.g. close or last' })} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

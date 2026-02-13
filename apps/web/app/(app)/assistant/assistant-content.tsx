'use client';

import { CloseCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { gql, useLazyQuery, useMutation, useQuery, useSubscription } from '@apollo/client';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
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
import dayjs from '@/lib/dayjs';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

type AssistantRunType = AssistantRunLike['type'];
type AssistantRunStatus = AssistantRunLike['status'];

interface AssistantRun extends AssistantRunLike {
  id: string;
  type: AssistantRunType;
  status: AssistantRunStatus;
  createdAt: string;
}

interface AssistantRunsQueryData {
  assistantRuns: AssistantRun[];
}

interface AssistantRunsQueryVariables {
  limit?: number | null;
}

interface RequestAssistantQueryData {
  requestAssistantQuery: Pick<AssistantRun, 'id' | 'type' | 'status' | 'createdAt'>;
}

interface RequestAssistantQueryVariables {
  input: { message: string };
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

interface AssistantEventsSubscriptionData {
  assistantEvents: Pick<AssistantRun, 'id' | 'type' | 'status' | 'summary' | 'error' | 'createdAt'>;
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

const REQUEST_ASSISTANT_QUERY_MUTATION = gql`
  mutation RequestAssistantQuery($input: AssistantQueryInput!) {
    requestAssistantQuery(input: $input) {
      id
      type
      status
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

const ASSISTANT_ECONOMIC_SERIES_SUGGESTIONS = gql`
  query AssistantEconomicSeriesSuggestions($term: String!, $limit: Int) {
    assistantEconomicSeriesSuggestions(term: $term, limit: $limit) {
      slug
      displayName
      description
    }
  }
`;

const statusColor = (status: AssistantRunStatus): string => {
  switch (status) {
    case 'pending':
      return 'default';
    case 'running':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'default';
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
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [forecastModalOpen, setForecastModalOpen] = useState(false);

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

  const pushOptimisticRun = (
    run: Pick<AssistantRun, 'id' | 'type' | 'status' | 'createdAt'>,
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
      byId.set(run.id, run);
    }

    for (const optimisticRun of Object.values(optimisticRuns)) {
      if (!byId.has(optimisticRun.id)) {
        byId.set(optimisticRun.id, optimisticRun);
      }
    }

    for (const live of Object.values(liveUpdates)) {
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
  }, [data?.assistantRuns, optimisticRuns, liveUpdates]);

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

  const title = t('pages.assistant.title', { defaultValue: 'AI Assistant' });
  const subtitle = t('pages.assistant.subtitle', {
    defaultValue: 'Natural language analysis powered by your data pipeline.',
  });
  const placeholder = t('assistant.chat.placeholder', {
    defaultValue: 'Ask anything about your pipeline data…',
  });
  const chatMetaPanelClassName =
    'mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/40';

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

    try {
      shouldAutoScrollRef.current = true;
      const res = await requestAssistantQuery({
        variables: { input: { message: messageValue } },
      });

      const created = res.data?.requestAssistantQuery;
      if (created?.id) {
        pushOptimisticRun(created, { message: messageValue });
      }

      setQueryDraft('');
      void refetch();
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      messageApi.error(
        t('assistant.requestFailed', { defaultValue: 'Request failed: {{error}}', error: errMessage }),
      );
    }
  };

  const runListEmpty = t('assistant.chat.emptyHistory', { defaultValue: 'No assistant runs yet.' });

  const renderRunHistory = (containerClassName: string, onRunSelect?: () => void) => (
    <div className={containerClassName}>
      <List<AssistantRun>
        dataSource={runs}
        locale={{ emptyText: runListEmpty }}
        renderItem={(run) => {
          const selected = run.id === activeRunId;
          const blocked = getBlockedInfo(run);
          const userPrompt = buildUserPromptFromRun(run, promptStrings);
          const preview = resolveAssistantReply(run, replyStrings);

          return (
            <List.Item
              className={`cursor-pointer rounded-xl border px-3 py-2 transition ${
                selected
                  ? 'border-blue-300 bg-blue-50 dark:border-blue-500/60 dark:bg-blue-500/10'
                  : 'border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-800/60'
              }`}
              onClick={() => {
                setActiveRunId(run.id);
                onRunSelect?.();
              }}
            >
              <div className="w-full">
                <Space size={6} wrap style={{ marginBottom: 6 }}>
                  <Tag color={statusColor(run.status)}>{getStatusLabel(run.status)}</Tag>
                  <Tag>{getTypeLabel(run.type)}</Tag>
                  {blocked ? <Tag color="volcano">{t('assistant.blocked.tag', { defaultValue: 'Blocked' })}</Tag> : null}
                </Space>

                <Typography.Paragraph ellipsis={{ rows: 1 }} style={{ marginBottom: 4 }}>
                  <Typography.Text strong>{userPrompt}</Typography.Text>
                </Typography.Paragraph>

                <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
                  {preview}
                </Typography.Paragraph>

                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDateTime(new Date(run.createdAt), locale, {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Typography.Text>
              </div>
            </List.Item>
          );
        }}
      />
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary">{subtitle}</Typography.Text>
      </Space>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t('common.unexpectedError', { defaultValue: 'Unexpected error' })}
          description={error instanceof Error ? error.message : String(error)}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card
          className="order-2 hidden lg:order-1 lg:block"
          title={t('assistant.chat.historyTitle', { defaultValue: 'History' })}
          extra={
            <Button onClick={() => refetch()} loading={loading}>
              {t('common.refresh', { defaultValue: 'Refresh' })}
            </Button>
          }
        >
          {renderRunHistory(
            'max-h-[42svh] overflow-y-auto pr-1 sm:max-h-[48svh] lg:h-[min(68dvh,52rem)] lg:max-h-none',
          )}
        </Card>

        <Card className="order-1 lg:order-2">
          <div className="flex min-h-[30rem] flex-col lg:h-[min(68dvh,52rem)]">
            <div className="flex flex-col gap-2 border-b border-slate-200 px-2 pb-3 dark:border-slate-700 sm:flex-row sm:items-center sm:justify-between">
              <Space size={8} wrap>
                <Typography.Text strong>{t('assistant.chat.conversationTitle', { defaultValue: 'Conversation' })}</Typography.Text>
                {activeRun ? <Tag>{getTypeLabel(activeRun.type)}</Tag> : null}
                {activeRun ? <Tag color={statusColor(activeRun.status)}>{getStatusLabel(activeRun.status)}</Tag> : null}
                {activeBlocked ? <Tag color="volcano">{t('assistant.blocked.tag', { defaultValue: 'Blocked' })}</Tag> : null}
              </Space>
              <Space size={8} wrap>
                <Button className="lg:hidden" onClick={() => setHistoryDrawerOpen(true)}>
                  {t('assistant.chat.historyTitle', { defaultValue: 'History' })} ({runs.length})
                </Button>
                {activeRun ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDateTime(new Date(activeRun.createdAt), locale, {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            </div>

            <div
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/60 px-2 py-4 dark:bg-slate-900/30"
            >
              {!activeRun ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <Typography.Text type="secondary">
                    {t('assistant.chat.emptyConversation', {
                      defaultValue: 'Start by sending a message. Your latest run will appear here.',
                    })}
                  </Typography.Text>
                </div>
              ) : (
                <>
                  <div className="ml-auto max-w-[92%] rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-sm dark:bg-slate-700 sm:max-w-[85%]">
                    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap', color: 'inherit' }}>
                      {activeUserPrompt}
                    </Typography.Paragraph>
                  </div>

                  <div className="mr-auto max-w-[95%] rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700 sm:max-w-[90%]">
                    <Space size={6} align="center" style={{ marginBottom: 8 }}>
                      <RobotOutlined />
                      <Typography.Text strong>{t('assistant.chat.assistantLabel', { defaultValue: 'Assistant' })}</Typography.Text>
                      {activeIsStreaming ? <Spin size="small" /> : null}
                    </Space>

                    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                      {activeAssistantText}
                    </Typography.Paragraph>

                    <div className={chatMetaPanelClassName}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('assistant.chat.modelInfoTitle', { defaultValue: 'Model info' })}
                      </Typography.Text>
                      <Space wrap style={{ marginTop: 6 }}>
                        {activeModelInfo?.llmModel ? (
                          <Tag color="geekblue">
                            {t('assistant.chat.modelLabel', { defaultValue: 'Model' })}: {activeModelInfo.llmModel}
                          </Tag>
                        ) : null}
                        {activeModelInfo?.forecastModel ? (
                          <Tag color="purple">
                            {t('assistant.chat.forecastModelLabel', { defaultValue: 'Forecast model' })}:{' '}
                            {activeModelInfo.forecastModel}
                          </Tag>
                        ) : null}
                        {activeModelInfo?.modelServiceUsed !== null ? (
                          <Tag color={activeModelInfo?.modelServiceUsed ? 'success' : 'default'}>
                            {t('assistant.chat.modelServiceLabel', { defaultValue: 'Model service' })}:{' '}
                            {activeModelInfo?.modelServiceUsed
                              ? t('assistant.chat.modelServiceUsed', { defaultValue: 'Used' })
                              : t('assistant.chat.modelServiceNotUsed', { defaultValue: 'Not used' })}
                          </Tag>
                        ) : null}
                        {!hasActiveModelInfo ? (
                          <Typography.Text type="secondary">
                            {t('assistant.chat.modelInfoUnknown', { defaultValue: 'No model metadata returned.' })}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    </div>

                    {activeRun.error ? (
                      <Alert
                        style={{ marginTop: 12 }}
                        type="error"
                        showIcon
                        icon={<CloseCircleOutlined />}
                        message={t('assistant.chat.errorLabel', { defaultValue: 'Error details' })}
                        description={activeRun.error}
                      />
                    ) : null}

                    {activeBlocked ? (
                      <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        showIcon
                        message={t('assistant.blocked.title', { defaultValue: 'Blocked by safety checks' })}
                        description={
                          <Space direction="vertical" size={4}>
                            <Typography.Text>{activeBlocked.message}</Typography.Text>
                            {activeBlocked.code ? (
                              <Typography.Text type="secondary">
                                {t('assistant.blocked.details.code', { defaultValue: 'Reason code' })}: {activeBlocked.code}
                              </Typography.Text>
                            ) : null}
                            {activeBlocked.appliedGuardrails.length > 0 ? (
                              <Space wrap>
                                <Typography.Text type="secondary">
                                  {t('assistant.blocked.details.guardrails', { defaultValue: 'Applied guardrails' })}:
                                </Typography.Text>
                                {activeBlocked.appliedGuardrails.map((name) => (
                                  <Tag key={name} color="geekblue">
                                    {name}
                                  </Tag>
                                ))}
                              </Space>
                            ) : null}
                            {activeBlocked.upstreamStatus ? (
                              <Typography.Text type="secondary">
                                {t('assistant.blocked.details.upstreamStatus', { defaultValue: 'Upstream status' })}:{' '}
                                {activeBlocked.upstreamStatus}
                              </Typography.Text>
                            ) : null}
                          </Space>
                        }
                      />
                    ) : null}

                    {canViewAssistantJson ? (
                      <details className={chatMetaPanelClassName}>
                        <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
                          {t('assistant.chat.adminDetailsTitle', { defaultValue: 'Admin debug details (JSON)' })}
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {t('assistant.chat.inputJsonTitle', { defaultValue: 'Input JSON' })}
                            </Typography.Text>
                            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-white p-2 text-xs whitespace-pre-wrap dark:bg-slate-800">
                              {JSON.stringify(activeRun.input ?? null, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {t('assistant.chat.outputJsonTitle', { defaultValue: 'Output JSON' })}
                            </Typography.Text>
                            <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-white p-2 text-xs whitespace-pre-wrap dark:bg-slate-800">
                              {JSON.stringify(activeRun.output ?? null, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </details>
                    ) : null}
                  </div>
                </>
              )}
            </div>

            <div className="border-t border-slate-200 px-2 pt-3 dark:border-slate-700">
              {!canRunAssistant ? (
                <Alert
                  style={{ marginBottom: 12 }}
                  type="warning"
                  showIcon
                  message={t('common.accessDenied', { defaultValue: 'Access denied' })}
                  description={t('assistant.runPermissionRequired', {
                    defaultValue: 'You do not have permission to run assistant tasks.',
                  })}
                />
              ) : null}

              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button className="w-full sm:w-auto" onClick={() => setReportModalOpen(true)} disabled={!canRunAssistant}>
                  {t('assistant.chat.quickReport', { defaultValue: 'Quick Report' })}
                </Button>
                <Button className="w-full sm:w-auto" onClick={() => setForecastModalOpen(true)} disabled={!canRunAssistant}>
                  {t('assistant.chat.quickForecast', { defaultValue: 'Quick Forecast' })}
                </Button>
              </div>

              <Input.TextArea
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                autoSize={{ minRows: 3, maxRows: 8 }}
                placeholder={placeholder}
                aria-label={t('assistant.chat.inputAriaLabel', {
                  defaultValue: 'Assistant message input',
                })}
                disabled={!canRunAssistant || querySaving}
                onPressEnter={(event) => {
                  if (event.shiftKey) {
                    return;
                  }
                  event.preventDefault();
                  void submitQuery();
                }}
              />

              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('assistant.chat.enterHint', { defaultValue: 'Enter to send, Shift+Enter for newline.' })}
                </Typography.Text>
                <Button
                  className="w-full sm:w-auto"
                  type="primary"
                  loading={querySaving}
                  disabled={!canRunAssistant}
                  onClick={() => void submitQuery()}
                >
                  {t('assistant.chat.send', { defaultValue: 'Send' })}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Drawer
        title={t('assistant.chat.historyTitle', { defaultValue: 'History' })}
        placement="left"
        width="min(92vw, 360px)"
        open={historyDrawerOpen}
        destroyOnClose
        onClose={() => setHistoryDrawerOpen(false)}
        extra={
          <Button onClick={() => refetch()} loading={loading}>
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </Button>
        }
      >
        {renderRunHistory('max-h-[calc(100svh-180px)] overflow-y-auto pr-1', () => setHistoryDrawerOpen(false))}
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

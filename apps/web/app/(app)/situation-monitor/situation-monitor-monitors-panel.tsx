"use client";

import {
  DeleteOutlined,
  EditOutlined,
  EnvironmentOutlined,
  FileSearchOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { CheckboxGroupProps } from "antd/es/checkbox";
import type { TFunction } from "i18next";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";

import {
  SITUATION_MONITOR_QUERY_KEYS,
  fetchSituationMonitorMonitors,
  invalidateSituationMonitorMonitors,
} from "./monitors-query";
import type {
  SituationMonitorMatchResult,
  SituationMonitorPreviewResponse,
  SituationMonitorPreviewSuggestion,
  SituationMonitorRejectedSuggestions,
  StoredSituationMonitor,
} from "./types/situation-monitor-monitors";
import {
  emitSituationMonitorMonitorsUpdated,
  getSituationMonitorMonitorsUpdatedSource,
  SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
} from "./utils/monitor-events";
import {
  getDefaultMonitorGeoStatusLabel,
  getDefaultMonitorReasonLabel,
} from "./utils/monitor-matches";

interface SituationMonitorMonitorsPanelProps {
  matches: SituationMonitorMatchResult[];
  onChanged?: () => Promise<void>;
}

interface MonitorFormValues {
  name: string;
  rawKeywords: string[];
  color?: string;
  locationName?: string;
}

interface SuggestionSelectionState {
  topics: string[];
  entities: string[];
  lexicalTerms: string[];
}

const EMPTY_REJECTED_SUGGESTIONS: SituationMonitorRejectedSuggestions = {
  topics: [],
  entities: [],
  lexicalTerms: [],
};

function stopSituationMonitorInteractiveEvent(event: {
  stopPropagation: () => void;
}) {
  event.stopPropagation();
}

function normalizeName(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 30),
    ),
  );
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (
    /^#[0-9a-f]{3}$/i.test(normalized) ||
    /^#[0-9a-f]{6}$/i.test(normalized)
  ) {
    return normalized.toLowerCase();
  }
  return undefined;
}

function normalizeRejectedSuggestions(
  value: SituationMonitorRejectedSuggestions | null | undefined,
): SituationMonitorRejectedSuggestions {
  if (!value) {
    return EMPTY_REJECTED_SUGGESTIONS;
  }
  return {
    topics: Array.isArray(value.topics)
      ? Array.from(new Set(value.topics.filter(Boolean)))
      : [],
    entities: Array.isArray(value.entities)
      ? Array.from(new Set(value.entities.filter(Boolean)))
      : [],
    lexicalTerms: Array.isArray(value.lexicalTerms)
      ? Array.from(new Set(value.lexicalTerms.filter(Boolean)))
      : [],
  };
}

function buildPreviewFingerprint(values: {
  name: string;
  rawKeywords: string[];
  locationName?: string;
}) {
  return JSON.stringify({
    name: normalizeName(values.name),
    rawKeywords: normalizeKeywords(values.rawKeywords),
    locationName:
      typeof values.locationName === "string" ? values.locationName.trim() : "",
  });
}

function buildSelectedState(
  monitor?: StoredSituationMonitor | null,
): SuggestionSelectionState {
  return {
    topics: monitor?.approvedTopics ?? [],
    entities: monitor?.approvedEntities ?? [],
    lexicalTerms: monitor?.approvedLexicalTerms ?? [],
  };
}

function buildTabsLabel(label: string, count: number, color?: string) {
  return (
    <Space size={8}>
      <span>{label}</span>
      <Tag color={color ?? "geekblue"} style={{ marginInlineEnd: 0 }}>
        {count}
      </Tag>
    </Space>
  );
}

function mergeRejectedSuggestions(
  base: SituationMonitorRejectedSuggestions,
  preview: SituationMonitorPreviewResponse | null,
  selected: SuggestionSelectionState,
) {
  const next = {
    topics: new Set(base.topics),
    entities: new Set(base.entities),
    lexicalTerms: new Set(base.lexicalTerms),
  };

  if (preview) {
    const selectedTopics = new Set(
      selected.topics.map((entry) => entry.trim().toLowerCase()),
    );
    const selectedEntities = new Set(
      selected.entities.map((entry) => entry.trim().toLowerCase()),
    );
    const selectedLexicalTerms = new Set(
      selected.lexicalTerms.map((entry) => entry.trim().toLowerCase()),
    );

    for (const suggestion of preview.suggestedTopics) {
      if (!selectedTopics.has(suggestion.normalizedValue)) {
        next.topics.add(suggestion.normalizedValue);
      }
    }
    for (const suggestion of preview.suggestedEntities) {
      if (!selectedEntities.has(suggestion.normalizedValue)) {
        next.entities.add(suggestion.normalizedValue);
      }
    }
    for (const suggestion of preview.suggestedLexicalTerms) {
      if (!selectedLexicalTerms.has(suggestion.normalizedValue)) {
        next.lexicalTerms.add(suggestion.normalizedValue);
      }
    }
  }

  return {
    topics: Array.from(next.topics),
    entities: Array.from(next.entities),
    lexicalTerms: Array.from(next.lexicalTerms),
  };
}

function buildSuggestionOptions(
  suggestions: SituationMonitorPreviewSuggestion[],
  selected: string[],
  t: TFunction,
  formatReasonLabel: (
    reason: SituationMonitorPreviewSuggestion["reason"],
  ) => string,
  extraTagLabel?: string,
): CheckboxGroupProps<string>["options"] {
  const suggestionByValue = new Map(
    suggestions.map((entry) => [entry.displayValue, entry]),
  );
  const values = Array.from(
    new Set([...selected, ...suggestions.map((entry) => entry.displayValue)]),
  );

  return values.map((value) => {
    const suggestion = suggestionByValue.get(value);
    const explanation = suggestion
      ? buildSuggestionExplanation(suggestion, t)
      : null;
    return {
      value,
      label: (
        <Space direction="vertical" size={2}>
          <Space size={6} wrap>
            <Typography.Text>{value}</Typography.Text>
            {suggestion ? (
              <Tag
                color={
                  suggestion.reason === "rerank"
                    ? "magenta"
                    : suggestion.reason === "semantic"
                      ? "blue"
                      : "default"
                }
              >
                {formatReasonLabel(suggestion.reason)}
              </Tag>
            ) : extraTagLabel ? (
              <Tag>{extraTagLabel}</Tag>
            ) : null}
            {suggestion?.taxonomyDisplayName ? (
              <Tag color="cyan">{suggestion.taxonomyDisplayName}</Tag>
            ) : null}
            {typeof suggestion?.score === "number" ? (
              <Tag color="default">{suggestion.score.toFixed(2)}</Tag>
            ) : null}
          </Space>
          {explanation ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {explanation}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    };
  });
}

function buildSuggestionExplanation(
  suggestion: SituationMonitorPreviewSuggestion,
  t: TFunction,
) {
  const terms = suggestion.matchedTerms?.filter(Boolean).slice(0, 4) ?? [];
  const termsLabel = terms.join(", ");

  if (suggestion.reason === "lexical") {
    return terms.length > 0
      ? t("situationMonitor.monitors.previewExplanation.lexicalWithTerms", {
          defaultValue: "Keyword overlap: {{terms}}",
          terms: termsLabel,
        })
      : t("situationMonitor.monitors.previewExplanation.lexical", {
          defaultValue: "Lexical overlap with your monitor input.",
        });
  }

  if (suggestion.reason === "semantic") {
    return terms.length > 0
      ? t("situationMonitor.monitors.previewExplanation.semanticWithTerms", {
          defaultValue: "Embedding recall related to: {{terms}}",
          terms: termsLabel,
        })
      : t("situationMonitor.monitors.previewExplanation.semantic", {
          defaultValue: "Embedding recall found a close semantic match.",
        });
  }

  return terms.length > 0
    ? t("situationMonitor.monitors.previewExplanation.rerankWithTerms", {
        defaultValue:
          "Semantic recall from {{terms}}, then rerank confirmed relevance.",
        terms: termsLabel,
      })
    : t("situationMonitor.monitors.previewExplanation.rerank", {
        defaultValue: "Rerank confirmed this suggestion after semantic recall.",
      });
}

function getMatchItemHref(match: SituationMonitorMatchResult) {
  if (!match.itemMetaId) {
    return null;
  }
  return `/items/${encodeURIComponent(match.itemMetaId)}`;
}

export function SituationMonitorMonitorsPanel({
  matches,
  onChanged,
}: SituationMonitorMonitorsPanelProps) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const translateToZh = useSituationMonitorSettingsStore(
    (state) => state.translateToZh,
  );
  const [form] = Form.useForm<MonitorFormValues>();

  const [submitting, setSubmitting] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preview, setPreview] =
    useState<SituationMonitorPreviewResponse | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedSuggestions, setSelectedSuggestions] =
    useState<SuggestionSelectionState>(buildSelectedState(null));
  const [baseRejectedSuggestions, setBaseRejectedSuggestions] =
    useState<SituationMonitorRejectedSuggestions>(EMPTY_REJECTED_SUGGESTIONS);

  const autoOpenedMonitorIdRef = useRef<string | null>(null);
  const lastMonitorsErrorRef = useRef<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const {
    data: monitors = [],
    error: monitorsError,
    isLoading: monitorsLoading,
    isFetching: monitorsFetching,
    refetch: refetchMonitors,
  } = useQuery({
    queryKey: SITUATION_MONITOR_QUERY_KEYS.monitors,
    queryFn: () => fetchSituationMonitorMonitors(apiClient),
    enabled: Boolean(session?.accessToken),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });

  const editingMonitor = useMemo(
    () => monitors.find((monitor) => monitor.id === editingId) ?? null,
    [editingId, monitors],
  );

  const sortedMonitors = useMemo(() => {
    return monitors.slice().sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "manual" ? -1 : 1;
      }
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }, [monitors]);

  const sortedMatches = useMemo(() => {
    return matches
      .slice()
      .sort(
        (a, b) =>
          b.timestamp - a.timestamp ||
          b.score - a.score ||
          a.monitorName.localeCompare(b.monitorName),
      );
  }, [matches]);

  const matchCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const match of matches) {
      counts[match.monitorId] = (counts[match.monitorId] ?? 0) + 1;
    }
    return counts;
  }, [matches]);

  useEffect(() => {
    if (!monitorsError) {
      lastMonitorsErrorRef.current = null;
      return;
    }
    const nextMessage = t("situationMonitor.monitors.loadFailed", {
      defaultValue: "Failed to load monitors.",
    });
    if (lastMonitorsErrorRef.current === nextMessage) {
      return;
    }
    lastMonitorsErrorRef.current = nextMessage;
    message.error(nextMessage);
  }, [message, monitorsError, t]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onMonitorsUpdated = (event: Event) => {
      if (
        getSituationMonitorMonitorsUpdatedSource(event) === "monitors-panel"
      ) {
        return;
      }
      void invalidateSituationMonitorMonitors(queryClient);
    };
    window.addEventListener(
      SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
      onMonitorsUpdated,
    );
    return () => {
      window.removeEventListener(
        SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
        onMonitorsUpdated,
      );
    };
  }, [queryClient]);

  useEffect(() => {
    const requestedMonitorId = searchParams.get("monitorId");
    if (
      !requestedMonitorId ||
      autoOpenedMonitorIdRef.current === requestedMonitorId
    ) {
      return;
    }
    const target = monitors.find(
      (monitor) => monitor.id === requestedMonitorId,
    );
    if (!target) {
      return;
    }
    autoOpenedMonitorIdRef.current = requestedMonitorId;
    openEdit(target);
  }, [monitors, searchParams]);

  const refreshAfterMutation = useCallback(async () => {
    await invalidateSituationMonitorMonitors(queryClient);
    emitSituationMonitorMonitorsUpdated("monitors-panel");
    if (onChanged) {
      await onChanged();
    }
  }, [onChanged, queryClient]);

  function openCreate() {
    setEditingId(null);
    setPreview(null);
    setPreviewFingerprint(null);
    setPreviewError(null);
    setSelectedSuggestions(buildSelectedState(null));
    setBaseRejectedSuggestions(EMPTY_REJECTED_SUGGESTIONS);
    form.setFieldsValue({
      name: "",
      rawKeywords: [],
      color: undefined,
      locationName: undefined,
    });
    setModalOpen(true);
  }

  function openEdit(monitor: StoredSituationMonitor) {
    setEditingId(monitor.id);
    setPreview(null);
    setPreviewError(null);
    setPreviewFingerprint(
      buildPreviewFingerprint({
        name: monitor.name,
        rawKeywords: monitor.rawKeywords,
        locationName: monitor.location?.name,
      }),
    );
    setSelectedSuggestions(buildSelectedState(monitor));
    setBaseRejectedSuggestions(
      normalizeRejectedSuggestions(monitor.rejectedSuggestions),
    );
    form.setFieldsValue({
      name: monitor.name,
      rawKeywords: monitor.rawKeywords,
      color: monitor.color,
      locationName: monitor.location?.name,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setPreview(null);
    setPreviewFingerprint(null);
    setPreviewError(null);
    setSelectedSuggestions(buildSelectedState(null));
    setBaseRejectedSuggestions(EMPTY_REJECTED_SUGGESTIONS);
    form.resetFields();
  }

  const handlePreview = useCallback(async () => {
    let values: MonitorFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const payload = {
      name: normalizeName(values.name),
      rawKeywords: normalizeKeywords(values.rawKeywords),
      ...(typeof values.locationName === "string" && values.locationName.trim()
        ? {
            location: {
              name: values.locationName.trim(),
            },
          }
        : {}),
      rejectedTopics: baseRejectedSuggestions.topics,
      rejectedEntities: baseRejectedSuggestions.entities,
      rejectedLexicalTerms: baseRejectedSuggestions.lexicalTerms,
    };

    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const response = await apiClient.post<SituationMonitorPreviewResponse>(
        "situation-monitor/monitors/preview",
        payload,
      );
      const resolvedLocationName =
        response.data?.locationResolution?.name ?? payload.location?.name;
      setPreview(response.data ?? null);
      setPreviewFingerprint(
        buildPreviewFingerprint({
          name: payload.name,
          rawKeywords: payload.rawKeywords,
          locationName: resolvedLocationName,
        }),
      );
      if (response.data?.locationResolution) {
        form.setFieldsValue({
          locationName: response.data.locationResolution.name,
        });
      }
      message.success(
        t("situationMonitor.monitors.previewReady", {
          defaultValue: "Suggestions refreshed. Confirm what you want to keep.",
        }),
      );
    } catch {
      const errorText = t("situationMonitor.monitors.previewFailed", {
        defaultValue: "Failed to analyze monitor keywords.",
      });
      setPreviewError(errorText);
      message.error(errorText);
    } finally {
      setPreviewLoading(false);
    }
  }, [apiClient, baseRejectedSuggestions, form, message, t]);

  const handleSubmit = useCallback(async () => {
    let values: MonitorFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const name = normalizeName(values.name);
    const rawKeywords = normalizeKeywords(values.rawKeywords);
    const currentFingerprint = buildPreviewFingerprint({
      name,
      rawKeywords,
      locationName: values.locationName,
    });
    const isSystemSync = editingMonitor?.kind === "system_sync";

    if (!isSystemSync && previewFingerprint !== currentFingerprint) {
      await handlePreview();
      message.info(
        t("situationMonitor.monitors.reviewBeforeSave", {
          defaultValue: "Review the refreshed suggestions, then save again.",
        }),
      );
      return;
    }

    const rejectedSuggestions = mergeRejectedSuggestions(
      baseRejectedSuggestions,
      preview,
      selectedSuggestions,
    );
    const color = normalizeColor(values.color) ?? null;
    const locationName =
      typeof values.locationName === "string" ? values.locationName.trim() : "";
    const resolvedLocation =
      locationName && preview?.locationResolution
        ? {
            name: preview.locationResolution.name,
            lat: preview.locationResolution.lat,
            lng: preview.locationResolution.lng,
            countryCodeAlpha2: preview.locationResolution.countryCodeAlpha2,
          }
        : locationName
          ? { name: locationName }
          : null;

    setSubmitting(true);
    try {
      if (editingMonitor) {
        await apiClient.patch(
          `situation-monitor/monitors/${editingMonitor.id}`,
          {
            ...(isSystemSync
              ? {}
              : {
                  name,
                  rawKeywords,
                  approvedTopics: selectedSuggestions.topics,
                  approvedEntities: selectedSuggestions.entities,
                  approvedLexicalTerms: Array.from(
                    new Set([
                      ...rawKeywords,
                      ...selectedSuggestions.lexicalTerms,
                    ]),
                  ),
                  rejectedTopics: rejectedSuggestions.topics,
                  rejectedEntities: rejectedSuggestions.entities,
                  rejectedLexicalTerms: rejectedSuggestions.lexicalTerms,
                  location: resolvedLocation,
                }),
            color,
          },
        );
        message.success(
          t("situationMonitor.monitors.updated", {
            defaultValue: "Monitor updated.",
          }),
        );
      } else {
        await apiClient.post("situation-monitor/monitors", {
          name,
          rawKeywords,
          approvedTopics: selectedSuggestions.topics,
          approvedEntities: selectedSuggestions.entities,
          approvedLexicalTerms: Array.from(
            new Set([...rawKeywords, ...selectedSuggestions.lexicalTerms]),
          ),
          rejectedTopics: rejectedSuggestions.topics,
          rejectedEntities: rejectedSuggestions.entities,
          rejectedLexicalTerms: rejectedSuggestions.lexicalTerms,
          color,
          location: resolvedLocation,
        });
        message.success(
          t("situationMonitor.monitors.created", {
            defaultValue: "Monitor created.",
          }),
        );
      }
      closeModal();
      await refreshAfterMutation();
    } catch {
      message.error(
        t("situationMonitor.monitors.saveFailed", {
          defaultValue: "Failed to save monitor.",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    apiClient,
    baseRejectedSuggestions,
    editingMonitor,
    form,
    handlePreview,
    message,
    preview,
    previewFingerprint,
    refreshAfterMutation,
    selectedSuggestions,
    t,
  ]);

  const handleToggle = useCallback(
    async (monitor: StoredSituationMonitor, enabled: boolean) => {
      try {
        await apiClient.patch(`situation-monitor/monitors/${monitor.id}`, {
          enabled,
        });
        await refreshAfterMutation();
      } catch {
        message.error(
          t("situationMonitor.monitors.toggleFailed", {
            defaultValue: "Failed to update monitor status.",
          }),
        );
      }
    },
    [apiClient, message, refreshAfterMutation, t],
  );

  const handleDelete = useCallback(
    async (monitorId: string) => {
      try {
        await apiClient.delete(`situation-monitor/monitors/${monitorId}`);
        message.success(
          t("situationMonitor.monitors.deleted", {
            defaultValue: "Monitor deleted.",
          }),
        );
        await refreshAfterMutation();
      } catch {
        message.error(
          t("situationMonitor.monitors.deleteFailed", {
            defaultValue: "Failed to delete monitor.",
          }),
        );
      }
    },
    [apiClient, message, refreshAfterMutation, t],
  );

  const topicOptions = useMemo(
    () =>
      buildSuggestionOptions(
        preview?.suggestedTopics ?? [],
        selectedSuggestions.topics,
        t,
        (reason) =>
          t(`situationMonitor.monitors.reason.${reason}`, {
            defaultValue: getDefaultMonitorReasonLabel(reason),
          }),
        t("situationMonitor.monitors.kept", { defaultValue: "kept" }),
      ),
    [preview?.suggestedTopics, selectedSuggestions.topics, t],
  );

  const entityOptions = useMemo(
    () =>
      buildSuggestionOptions(
        preview?.suggestedEntities ?? [],
        selectedSuggestions.entities,
        t,
        (reason) =>
          t(`situationMonitor.monitors.reason.${reason}`, {
            defaultValue: getDefaultMonitorReasonLabel(reason),
          }),
        t("situationMonitor.monitors.kept", { defaultValue: "kept" }),
      ),
    [preview?.suggestedEntities, selectedSuggestions.entities, t],
  );

  const lexicalOptions = useMemo(
    () =>
      buildSuggestionOptions(
        preview?.suggestedLexicalTerms ?? [],
        selectedSuggestions.lexicalTerms,
        t,
        (reason) =>
          t(`situationMonitor.monitors.reason.${reason}`, {
            defaultValue: getDefaultMonitorReasonLabel(reason),
          }),
        t("situationMonitor.monitors.kept", { defaultValue: "kept" }),
      ),
    [preview?.suggestedLexicalTerms, selectedSuggestions.lexicalTerms, t],
  );
  const interactiveControlProps = {
    "data-sm-interactive": true,
    onPointerDown: stopSituationMonitorInteractiveEvent,
    onMouseDown: stopSituationMonitorInteractiveEvent,
  } as const;

  if (!session?.accessToken) {
    return (
      <Card
        title={t("situationMonitor.monitors.title", {
          defaultValue: "My Monitors",
        })}
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      >
        <Typography.Text type="secondary">
          {t("common.unauthorized", {
            defaultValue: "You are not signed in.",
          })}
        </Typography.Text>
      </Card>
    );
  }

  return (
    <Card
      title={t("situationMonitor.monitors.title", {
        defaultValue: "My Monitors",
      })}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      extra={
        <Space size="small">
          <Button
            size="small"
            loading={monitorsFetching}
            {...interactiveControlProps}
            onClick={() => void refetchMonitors()}
          >
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
          <Button
            size="small"
            icon={<PlusOutlined />}
            {...interactiveControlProps}
            onClick={openCreate}
          >
            {t("situationMonitor.monitors.add", { defaultValue: "Add" })}
          </Button>
        </Space>
      }
    >
      <Typography.Text type="secondary">
        {t("situationMonitor.monitors.hint", {
          defaultValue:
            "Keywords are expanded with approved topics, entities, semantic recall, rerank, and optional location constraints.",
        })}
      </Typography.Text>

      <div className="mt-3">
        {monitorsError ? (
          <Alert
            showIcon
            type="error"
            className="mb-3"
            message={t("situationMonitor.monitors.loadFailed", {
              defaultValue: "Failed to load monitors.",
            })}
          />
        ) : null}
        <Tabs
          items={[
            {
              key: "monitors",
              label: buildTabsLabel(
                t("situationMonitor.monitors.tab", {
                  defaultValue: "Monitors",
                }),
                monitors.length,
              ),
              children: monitorsLoading && monitors.length === 0 ? (
                <div className="py-6 text-center">
                  <Spin />
                </div>
              ) : sortedMonitors.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t("situationMonitor.monitors.empty", {
                    defaultValue: "No monitors yet.",
                  })}
                />
              ) : (
                <List
                  size="small"
                  dataSource={sortedMonitors}
                  renderItem={(monitor) => (
                    <List.Item
                      actions={[
                        <Space key="actions" size="small">
                          <Switch
                            checked={monitor.enabled}
                            onChange={(enabled) =>
                              void handleToggle(monitor, enabled)
                            }
                          />
                          <Button
                            size="small"
                            icon={<EditOutlined />}
                            {...interactiveControlProps}
                            onClick={() => openEdit(monitor)}
                          >
                            {t("common.edit", { defaultValue: "Edit" })}
                          </Button>
                          {monitor.kind === "manual" ? (
                            <Popconfirm
                              title={t(
                                "situationMonitor.monitors.deleteConfirm",
                                {
                                  defaultValue: "Delete this monitor?",
                                },
                              )}
                              okText={t("common.delete", {
                                defaultValue: "Delete",
                              })}
                              cancelText={t("common.cancel", {
                                defaultValue: "Cancel",
                              })}
                              onConfirm={() => void handleDelete(monitor.id)}
                            >
                                <Button
                                  danger
                                  size="small"
                                  icon={<DeleteOutlined />}
                                  {...interactiveControlProps}
                                >
                                  {t("common.delete", { defaultValue: "Delete" })}
                                </Button>
                            </Popconfirm>
                          ) : null}
                        </Space>,
                      ]}
                    >
                      <Space
                        direction="vertical"
                        size={6}
                        style={{ width: "100%" }}
                      >
                        <Space size={10} wrap>
                          {monitor.color ? (
                            <span
                              aria-hidden
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: 999,
                                background: monitor.color,
                                display: "inline-block",
                                border: "1px solid rgba(0,0,0,0.15)",
                              }}
                            />
                          ) : null}
                          <Typography.Text strong>
                            {monitor.name}
                          </Typography.Text>
                          <Tag
                            color={
                              monitor.kind === "system_sync" ? "purple" : "blue"
                            }
                          >
                            {monitor.kind === "system_sync"
                              ? t("situationMonitor.monitors.systemSync", {
                                  defaultValue: "System sync",
                                })
                              : t("situationMonitor.monitors.manual", {
                                  defaultValue: "Manual",
                                })}
                          </Tag>
                          <Tag color={monitor.enabled ? "green" : "default"}>
                            {monitor.enabled
                              ? t("common.enabled", { defaultValue: "ENABLED" })
                              : t("common.disabled", {
                                  defaultValue: "DISABLED",
                                })}
                          </Tag>
                          <Tag color="geekblue">
                            {matchCounts[monitor.id] ?? 0}
                          </Tag>
                          {monitor.queryEmbeddingModel ? (
                            <Tag>{monitor.queryEmbeddingModel}</Tag>
                          ) : null}
                        </Space>
                        {monitor.rawKeywords.length > 0 ? (
                          <Space size={6} wrap>
                            {monitor.rawKeywords.map((keyword) => (
                              <Tag key={`${monitor.id}:keyword:${keyword}`}>
                                {keyword}
                              </Tag>
                            ))}
                          </Space>
                        ) : null}
                        {monitor.approvedTopics.length > 0 ? (
                          <Space size={6} wrap>
                            {monitor.approvedTopics.map((topic) => (
                              <Tag
                                key={`${monitor.id}:topic:${topic}`}
                                color="blue"
                              >
                                {topic}
                              </Tag>
                            ))}
                          </Space>
                        ) : null}
                        {monitor.approvedEntities.length > 0 ? (
                          <Space size={6} wrap>
                            {monitor.approvedEntities.map((entity) => (
                              <Tag
                                key={`${monitor.id}:entity:${entity}`}
                                color="purple"
                              >
                                {entity}
                              </Tag>
                            ))}
                          </Space>
                        ) : null}
                        {monitor.location ? (
                          <Typography.Text type="secondary">
                            <EnvironmentOutlined /> {monitor.location.name} (
                            {monitor.location.lat.toFixed(2)},{" "}
                            {monitor.location.lng.toFixed(2)})
                          </Typography.Text>
                        ) : null}
                        <Typography.Text type="secondary">
                          {t("situationMonitor.monitors.updatedAt", {
                            defaultValue: "Updated {{time}}",
                            time: formatDateTime(monitor.updatedAt, locale, {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            }),
                          })}
                        </Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
              ),
            },
            {
              key: "matches",
              label: buildTabsLabel(
                t("situationMonitor.monitors.matchesTab", {
                  defaultValue: "Matches",
                }),
                matches.length,
                matches.length ? "red" : "default",
              ),
              children:
                sortedMatches.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t("situationMonitor.monitors.noMatches", {
                      defaultValue: "No matches yet.",
                    })}
                  />
                ) : (
                  <List
                    size="small"
                    pagination={{ pageSize: 12, hideOnSinglePage: true }}
                    dataSource={sortedMatches}
                    renderItem={(match) => {
                      const href = match.link ? safeHttpUrl(match.link) : null;
                      const itemHref = getMatchItemHref(match);
                      const date = Number.isFinite(match.timestamp)
                        ? new Date(match.timestamp)
                        : null;
                      const title =
                        translateToZh && match.titleZh
                          ? match.titleZh
                          : match.title;
                      const summary =
                        translateToZh && match.summaryZh
                          ? match.summaryZh
                          : match.summary;
                      return (
                        <List.Item key={`${match.itemKey}:${match.monitorId}`}>
                          <Space
                            direction="vertical"
                            size={4}
                            style={{ width: "100%" }}
                          >
                            <Space size={8} wrap>
                              <Tag color={match.monitorColor}>
                                {match.monitorName}
                              </Tag>
                              <Tag color="default">{match.itemType}</Tag>
                              <Tag color="default">
                                {match.score.toFixed(2)}
                              </Tag>
                              {match.geoStatus !== "not_configured" ? (
                                <Tag color="default">
                                  {t(
                                    `situationMonitor.monitors.geoStatus.${match.geoStatus}`,
                                    {
                                      defaultValue:
                                        getDefaultMonitorGeoStatusLabel(
                                          match.geoStatus,
                                        ),
                                    },
                                  )}
                                </Tag>
                              ) : null}
                              {itemHref ? (
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<FileSearchOutlined />}
                                  {...interactiveControlProps}
                                  aria-label={t(
                                    "situationMonitor.headlines.openItem",
                                    {
                                      defaultValue: "Open item",
                                    },
                                  )}
                                  onClick={() =>
                                    window.open(
                                      itemHref,
                                      "_blank",
                                      "noopener,noreferrer",
                                    )
                                  }
                                />
                              ) : null}
                            </Space>
                            {href ? (
                              <Typography.Link
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {title}
                              </Typography.Link>
                            ) : (
                              <Typography.Text>{title}</Typography.Text>
                            )}
                            {summary ? (
                              <Typography.Paragraph
                                type="secondary"
                                ellipsis={{ rows: 2 }}
                                style={{ marginBottom: 0 }}
                              >
                                {summary}
                              </Typography.Paragraph>
                            ) : null}
                            {match.matchedTerms.length > 0 ? (
                              <Space size={6} wrap>
                                {match.matchedTerms.map((term) => (
                                  <Tag
                                    key={`${match.itemKey}:${match.monitorId}:${term}`}
                                  >
                                    {term}
                                  </Tag>
                                ))}
                              </Space>
                            ) : null}
                            <Space size={6} wrap>
                              {match.reasons.map((reason) => (
                                <Tag
                                  key={`${match.itemKey}:${match.monitorId}:${reason.code}`}
                                  color="default"
                                >
                                  {t(
                                    `situationMonitor.monitors.reason.${reason.code}`,
                                    {
                                      defaultValue:
                                        reason.label ||
                                        getDefaultMonitorReasonLabel(
                                          reason.code,
                                        ),
                                    },
                                  )}
                                  {typeof reason.score === "number"
                                    ? ` ${reason.score.toFixed(2)}`
                                    : ""}
                                </Tag>
                              ))}
                            </Space>
                            <Space size={10} wrap>
                              <Typography.Text type="secondary">
                                {match.source}
                              </Typography.Text>
                              {date ? (
                                <Typography.Text type="secondary">
                                  {formatDateTime(date, locale, {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </Typography.Text>
                              ) : null}
                            </Space>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                ),
            },
          ]}
        />
      </div>

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: "",
          rawKeywords: [],
          color: undefined,
          locationName: undefined,
        }}
        preserve={false}
        component={false}
      >
        <Modal
          title={
            editingMonitor
              ? editingMonitor.kind === "system_sync"
                ? t("situationMonitor.monitors.systemSyncTitle", {
                    defaultValue: "Subscription sync monitor",
                  })
                : t("situationMonitor.monitors.editTitle", {
                    defaultValue: "Edit monitor",
                  })
              : t("situationMonitor.monitors.createTitle", {
                  defaultValue: "Create monitor",
                })
          }
          open={modalOpen}
          onCancel={closeModal}
          onOk={() => void handleSubmit()}
          okButtonProps={{ loading: submitting }}
          okText={
            editingMonitor
              ? t("common.save", { defaultValue: "Save" })
              : t("common.create", { defaultValue: "Create" })
          }
          destroyOnHidden
          footer={[
            !editingMonitor || editingMonitor.kind === "manual" ? (
              <Button
                key="preview"
                onClick={() => void handlePreview()}
                loading={previewLoading}
              >
                {t("situationMonitor.monitors.preview", {
                  defaultValue: "Analyze",
                })}
              </Button>
            ) : null,
            <Button key="cancel" onClick={closeModal}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>,
            <Button
              key="submit"
              type="primary"
              onClick={() => void handleSubmit()}
              loading={submitting}
            >
              {editingMonitor
                ? t("common.save", { defaultValue: "Save" })
                : t("common.create", { defaultValue: "Create" })}
            </Button>,
          ]}
        >
          {editingMonitor?.kind === "system_sync" ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Alert
                type="info"
                showIcon
                message={t("situationMonitor.monitors.systemSyncHint", {
                  defaultValue:
                    "This monitor mirrors content subscriptions that are not owned by a manual monitor. Only styling and enablement are editable here.",
                })}
              />
              <Form.Item
                label={t("situationMonitor.monitors.fields.name", {
                  defaultValue: "Name",
                })}
                name="name"
              >
                <Input disabled />
              </Form.Item>
              <Form.Item
                label={t("situationMonitor.monitors.fields.color", {
                  defaultValue: "Color (optional)",
                })}
                name="color"
              >
                <Input placeholder="#9254de" allowClear />
              </Form.Item>
              {editingMonitor.approvedTopics.length > 0 ? (
                <Space direction="vertical" size={6}>
                  <Typography.Text strong>
                    {t("subscriptions.content.kindTopics", {
                      defaultValue: "Topics",
                    })}
                  </Typography.Text>
                  <Space size={6} wrap>
                    {editingMonitor.approvedTopics.map((topic) => (
                      <Tag key={`system-topic:${topic}`} color="blue">
                        {topic}
                      </Tag>
                    ))}
                  </Space>
                </Space>
              ) : null}
              {editingMonitor.approvedEntities.length > 0 ? (
                <Space direction="vertical" size={6}>
                  <Typography.Text strong>
                    {t("subscriptions.content.kindEntities", {
                      defaultValue: "Entities",
                    })}
                  </Typography.Text>
                  <Space size={6} wrap>
                    {editingMonitor.approvedEntities.map((entity) => (
                      <Tag key={`system-entity:${entity}`} color="purple">
                        {entity}
                      </Tag>
                    ))}
                  </Space>
                </Space>
              ) : null}
            </Space>
          ) : (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Form.Item
                label={t("situationMonitor.monitors.fields.name", {
                  defaultValue: "Name",
                })}
                name="name"
                rules={[
                  {
                    required: true,
                    message: t("situationMonitor.monitors.validation.name", {
                      defaultValue: "Enter a name.",
                    }),
                  },
                ]}
              >
                <Input
                  placeholder={t("situationMonitor.monitors.namePlaceholder", {
                    defaultValue: "e.g. Supply chain disruption",
                  })}
                />
              </Form.Item>
              <Form.Item
                label={t("situationMonitor.monitors.fields.keywords", {
                  defaultValue: "Keywords",
                })}
                name="rawKeywords"
                rules={[
                  {
                    validator: async (_, value: unknown) => {
                      if (normalizeKeywords(value).length === 0) {
                        throw new Error(
                          t("situationMonitor.monitors.validation.keywords", {
                            defaultValue: "Add at least one keyword.",
                          }),
                        );
                      }
                    },
                  },
                ]}
              >
                <Select
                  mode="tags"
                  tokenSeparators={[",", "\n"]}
                  placeholder={t(
                    "situationMonitor.monitors.keywordsPlaceholder",
                    {
                      defaultValue: "Type keywords and press Enter",
                    },
                  )}
                  options={[]}
                />
              </Form.Item>
              <Form.Item
                label={t("situationMonitor.monitors.fields.color", {
                  defaultValue: "Color (optional)",
                })}
                name="color"
                extra={t("situationMonitor.monitors.colorHint", {
                  defaultValue:
                    "Hex color like #1f3b7b. Leave empty for default.",
                })}
              >
                <Input placeholder="#1f3b7b" allowClear />
              </Form.Item>
              <Form.Item
                label={t("situationMonitor.monitors.fields.locationName", {
                  defaultValue: "Location (optional)",
                })}
                name="locationName"
                extra={t("situationMonitor.monitors.locationHint", {
                  defaultValue:
                    "Use a place name to bias geo matching and conflict filtering.",
                })}
              >
                <Input
                  placeholder={t(
                    "situationMonitor.monitors.locationNamePlaceholder",
                    {
                      defaultValue: "e.g. Taipei",
                    },
                  )}
                  allowClear
                />
              </Form.Item>

              {previewError ? (
                <Alert type="warning" showIcon message={previewError} />
              ) : null}

              <Alert
                type="info"
                showIcon
                message={t("situationMonitor.monitors.previewHint", {
                  defaultValue:
                    "Run Analyze after changing keywords or location, then confirm which topics, entities, and lexical expansions should be saved.",
                })}
              />

              {previewLoading ? (
                <div className="py-3 text-center">
                  <Spin />
                </div>
              ) : null}

              {preview?.locationResolution ? (
                <Space direction="vertical" size={4}>
                  <Typography.Text strong>
                    {t("situationMonitor.monitors.locationResolved", {
                      defaultValue: "Resolved location",
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    <EnvironmentOutlined /> {preview.locationResolution.name} (
                    {preview.locationResolution.lat.toFixed(2)},{" "}
                    {preview.locationResolution.lng.toFixed(2)})
                  </Typography.Text>
                </Space>
              ) : null}

              {preview?.modelInfo ? (
                <Space size={6} wrap>
                  {preview.modelInfo.embeddingModel ? (
                    <Tag>{preview.modelInfo.embeddingModel}</Tag>
                  ) : null}
                  {preview.modelInfo.rerankModel ? (
                    <Tag color="magenta">{preview.modelInfo.rerankModel}</Tag>
                  ) : null}
                </Space>
              ) : null}

              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {t("subscriptions.content.kindTopics", {
                    defaultValue: "Topics",
                  })}
                </Typography.Text>
                {topicOptions && topicOptions.length > 0 ? (
                  <Checkbox.Group
                    options={topicOptions}
                    value={selectedSuggestions.topics}
                    onChange={(values) =>
                      setSelectedSuggestions((current) => ({
                        ...current,
                        topics: values as string[],
                      }))
                    }
                  />
                ) : (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.monitors.noTopicSuggestions", {
                      defaultValue: "No topic suggestions yet.",
                    })}
                  </Typography.Text>
                )}
              </Space>

              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {t("subscriptions.content.kindEntities", {
                    defaultValue: "Entities",
                  })}
                </Typography.Text>
                {entityOptions && entityOptions.length > 0 ? (
                  <Checkbox.Group
                    options={entityOptions}
                    value={selectedSuggestions.entities}
                    onChange={(values) =>
                      setSelectedSuggestions((current) => ({
                        ...current,
                        entities: values as string[],
                      }))
                    }
                  />
                ) : (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.monitors.noEntitySuggestions", {
                      defaultValue: "No entity suggestions yet.",
                    })}
                  </Typography.Text>
                )}
              </Space>

              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {t("situationMonitor.monitors.lexicalTerms", {
                    defaultValue: "Lexical expansions",
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("situationMonitor.monitors.lexicalHint", {
                    defaultValue:
                      "Base keywords are always kept. Select extra lexical terms you want to persist.",
                  })}
                </Typography.Text>
                {lexicalOptions && lexicalOptions.length > 0 ? (
                  <Checkbox.Group
                    options={lexicalOptions}
                    value={selectedSuggestions.lexicalTerms}
                    onChange={(values) =>
                      setSelectedSuggestions((current) => ({
                        ...current,
                        lexicalTerms: values as string[],
                      }))
                    }
                  />
                ) : (
                  <Typography.Text type="secondary">
                    {t("situationMonitor.monitors.noLexicalSuggestions", {
                      defaultValue: "No lexical expansions yet.",
                    })}
                  </Typography.Text>
                )}
              </Space>
            </Space>
          )}
        </Modal>
      </Form>
    </Card>
  );
}

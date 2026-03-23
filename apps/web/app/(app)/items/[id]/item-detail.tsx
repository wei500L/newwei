"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  List,
  message,
  Radio,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { CollapseProps } from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { MarkdownViewer } from "@/components/markdown-viewer";
import { NewsImage } from "@/components/news-image";
import { useItemQuery } from "@/graphql/generated";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import {
  type ContentSubscriptionBatchResponse,
  type ContentSubscriptionCatalogItem,
  type ContentSubscriptionCatalogResponse,
} from "@/lib/content-subscriptions";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  isChineseLanguage,
  resolveDisplayContent,
  resolveDisplaySummary,
  resolveDisplayTitle,
  resolveLanguageLabel,
} from "@/lib/item-display";
import { formatRatioAsPercent } from "@/lib/metrics-format";
import {
  isChineseTargetLanguage,
  RSS_TRANSLATION_STATUS_QUERY,
  RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  TRANSLATE_RSS_ITEMS_MUTATION,
  type RssItemTranslation,
  type RssTranslationProvider,
  type RssTranslationStatusQuery,
  type RssTranslationStatusQueryVariables,
  type TranslateRssItemsMutation,
  type TranslateRssItemsMutationVariables,
} from "@/lib/rss-translation";
import { safeHttpUrl } from "@/lib/url";
import { trackUserNewsBehavior } from "@/lib/user-news-behavior";
import { emitSituationMonitorMonitorsUpdated } from "@/app/(app)/situation-monitor/utils/monitor-events";

interface ItemDetailProps {
  itemId: string;
}

interface UserDigestPreferenceV1 {
  version: 1;
  focusEntities: string[];
  focusTopics: string[];
  windowDays: number;
  maxEvents: number;
  includeIndicators: boolean;
  maxIndicatorsPerEvent: number;
}

const ITEM_DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
};

const parseJson = <T,>(value?: string | null): T | null => {
  if (!value) {
    return null;
  }
  try {
    let parsed: unknown = value;
    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof parsed !== "string") {
        break;
      }
      parsed = JSON.parse(parsed) as unknown;
    }
    return parsed as T;
  } catch {
    return null;
  }
};

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
};

const toEntityNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        return (entry as { name?: unknown }).name;
      }
      return undefined;
    })
    .filter(
      (name): name is string =>
        typeof name === "string" && name.trim().length > 0,
    );
};

const toString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

type ContentTypeValue = "news_fact" | "opinion" | "analysis" | "mixed";

function normalizeContentType(value: unknown): ContentTypeValue | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "news_fact" ||
    normalized === "newsfact" ||
    normalized === "fact" ||
    normalized === "factual" ||
    normalized === "report" ||
    normalized === "reporting"
  ) {
    return "news_fact";
  }
  if (
    normalized === "opinion" ||
    normalized === "op_ed" ||
    normalized === "oped" ||
    normalized === "commentary" ||
    normalized === "editorial"
  ) {
    return "opinion";
  }
  if (
    normalized === "analysis" ||
    normalized === "analytical" ||
    normalized === "insight" ||
    normalized === "explainer" ||
    normalized === "deep_dive"
  ) {
    return "analysis";
  }
  if (
    normalized === "mixed" ||
    normalized === "hybrid" ||
    normalized === "mixed_content"
  ) {
    return "mixed";
  }
  return undefined;
}

const EMPTY_DIGEST_PREFERENCE: UserDigestPreferenceV1 = {
  version: 1,
  focusEntities: [],
  focusTopics: [],
  windowDays: 3,
  maxEvents: 8,
  includeIndicators: true,
  maxIndicatorsPerEvent: 5,
};

function normalizeDigestTagValues(values: string[]): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 128);
  return Array.from(new Set(normalized)).slice(0, 50);
}

function normalizeDigestPreference(value: unknown): UserDigestPreferenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_DIGEST_PREFERENCE;
  }
  const record = value as Record<string, unknown>;
  const focusTopics = normalizeDigestTagValues(
    Array.isArray(record.focusTopics)
      ? record.focusTopics.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  const focusEntities = normalizeDigestTagValues(
    Array.isArray(record.focusEntities)
      ? record.focusEntities.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  return {
    ...EMPTY_DIGEST_PREFERENCE,
    focusTopics,
    focusEntities,
  };
}

function hasDigestSubscription(
  values: string[] | undefined,
  candidate: string,
): boolean {
  if (!Array.isArray(values) || values.length === 0) {
    return false;
  }
  const normalizedCandidate = candidate.trim().toLowerCase();
  if (!normalizedCandidate) {
    return false;
  }
  return values.some(
    (value) => value.trim().toLowerCase() === normalizedCandidate,
  );
}

function buildDigestSubscriptionKey(
  kind: "topic" | "entity",
  value: string,
): string {
  return `${kind}:${value.trim().toLowerCase()}`;
}

export function ItemDetail({ itemId }: ItemDetailProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const { data, loading, error } = useItemQuery({
    variables: { id: itemId },
  });
  const [showDelayHint, setShowDelayHint] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [activePayloadKeys, setActivePayloadKeys] = useState<string[]>([]);
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationProvider, setTranslationProvider] =
    useState<RssTranslationProvider>("deeplx");
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [showOriginalContent, setShowOriginalContent] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translatedItem, setTranslatedItem] =
    useState<RssItemTranslation | null>(null);
  const [digestPreference, setDigestPreference] =
    useState<UserDigestPreferenceV1 | null>(null);
  const [contentMetadataByKey, setContentMetadataByKey] = useState<
    Record<string, ContentSubscriptionCatalogItem>
  >({});
  const [relatedTopics, setRelatedTopics] = useState<
    ContentSubscriptionCatalogItem[]
  >([]);
  const [subscriptionBusyByKey, setSubscriptionBusyByKey] = useState<
    Record<string, boolean>
  >({});
  const translationRequestSeqRef = useRef(0);

  const { data: translationStatusData } = useQuery<
    RssTranslationStatusQuery,
    RssTranslationStatusQueryVariables
  >(RSS_TRANSLATION_STATUS_QUERY, {
    variables: { targetLanguage },
    fetchPolicy: "cache-and-network",
  });
  const [translateRssItems, { loading: translationLoading }] = useMutation<
    TranslateRssItemsMutation,
    TranslateRssItemsMutationVariables
  >(TRANSLATE_RSS_ITEMS_MUTATION);
  const providerStatuses = translationStatusData?.rssTranslationStatus ?? [];
  const selectedProviderStatus = providerStatuses.find(
    (status) => status.provider === translationProvider,
  );
  const translationProviderAvailable = Boolean(
    selectedProviderStatus?.available,
  );
  const translationTargetSupported = Boolean(
    selectedProviderStatus?.targetLanguageSupported ?? true,
  );
  const translationReady = Boolean(
    translationEnabled &&
      translationProviderAvailable &&
      translationTargetSupported,
  );

  useEffect(() => {
    if (!loading) {
      setShowDelayHint(false);
      return;
    }
    const timeout = setTimeout(() => setShowDelayHint(true), 1200);
    return () => clearTimeout(timeout);
  }, [loading]);

  const item = data?.item ?? null;
  const processedResult = useMemo(() => {
    const candidate = item?.processed?.resultJson;
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate as Record<string, unknown>;
    }
    return parseJson<Record<string, unknown>>(item?.processed?.result);
  }, [item?.processed?.result, item?.processed?.resultJson]);
  const rawPayload = useMemo(
    () => parseJson<Record<string, unknown>>(item?.raw?.payload),
    [item?.raw?.payload],
  );
  const processedStatus = item?.processed?.status ?? null;
  const processedError = item?.processed?.error ?? null;
  const rawSource = item?.raw?.source ?? null;
  const duplicateSimilarity = item?.processed?.duplicateSimilarity ?? null;
  const duplicateOf = item?.processed?.duplicateOf ?? null;
  const llm = item?.processed?.llm ?? null;
  const processedErrorMessage = toString(processedError?.message);
  const processedErrorName = toString(processedError?.name);

  const keyPoints = toStringList(processedResult?.key_points);
  const topics = useMemo(
    () => toStringList(processedResult?.topics),
    [processedResult?.topics],
  );
  const entities = useMemo(
    () => toEntityNames(processedResult?.entities),
    [processedResult?.entities],
  );
  const publishedAt =
    toString(item?.publishedAt) ?? toString(processedResult?.published_at);
  const source =
    toString(processedResult?.source) ??
    toString(rawPayload?.sourceName) ??
    toString(item?.raw?.source);
  const author = toString(processedResult?.author);
  const language = toString(processedResult?.language);
  const location = toString(processedResult?.location);
  const category = toString(processedResult?.category);
  const rawContentType =
    toString(processedResult?.content_type) ??
    toString(processedResult?.contentType);
  const contentType = normalizeContentType(rawContentType);
  const contentTypeLabel =
    contentType === "news_fact"
      ? t("items.contentType.newsFact", { defaultValue: "News fact" })
      : contentType === "opinion"
        ? t("items.contentType.opinion", { defaultValue: "Opinion" })
        : contentType === "analysis"
          ? t("items.contentType.analysis", { defaultValue: "Analysis" })
          : contentType === "mixed"
            ? t("items.contentType.mixed", { defaultValue: "Mixed" })
            : rawContentType;
  const qualityScore =
    typeof processedResult?.quality_score === "number"
      ? processedResult.quality_score
      : undefined;
  const qualityScoreLabel = formatRatioAsPercent(qualityScore, locale);
  const originalUrl = safeHttpUrl(rawPayload?.url);
  const thumbnailUrl = safeHttpUrl(rawPayload?.thumbnail);
  const cleanedMarkdown = toString(processedResult?.cleaned_markdown);
  const cleanedMarkdownSource = toString(
    processedResult?.cleaned_markdown_source,
  );
  const summary = resolveDisplaySummary({
    processedSummary: processedResult?.summary,
    rawSummary: rawPayload?.summary,
  });
  const articleContent = resolveDisplayContent({
    cleanedMarkdown,
  });
  const languageLabel = resolveLanguageLabel(processedResult?.language);
  const hasNonChineseContent = Boolean(
    languageLabel && !isChineseLanguage(languageLabel),
  );
  const markdownFallbackUsed = cleanedMarkdownSource === "crawl_fallback";
  const translatedTitle = toString(translatedItem?.title);
  const translatedSummary = toString(translatedItem?.summary);
  const translatedKeyPoints = toStringList(translatedItem?.keyPoints);
  const translatedMarkdown = toString(translatedItem?.cleanedMarkdown);
  const displayTitle =
    translationReady && !showOriginalContent && translatedTitle
      ? translatedTitle
      : resolveDisplayTitle({
          processedTitle: processedResult?.title,
          itemTitle: item?.title,
          source,
          originalUrl,
          fallbackTitle: t("common.notAvailable"),
        });
  const resolvedSummary =
    translationReady && !showOriginalContent && translatedSummary
      ? translatedSummary
      : summary;
  const resolvedKeyPoints =
    translationReady && !showOriginalContent && translatedKeyPoints.length > 0
      ? translatedKeyPoints
      : keyPoints;
  const resolvedArticleContent =
    translationReady && !showOriginalContent && translatedMarkdown
      ? translatedMarkdown
      : articleContent;
  const hasSummaryContent =
    Boolean(resolvedSummary) || resolvedKeyPoints.length > 0;
  const hasArticleContent = Boolean(resolvedArticleContent);
  const summaryText = resolvedSummary?.trim();
  const canExpandSummary = Boolean(summaryText && summaryText.length > 300);
  const displaySummary =
    summaryText && !summaryExpanded && canExpandSummary
      ? `${summaryText.slice(0, 300).trimEnd()}…`
      : summaryText;
  const expandLabel = t("common.expand", { defaultValue: "Show more" });
  const collapseLabel = t("common.collapse", { defaultValue: "Show less" });
  const keyPointsDisplay = resolvedKeyPoints.slice(0, 8);
  const extraKeyPoints = Math.max(
    resolvedKeyPoints.length - keyPointsDisplay.length,
    0,
  );
  const topicsDisplay = topics.slice(0, 5);
  const entitiesDisplay = entities.slice(0, 5);
  const extraTopics = Math.max(topics.length - topicsDisplay.length, 0);
  const extraEntities = Math.max(entities.length - entitiesDisplay.length, 0);
  const primaryTopic = topics[0]?.trim() ?? "";
  const metadataLookupEntries = useMemo(
    () => [
      ...topics
        .slice(0, 8)
        .map((topic) => ({ kind: "topic" as const, value: topic })),
      ...entities
        .slice(0, 8)
        .map((entity) => ({ kind: "entity" as const, value: entity })),
    ],
    [entities, topics],
  );
  const duplicateScore = formatRatioAsPercent(duplicateSimilarity, locale);
  const duplicateScoreLabel = duplicateScore ?? t("common.notAvailable");
  const llmModel = llm?.model ?? t("common.notAvailable");
  const llmLatency =
    typeof llm?.latencyMs === "number"
      ? `${Math.round(llm.latencyMs)} ms`
      : t("common.notAvailable");
  const llmCost =
    typeof llm?.costUsd === "number"
      ? `$${llm.costUsd.toFixed(4)}`
      : t("common.notAvailable");
  const llmTokens =
    typeof llm?.totalTokens === "number"
      ? Math.round(llm.totalTokens).toString()
      : t("common.notAvailable");
  const embeddingModel = item?.processed?.summaryEmbeddingModel ?? null;
  const embeddingDimensions =
    item?.processed?.summaryEmbeddingDimensions ?? null;
  const embeddingDimensionsLabel =
    typeof embeddingDimensions === "number"
      ? embeddingDimensions.toString()
      : t("common.notAvailable");
  const llmSummary = useMemo(() => {
    const bits: string[] = [];
    if (llm?.model) {
      bits.push(llm.model);
    }
    if (typeof llm?.latencyMs === "number") {
      bits.push(`${Math.round(llm.latencyMs)} ms`);
    }
    if (typeof llm?.costUsd === "number") {
      bits.push(`$${llm.costUsd.toFixed(4)}`);
    }
    return bits.length > 0 ? bits.join(" | ") : null;
  }, [llm?.costUsd, llm?.latencyMs, llm?.model]);
  const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
  const publishedUnknownLabel = t("items.time.publishedUnknown", {
    defaultValue: "Published time unknown",
  });
  const handleSearch = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };
  useEffect(() => {
    if (sessionStatus !== "authenticated" || !session?.accessToken) {
      setContentMetadataByKey((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      setRelatedTopics((current) => (current.length === 0 ? current : []));
      return;
    }

    if (metadataLookupEntries.length === 0) {
      setContentMetadataByKey((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      return;
    }

    let cancelled = false;
    const loadMetadata = async () => {
      try {
        const response =
          await apiClient.post<ContentSubscriptionCatalogResponse>(
            "user-content-subscriptions/catalog/lookup",
            { entries: metadataLookupEntries },
          );
        if (cancelled) {
          return;
        }
        const next = Object.fromEntries(
          (response.data?.items ?? []).map((entry) => [
            buildDigestSubscriptionKey(entry.kind, entry.normalizedValue),
            entry,
          ]),
        ) as Record<string, ContentSubscriptionCatalogItem>;
        setContentMetadataByKey(next);
      } catch (lookupError) {
        if (cancelled) {
          return;
        }
        captureClientError(
          "Failed to load content subscription metadata from item detail",
          lookupError,
        );
      }
    };
    void loadMetadata();
    return () => {
      cancelled = true;
    };
  }, [apiClient, metadataLookupEntries, session?.accessToken, sessionStatus]);

  useEffect(() => {
    if (
      sessionStatus !== "authenticated" ||
      !session?.accessToken ||
      !primaryTopic
    ) {
      setRelatedTopics((current) => (current.length === 0 ? current : []));
      return;
    }

    let cancelled = false;
    const loadRelatedTopics = async () => {
      try {
        const response =
          await apiClient.get<ContentSubscriptionCatalogResponse>(
            `user-content-subscriptions/related-topics?topic=${encodeURIComponent(primaryTopic)}&limit=6`,
          );
        if (cancelled) {
          return;
        }
        setRelatedTopics(response.data?.items ?? []);
      } catch (relatedError) {
        if (cancelled) {
          return;
        }
        captureClientError(
          "Failed to load related topics from item detail",
          relatedError,
        );
        setRelatedTopics((current) => (current.length === 0 ? current : []));
      }
    };
    void loadRelatedTopics();
    return () => {
      cancelled = true;
    };
  }, [apiClient, primaryTopic, session?.accessToken, sessionStatus]);

  const handleBookmarkPreference = async (
    kind: "topic" | "entity",
    value: string,
  ) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const subscriptionKey = buildDigestSubscriptionKey(kind, trimmed);
    setSubscriptionBusyByKey((current) => ({
      ...current,
      [subscriptionKey]: true,
    }));
    void trackUserNewsBehavior({
      type: "bookmark",
      itemId: item?.id ?? undefined,
      source: source ?? undefined,
      ...(kind === "topic" ? { topics: [trimmed] } : { entities: [trimmed] }),
      ...(originalUrl ? { url: originalUrl } : {}),
    });
    try {
      if (sessionStatus !== "authenticated" || !session?.accessToken) {
        message.warning(
          t("items.detail.subscribeLoginRequired", {
            defaultValue: "Please sign in before subscribing",
          }),
        );
        return;
      }

      const currentPreference =
        digestPreference ??
        normalizeDigestPreference(
          (
            await apiClient.get<UserDigestPreferenceV1>(
              "user-digest/preference",
            )
          ).data,
        );
      const currentTags =
        kind === "topic"
          ? currentPreference.focusTopics
          : currentPreference.focusEntities;
      if (hasDigestSubscription(currentTags, trimmed)) {
        message.info(
          t("items.detail.subscribeAlready", {
            defaultValue: "Already in subscription list",
          }),
        );
        setDigestPreference(currentPreference);
        return;
      }

      const response = await apiClient.post<ContentSubscriptionBatchResponse>(
        "user-content-subscriptions/batch-upsert",
        {
          subscriptions: [{ kind, value: trimmed, source: "manual" }],
        },
      );
      const result = response.data?.items?.[0];
      if (!result || result.status === "already_subscribed") {
        message.info(
          t("items.detail.subscribeAlready", {
            defaultValue: "Already in subscription list",
          }),
        );
        setDigestPreference(currentPreference);
        return;
      }
      if (result.status === "limit_reached") {
        message.warning(
          t("items.detail.subscribeLimitReached", {
            defaultValue: "Subscription limit reached for this type.",
          }),
        );
        setDigestPreference(currentPreference);
        return;
      }

      const savedValue = result.displayValue ?? trimmed;
      const nextTags = normalizeDigestTagValues([...currentTags, savedValue]);
      const updatedPreference =
        kind === "topic"
          ? { ...currentPreference, focusTopics: nextTags }
          : { ...currentPreference, focusEntities: nextTags };
      setDigestPreference(updatedPreference);
      setContentMetadataByKey((current) => ({
        ...current,
        [buildDigestSubscriptionKey(
          kind,
          result.normalizedValue || savedValue,
        )]: {
          kind,
          normalizedValue: result.normalizedValue,
          displayValue: savedValue,
          count: 0,
          lastSeenAt: new Date().toISOString(),
          taxonomyPath: result.taxonomyPath,
          taxonomyDisplayName: result.taxonomyDisplayName,
          taxonomyLabels: result.taxonomyLabels,
        },
      }));
      emitSituationMonitorMonitorsUpdated("item-detail");
      message.success(
        t("items.detail.subscribeSaved", {
          defaultValue:
            "Added to subscriptions and used by personalized digest",
        }) +
          (result.taxonomyDisplayName
            ? ` · ${result.taxonomyDisplayName}`
            : ""),
      );
    } catch (subscriptionError) {
      captureClientError(
        "Failed to save digest subscription from item detail",
        subscriptionError,
      );
      message.error(
        t("items.detail.subscribeFailed", {
          defaultValue: "Failed to save subscription. Please try again later.",
        }),
      );
    } finally {
      setSubscriptionBusyByKey((current) => {
        const next = { ...current };
        delete next[subscriptionKey];
        return next;
      });
    }
  };

  const formattedPublishedAt = publishedAt
    ? formatDateTime(publishedAt, locale, ITEM_DATE_TIME_FORMAT)
    : publishedUnknownLabel;

  useEffect(() => {
    if (!item?.id) {
      return;
    }
    void trackUserNewsBehavior({
      type: "view",
      itemId: item.id,
      source: source ?? undefined,
      topics: topics.slice(0, 6),
      entities: entities.slice(0, 6),
      ...(originalUrl ? { url: originalUrl } : {}),
    });
  }, [entities, item?.id, originalUrl, source, topics]);

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !session?.accessToken) {
      setDigestPreference(null);
      return;
    }
    let cancelled = false;
    const fetchPreference = async () => {
      try {
        const response = await apiClient.get<UserDigestPreferenceV1>(
          "user-digest/preference",
        );
        if (cancelled) {
          return;
        }
        setDigestPreference(normalizeDigestPreference(response.data));
      } catch (preferenceError) {
        if (cancelled) {
          return;
        }
        captureClientError(
          "Failed to load digest preference from item detail",
          preferenceError,
        );
        setDigestPreference(null);
      }
    };
    void fetchPreference();
    return () => {
      cancelled = true;
    };
  }, [apiClient, session?.accessToken, sessionStatus]);

  useEffect(() => {
    setSummaryExpanded(false);
    setActivePayloadKeys([]);
  }, [itemId]);

  useEffect(() => {
    if (
      translationProvider === "deeplx" &&
      !isChineseTargetLanguage(targetLanguage)
    ) {
      setTargetLanguage("zh-CN");
    }
  }, [targetLanguage, translationProvider]);

  useEffect(() => {
    translationRequestSeqRef.current += 1;
    setTranslationError(null);
    setTranslatedItem(null);
    setShowOriginalContent(false);
  }, [itemId, translationEnabled, translationProvider, targetLanguage]);

  useEffect(() => {
    if (!item?.id || !translationEnabled || !translationReady) {
      return;
    }

    const requestSeq = translationRequestSeqRef.current + 1;
    translationRequestSeqRef.current = requestSeq;
    setTranslationError(null);

    translateRssItems({
      variables: {
        input: {
          itemIds: [item.id],
          provider: translationProvider,
          targetLanguage,
          fields: ["title", "summary", "key_points", "cleaned_markdown"],
        },
      },
    })
      .then((response) => {
        if (translationRequestSeqRef.current !== requestSeq) {
          return;
        }
        const next = response.data?.translateRssItems.translations?.[0] ?? null;
        setTranslatedItem(next);
      })
      .catch((err) => {
        if (translationRequestSeqRef.current !== requestSeq) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "Translation failed";
        setTranslationError(message);
      });
  }, [
    item?.id,
    targetLanguage,
    translationEnabled,
    translationProvider,
    translationReady,
    translateRssItems,
  ]);

  if (loading && !item) {
    return (
      <Card className="content-card">
        <Space direction="vertical" size="large">
          <Skeleton active paragraph={{ rows: 8 }} />
          {showDelayHint ? (
            <ChartEmptyState
              className="h-auto"
              description={t("common.loadingDelayed", {
                defaultValue:
                  "Data is taking longer than usual. Please hold on or refresh.",
              })}
            />
          ) : null}
        </Space>
      </Card>
    );
  }

  if (error) {
    return <Typography.Text type="danger">{error.message}</Typography.Text>;
  }

  if (!item) {
    return (
      <ChartEmptyState
        className="h-auto py-12"
        description={t("items.detail.empty", {
          defaultValue: "Item not found.",
        })}
      />
    );
  }

  const ingestedAt = item.ingestedAt ?? item.createdAt;
  const formattedIngestedAt = formatDateTime(
    ingestedAt,
    locale,
    ITEM_DATE_TIME_FORMAT,
  );

  type CollapseItem = NonNullable<CollapseProps["items"]>[number];
  const payloadPanels: CollapseItem[] = [];
  if (processedResult) {
    payloadPanels.push({
      key: "processed",
      label: t("items.detail.payloadProcessed", {
        defaultValue: "Processed JSON",
      }),
      children: (
        <pre className="max-h-[360px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
          {JSON.stringify(processedResult, null, 2)}
        </pre>
      ),
    });
  }
  if (cleanedMarkdown) {
    payloadPanels.push({
      key: "markdown",
      label: (
        <Space size={8} wrap>
          <span>
            {t("items.detail.payloadMarkdown", {
              defaultValue: "Cleaned Markdown",
            })}
          </span>
          {markdownFallbackUsed ? (
            <Tag color="orange">
              {t("items.detail.markdownFallback", {
                defaultValue: "Markdown fallback",
              })}
            </Tag>
          ) : null}
        </Space>
      ),
      children: (
        <Space direction="vertical" size="middle" className="w-full">
          {markdownFallbackUsed ? (
            <Alert
              type="warning"
              showIcon
              message={t("items.detail.markdownFallback", {
                defaultValue: "Markdown fallback",
              })}
              description={t("items.detail.markdownFallbackTooltip", {
                defaultValue:
                  "LLM response omitted cleaned_markdown; showing crawled markdown as fallback.",
              })}
            />
          ) : null}
          <pre className="max-h-[360px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
            {cleanedMarkdown}
          </pre>
        </Space>
      ),
    });
  }
  if (rawPayload) {
    payloadPanels.push({
      key: "raw",
      label: t("items.detail.payloadRaw", { defaultValue: "Raw JSON" }),
      children: (
        <pre className="max-h-[360px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
          {JSON.stringify(rawPayload, null, 2)}
        </pre>
      ),
    });
  }
  const availablePayloadKeys = payloadPanels.map((panel) => String(panel.key));
  const activePayloadPanelKeys = activePayloadKeys.filter((key) =>
    availablePayloadKeys.includes(key),
  );
  const handlePayloadCollapseChange = (keys: string | string[]) => {
    setActivePayloadKeys(
      Array.isArray(keys) ? keys.map(String) : [String(keys)],
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {processedStatus === "failed" && processedErrorMessage ? (
        <Alert
          type="error"
          showIcon
          message={t("items.detail.processedErrorTitle", {
            defaultValue: "Processing failed",
          })}
          description={
            processedErrorName
              ? `${processedErrorName}: ${processedErrorMessage}`
              : processedErrorMessage
          }
        />
      ) : null}
      <Card className="content-card" size="small">
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Space wrap>
            <Typography.Text strong>
              {t("items.detail.translation.title", {
                defaultValue: "Article translation",
              })}
            </Typography.Text>
            <Space>
              <Typography.Text>
                {t("items.detail.translation.enable", {
                  defaultValue: "Enable",
                })}
              </Typography.Text>
              <Switch
                checked={translationEnabled}
                onChange={(checked) => setTranslationEnabled(checked)}
              />
            </Space>
            <Radio.Group
              value={translationProvider}
              onChange={(event) =>
                setTranslationProvider(
                  event.target.value as RssTranslationProvider,
                )
              }
              optionType="button"
              buttonStyle="solid"
              disabled={!translationEnabled}
            >
              <Radio.Button value="deeplx">
                {t("items.detail.translation.provider.deeplx", {
                  defaultValue: "DeepLX API",
                })}
              </Radio.Button>
              <Radio.Button value="llm">
                {t("items.detail.translation.provider.llm", {
                  defaultValue: "LLM",
                })}
              </Radio.Button>
            </Radio.Group>
            <Select
              style={{ minWidth: 160 }}
              value={targetLanguage}
              onChange={(value) => setTargetLanguage(value)}
              disabled={!translationEnabled || translationProvider === "deeplx"}
              options={RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS}
            />
            {translationEnabled ? (
              <Space>
                <Typography.Text>
                  {t("items.detail.translation.showOriginal", {
                    defaultValue: "Show original",
                  })}
                </Typography.Text>
                <Switch
                  checked={showOriginalContent}
                  onChange={(checked) => setShowOriginalContent(checked)}
                />
              </Space>
            ) : null}
          </Space>

          {translationEnabled &&
          selectedProviderStatus &&
          !translationProviderAvailable ? (
            <Alert
              type="warning"
              showIcon
              message={t("items.detail.translation.unavailable", {
                defaultValue: "Selected translation source is unavailable.",
              })}
              description={
                selectedProviderStatus.message ?? t("common.notAvailable")
              }
            />
          ) : null}

          {translationEnabled &&
          selectedProviderStatus &&
          translationProviderAvailable &&
          !translationTargetSupported ? (
            <Alert
              type="warning"
              showIcon
              message={t("items.detail.translation.targetUnsupported", {
                defaultValue:
                  "Target language is not supported by selected source.",
              })}
              description={
                selectedProviderStatus.message ?? t("common.notAvailable")
              }
            />
          ) : null}

          {translationEnabled && translationLoading ? (
            <Typography.Text type="secondary">
              {t("items.detail.translation.loading", {
                defaultValue: "Translating article content...",
              })}
            </Typography.Text>
          ) : null}

          {translationEnabled && translationError ? (
            <Alert
              type="error"
              showIcon
              message={t("items.detail.translation.failed", {
                defaultValue: "Translation failed.",
              })}
              description={translationError}
            />
          ) : null}
        </Space>
      </Card>
      <Space direction="vertical" size={2}>
        <Typography.Title
          level={4}
          ellipsis={{ rows: 2 }}
          style={{ margin: 0 }}
        >
          {displayTitle}
        </Typography.Title>
        <Space size={[8, 8]} wrap>
          <Tag color="blue">{item.status}</Tag>
          {hasNonChineseContent ? (
            <Tag color="orange">
              {t("items.detail.originalLanguage", {
                defaultValue: "Original language: {{language}}",
                language: languageLabel,
              })}
            </Tag>
          ) : null}
          {qualityScoreLabel ? (
            <Tooltip
              title={
                <div className="text-xs">
                  <div>
                    {t("items.metrics.quality.tooltip", {
                      defaultValue:
                        "Quality score from LLM cleaning stage (0–1, shown as %).",
                    })}
                  </div>
                  {llm?.model ? <div>Model: {llm.model}</div> : null}
                  {llm?.promptVersion ? (
                    <div>Prompt: {llm.promptVersion}</div>
                  ) : null}
                </div>
              }
            >
              <Tag color="purple">
                {t("items.detail.fields.quality", { defaultValue: "Quality" })}:{" "}
                {qualityScoreLabel}
              </Tag>
            </Tooltip>
          ) : null}
          {duplicateScore ? (
            <Tooltip
              title={
                <div className="text-xs">
                  <div>
                    {t("items.metrics.duplicate.tooltip", {
                      defaultValue:
                        "Duplicate similarity from dedup stage (0–1, shown as %).",
                    })}
                  </div>
                  {duplicateOf ? <div>Duplicate of: {duplicateOf}</div> : null}
                </div>
              }
            >
              <Tag color="gold">
                {duplicateOf
                  ? t("items.duplicate.duplicate", {
                      defaultValue: "Duplicate",
                    })
                  : t("items.duplicate.similarity", {
                      defaultValue: "Similarity",
                    })}{" "}
                {duplicateScore}
              </Tag>
            </Tooltip>
          ) : null}
          {markdownFallbackUsed ? (
            <Tooltip
              title={t("items.detail.markdownFallbackTooltip", {
                defaultValue:
                  "LLM response omitted cleaned_markdown; showing crawled markdown as fallback.",
              })}
            >
              <Tag color="orange">
                {t("items.detail.markdownFallback", {
                  defaultValue: "Markdown fallback",
                })}
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
        <Space size={[8, 0]} wrap align="center">
          {source ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {source}
            </Typography.Text>
          ) : null}
          <ArticlePublishedTime
            publishedAt={publishedAt ?? null}
            locale={locale}
            formatOptions={ITEM_DATE_TIME_FORMAT}
            primaryStrong
            secondaryStyle={{ fontSize: 12 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {ingestedLabel}: {formattedIngestedAt}
          </Typography.Text>
          {llmSummary ? (
            <Tooltip
              title={
                <div className="text-xs">
                  {llm?.model ? <div>Model: {llm.model}</div> : null}
                  {llm?.promptVersion ? (
                    <div>Prompt: {llm.promptVersion}</div>
                  ) : null}
                  {typeof llm?.totalTokens === "number" ? (
                    <div>Tokens: {Math.round(llm.totalTokens)}</div>
                  ) : null}
                  {typeof llm?.latencyMs === "number" ? (
                    <div>Latency: {Math.round(llm.latencyMs)} ms</div>
                  ) : null}
                  {typeof llm?.costUsd === "number" ? (
                    <div>Cost: ${llm.costUsd.toFixed(4)}</div>
                  ) : null}
                </div>
              }
            >
              <Space size={4}>
                <InfoCircleOutlined className="text-slate-400" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  LLM: {llmSummary}
                </Typography.Text>
              </Space>
            </Tooltip>
          ) : null}
        </Space>
        {originalUrl ? (
          <Typography.Link
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("items.detail.readOriginal", { defaultValue: "Read original" })}
          </Typography.Link>
        ) : null}
      </Space>

      <NewsImage
        src={thumbnailUrl}
        alt={displayTitle}
        aspectRatio="video"
        fallback="gradient"
        fallbackText={source ?? displayTitle}
        className="w-full rounded-xl"
        imgClassName="rounded-xl"
      />

      <Card
        className="content-card"
        title={t("items.detail.summaryTitle", { defaultValue: "Summary" })}
      >
        {hasSummaryContent ? (
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            {displaySummary ? (
              <div>
                <Typography.Paragraph
                  ellipsis={summaryExpanded ? false : { rows: 3 }}
                  style={{ lineHeight: 1.8, marginBottom: 0 }}
                >
                  {displaySummary}
                </Typography.Paragraph>
                {canExpandSummary ? (
                  <Typography.Link
                    onClick={() => setSummaryExpanded((expanded) => !expanded)}
                    style={{ fontSize: 12 }}
                  >
                    {summaryExpanded ? collapseLabel : expandLabel}
                  </Typography.Link>
                ) : null}
              </div>
            ) : (
              <Typography.Text type="secondary">
                {t("items.detail.summaryEmpty", {
                  defaultValue: "No summary available.",
                })}
              </Typography.Text>
            )}
            {keyPointsDisplay.length > 0 ? (
              <div>
                <Typography.Text strong>
                  {t("items.detail.keyPointsTitle", {
                    defaultValue: "Key points",
                  })}
                </Typography.Text>
                <List
                  size="small"
                  dataSource={keyPointsDisplay}
                  renderItem={(point) => (
                    <List.Item>
                      <Typography.Text type="secondary">
                        {point}
                      </Typography.Text>
                    </List.Item>
                  )}
                />
                {extraKeyPoints > 0 ? (
                  <Typography.Text type="secondary">
                    {t("items.detail.keyPointsMore", {
                      defaultValue: "+{{count}} more",
                      count: extraKeyPoints,
                    })}
                  </Typography.Text>
                ) : null}
              </div>
            ) : (
              <Typography.Text type="secondary">
                {t("items.detail.keyPointsEmpty", {
                  defaultValue: "No key points.",
                })}
              </Typography.Text>
            )}
          </Space>
        ) : (
          <ChartEmptyState
            className="h-auto py-6"
            description={t("items.detail.summaryEmpty", {
              defaultValue: "No summary available.",
            })}
          />
        )}
      </Card>

      <Card
        className="content-card"
        title={t("items.detail.fullTextTitle", {
          defaultValue: "Article text",
        })}
      >
        {hasArticleContent ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {hasNonChineseContent ? (
              <Alert
                type="info"
                showIcon
                message={t("items.detail.languageNoticeTitle", {
                  defaultValue: "Language notice",
                })}
                description={t("items.detail.languageNoticeDescription", {
                  defaultValue:
                    "Detected language is {{language}}. This article may not have been translated to Chinese yet.",
                  language: languageLabel,
                })}
              />
            ) : null}
            {markdownFallbackUsed ? (
              <Alert
                type="warning"
                showIcon
                message={t("items.detail.markdownFallback", {
                  defaultValue: "Markdown fallback",
                })}
                description={t("items.detail.markdownFallbackTooltip", {
                  defaultValue:
                    "LLM response omitted cleaned_markdown; showing crawled markdown as fallback.",
                })}
              />
            ) : null}
            <MarkdownViewer markdown={resolvedArticleContent!} />
          </Space>
        ) : (
          <ChartEmptyState
            className="h-auto py-6"
            description={t("items.detail.fullTextEmpty", {
              defaultValue: "No translated article text available.",
            })}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            className="content-card"
            title={t("items.detail.metaTitle", { defaultValue: "Metadata" })}
          >
            <Descriptions column={1} size="small">
              <Descriptions.Item
                label={t("items.detail.fields.itemId", {
                  defaultValue: "Item ID",
                })}
              >
                {item.id}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.externalId", {
                  defaultValue: "External ID",
                })}
              >
                {item.meta?.externalId ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.status", {
                  defaultValue: "Status",
                })}
              >
                <Tag color="blue">{item.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.processedStatus", {
                  defaultValue: "Processed status",
                })}
              >
                {processedStatus ? (
                  <Tag color="geekblue">{processedStatus}</Tag>
                ) : (
                  t("common.notAvailable")
                )}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.duplicateSimilarity", {
                  defaultValue: "Duplicate similarity",
                })}
              >
                {duplicateScoreLabel}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.duplicateOf", {
                  defaultValue: "Duplicate of",
                })}
              >
                {duplicateOf ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.llmModel", {
                  defaultValue: "LLM model",
                })}
              >
                {llmModel}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.llmLatency", {
                  defaultValue: "LLM latency",
                })}
              >
                {llmLatency}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.llmCost", {
                  defaultValue: "LLM cost",
                })}
              >
                {llmCost}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.llmTokens", {
                  defaultValue: "LLM total tokens",
                })}
              >
                {llmTokens}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.embeddingModel", {
                  defaultValue: "Embedding model",
                })}
              >
                {embeddingModel ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.embeddingDims", {
                  defaultValue: "Embedding dims",
                })}
              >
                {embeddingDimensionsLabel}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.createdAt", {
                  defaultValue: "Created at",
                })}
              >
                {formatDateTime(item.createdAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.updatedAt", {
                  defaultValue: "Updated at",
                })}
              >
                {formatDateTime(item.updatedAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.publishedAt", {
                  defaultValue: "Published at",
                })}
              >
                {formattedPublishedAt}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.source", {
                  defaultValue: "Source",
                })}
              >
                {source ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.rawSource", {
                  defaultValue: "Raw source",
                })}
              >
                {rawSource ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.author", {
                  defaultValue: "Author",
                })}
              >
                {author ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.language", {
                  defaultValue: "Language",
                })}
              >
                {language ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.location", {
                  defaultValue: "Location",
                })}
              >
                {location ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.category", {
                  defaultValue: "Category",
                })}
              >
                {category ?? t("common.notAvailable")}
              </Descriptions.Item>
              <Descriptions.Item
                label={t("items.detail.fields.contentType", {
                  defaultValue: "Content type",
                })}
              >
                {contentTypeLabel ?? t("common.notAvailable")}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            className="content-card"
            title={t("items.detail.contextTitle", { defaultValue: "Context" })}
          >
            {topics.length === 0 && entities.length === 0 ? (
              <ChartEmptyState
                className="h-auto py-6"
                description={t("items.detail.contextEmpty", {
                  defaultValue: "No topics or entities.",
                })}
              />
            ) : (
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                {topicsDisplay.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {topicsDisplay.map((topic) => {
                      const subscriptionKey = buildDigestSubscriptionKey(
                        "topic",
                        topic,
                      );
                      const metadata = contentMetadataByKey[subscriptionKey];
                      const isBusy = Boolean(
                        subscriptionBusyByKey[subscriptionKey],
                      );
                      const isSubscribed = hasDigestSubscription(
                        digestPreference?.focusTopics,
                        topic,
                      );
                      return (
                        <Space key={`topic-${topic}`} size={4}>
                          <Tag
                            color="blue"
                            className="cursor-pointer"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSearch(topic)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleSearch(topic);
                              }
                            }}
                          >
                            {topic}
                          </Tag>
                          {metadata?.taxonomyDisplayName ? (
                            <Tag>{metadata.taxonomyDisplayName}</Tag>
                          ) : null}
                          <Tooltip
                            title={
                              isSubscribed
                                ? t("items.detail.subscribedTopic", {
                                    defaultValue: "Topic subscribed",
                                  })
                                : t("items.detail.subscribeTopic", {
                                    defaultValue: "Subscribe topic",
                                  })
                            }
                          >
                            <Button
                              type="link"
                              size="small"
                              className="px-0"
                              loading={isBusy}
                              disabled={isSubscribed}
                              onClick={() => {
                                void handleBookmarkPreference("topic", topic);
                              }}
                            >
                              {isSubscribed
                                ? t("items.detail.subscribedAction", {
                                    defaultValue: "Subscribed",
                                  })
                                : t("items.detail.subscribeAction", {
                                    defaultValue: "Subscribe",
                                  })}
                            </Button>
                          </Tooltip>
                        </Space>
                      );
                    })}
                    {extraTopics > 0 ? <Tag>+{extraTopics}</Tag> : null}
                  </Space>
                ) : null}
                {entitiesDisplay.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {entitiesDisplay.map((entity) => {
                      const subscriptionKey = buildDigestSubscriptionKey(
                        "entity",
                        entity,
                      );
                      const metadata = contentMetadataByKey[subscriptionKey];
                      const isBusy = Boolean(
                        subscriptionBusyByKey[subscriptionKey],
                      );
                      const isSubscribed = hasDigestSubscription(
                        digestPreference?.focusEntities,
                        entity,
                      );
                      return (
                        <Space key={`entity-${entity}`} size={4}>
                          <Tag
                            color="purple"
                            className="cursor-pointer"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSearch(entity)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleSearch(entity);
                              }
                            }}
                          >
                            {entity}
                          </Tag>
                          {metadata?.taxonomyDisplayName ? (
                            <Tag>{metadata.taxonomyDisplayName}</Tag>
                          ) : null}
                          <Tooltip
                            title={
                              isSubscribed
                                ? t("items.detail.subscribedEntity", {
                                    defaultValue: "Entity subscribed",
                                  })
                                : t("items.detail.subscribeEntity", {
                                    defaultValue: "Subscribe entity",
                                  })
                            }
                          >
                            <Button
                              type="link"
                              size="small"
                              className="px-0"
                              loading={isBusy}
                              disabled={isSubscribed}
                              onClick={() => {
                                void handleBookmarkPreference("entity", entity);
                              }}
                            >
                              {isSubscribed
                                ? t("items.detail.subscribedAction", {
                                    defaultValue: "Subscribed",
                                  })
                                : t("items.detail.subscribeAction", {
                                    defaultValue: "Subscribe",
                                  })}
                            </Button>
                          </Tooltip>
                        </Space>
                      );
                    })}
                    {extraEntities > 0 ? <Tag>+{extraEntities}</Tag> : null}
                  </Space>
                ) : null}
                {relatedTopics.length > 0 ? (
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <Typography.Text type="secondary">
                      {t("items.detail.relatedTopics", {
                        defaultValue: "Related topics",
                      })}
                    </Typography.Text>
                    <Space wrap size={[6, 6]}>
                      {relatedTopics.map((topic) => {
                        const subscriptionKey = buildDigestSubscriptionKey(
                          "topic",
                          topic.displayValue,
                        );
                        const isBusy = Boolean(
                          subscriptionBusyByKey[subscriptionKey],
                        );
                        const isSubscribed = hasDigestSubscription(
                          digestPreference?.focusTopics,
                          topic.displayValue,
                        );
                        return (
                          <Space
                            key={`related-${topic.normalizedValue}`}
                            size={4}
                          >
                            <Tag
                              color="geekblue"
                              className="cursor-pointer"
                              role="button"
                              tabIndex={0}
                              onClick={() => handleSearch(topic.displayValue)}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  handleSearch(topic.displayValue);
                                }
                              }}
                            >
                              {topic.displayValue}
                            </Tag>
                            {topic.taxonomyDisplayName ? (
                              <Tag>{topic.taxonomyDisplayName}</Tag>
                            ) : null}
                            <Tooltip
                              title={
                                isSubscribed
                                  ? t("items.detail.subscribedTopic", {
                                      defaultValue: "Topic subscribed",
                                    })
                                  : t("items.detail.subscribeRelatedTopic", {
                                      defaultValue: "Subscribe related topic",
                                    })
                              }
                            >
                              <Button
                                type="link"
                                size="small"
                                className="px-0"
                                loading={isBusy}
                                disabled={isSubscribed}
                                onClick={() => {
                                  void handleBookmarkPreference(
                                    "topic",
                                    topic.displayValue,
                                  );
                                }}
                              >
                                {isSubscribed
                                  ? t("items.detail.subscribedAction", {
                                      defaultValue: "Subscribed",
                                    })
                                  : t("items.detail.subscribeAction", {
                                      defaultValue: "Subscribe",
                                    })}
                              </Button>
                            </Tooltip>
                          </Space>
                        );
                      })}
                    </Space>
                  </Space>
                ) : null}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Card
        className="content-card"
        title={t("items.detail.payloadTitle", {
          defaultValue: "Full text & JSON",
        })}
      >
        {payloadPanels.length > 0 ? (
          <Collapse
            activeKey={activePayloadPanelKeys}
            onChange={handlePayloadCollapseChange}
            items={payloadPanels}
            ghost
          />
        ) : (
          <ChartEmptyState
            className="h-auto py-6"
            description={t("items.detail.payloadEmpty", {
              defaultValue: "No payload available.",
            })}
          />
        )}
      </Card>
    </div>
  );
}

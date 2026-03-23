"use client";

import {
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { gql, type ApolloError, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Grid,
  Input,
  Select,
  Spin,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { trackSearchTelemetry } from "@/lib/search-telemetry";
import { safeHttpUrl } from "@/lib/url";
import { useDebounceValue } from "@/lib/use-debounce-value";
import {
  ARCHIVE_PAGE_SIZE,
  DEFAULT_REGION,
  DEFAULT_WEIGHTS,
  MIN_ARCHIVE_SEARCH_QUERY_LENGTH,
  REGION_OPTIONS,
  VERTICAL_FALLBACK_LABEL,
  VERTICAL_SECTIONS,
  type ArchiveClassificationDetail,
  type ArchiveEventItem,
  type ArchiveMatchOrigin,
  type ArchiveRegion,
  resolveArchiveClassificationI18nKeys,
  resolveArchiveClassificationSignals,
  resolveArchiveItemPreview,
  resolveArchiveRelevancePercent,
  resolveArchiveSearchFeedbackVisualState,
  resolveArchiveVerticalTone,
  resolveArchiveWeightStars,
  type ArchiveVertical,
  type ArchiveWeight,
} from "./events-archive-display";
import {
  buildCalendarCountMap,
  canNavigateToNextDay,
  formatSelectedDateParam,
  parseDateParamUtc,
  toAnchorIso,
} from "./events-archive-helpers";

interface ArchiveVerticalGroup {
  vertical: ArchiveVertical;
  displayName: string;
  totalCount: number;
  items: ArchiveEventItem[];
  pageInfo: {
    hasMore: boolean;
    nextCursor?: string | null;
  };
}

interface ArchiveDigestData {
  anchorDate: string;
  region: ArchiveRegion;
  totalCount: number;
  preparation: {
    state: "IDLE" | "QUEUED" | "PROCESSING" | "PARTIAL" | "READY" | "FAILED";
    readyCount: number;
    missingCount: number;
    updatedAt: string;
    errorMessage?: string | null;
  };
  groups: ArchiveVerticalGroup[];
}

interface ArchiveCalendarDay {
  date: string;
  count: number;
}

interface ArchiveDetailData {
  processedArticleId: string;
  eventId?: string | null;
  title?: string | null;
  summary?: string | null;
  fullEntities: string[];
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  classification?: ArchiveClassificationDetail | null;
  timeline: Array<{
    id: string;
    bucketStart: string;
    title?: string | null;
    summary?: string | null;
  }>;
  relatedArticles: Array<{
    processedArticleId: string;
    title?: string | null;
    summary?: string | null;
    publishedAt?: string | null;
    sourceLabel?: string | null;
    sourceUrl?: string | null;
  }>;
}

const ARCHIVE_DIGEST_QUERY = gql`
  query ArchiveDigest($input: ArchiveQueryInput!) {
    archiveDigest(input: $input) {
      anchorDate
      region
      totalCount
      preparation {
        state
        readyCount
        missingCount
        updatedAt
        errorMessage
      }
      groups {
        vertical
        displayName
        totalCount
        pageInfo {
          hasMore
          nextCursor
        }
        items {
          processedArticleId
          eventId
          title
          summary
          countryLabel
          region
          vertical
          weight
          qualityScore
          publishedAt
          sortAt
          sourceLabel
          sourceUrl
          entityTags
          keywordHighlights
          matchOrigin
          relevanceScore
        }
      }
    }
  }
`;

const ARCHIVE_CALENDAR_QUERY = gql`
  query ArchiveCalendar($input: ArchiveCalendarInput!) {
    archiveCalendar(input: $input) {
      date
      count
    }
  }
`;

const ARCHIVE_DETAIL_QUERY = gql`
  query ArchiveDetail($processedArticleId: String!) {
    archiveDetail(processedArticleId: $processedArticleId) {
      processedArticleId
      eventId
      title
      summary
      fullEntities
      sourceUrl
      sourceLabel
      classification {
        region
        vertical
        taxonomyVersion
        pipelineVersion
        embeddingModel
        rerankModel
        decisionReason
        decisionReasonI18nKey
        isStale
        staleReasons
        staleReasonI18nKeys
        ruleSignals
        scoreEntries {
          vertical
          ruleScore
          embeddingScore
          rerankScore
          fusedScore
        }
      }
      timeline {
        id
        bucketStart
        title
        summary
      }
      relatedArticles {
        processedArticleId
        title
        summary
        publishedAt
        sourceLabel
        sourceUrl
      }
    }
  }
`;

const WEIGHT_OPTIONS = [5, 4, 3, 2, 1] as const;
const WEIGHT_LABEL_KEY: Record<
  number,
  "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE"
> = {
  1: "ONE",
  2: "TWO",
  3: "THREE",
  4: "FOUR",
  5: "FIVE",
};
const SEARCH_DEBOUNCE_MS = 300;
const MATCH_ORIGIN_BADGE_CLASS_NAME: Record<ArchiveMatchOrigin, string> = {
  LEXICAL:
    "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-200",
  SEMANTIC:
    "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:border-violet-400/30 dark:bg-violet-400/15 dark:text-violet-200",
  HYBRID:
    "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-700 dark:border-fuchsia-400/30 dark:bg-fuchsia-400/15 dark:text-fuchsia-200",
};

const weightToEnum = (value: number): ArchiveWeight | null => {
  if (value === 1) return "ONE";
  if (value === 2) return "TWO";
  if (value === 3) return "THREE";
  if (value === 4) return "FOUR";
  if (value === 5) return "FIVE";
  return null;
};

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseRegionParam = (value: string | null): ArchiveRegion => {
  if (!value) {
    return DEFAULT_REGION;
  }
  const matched = REGION_OPTIONS.find((option) => option === value);
  return matched ?? DEFAULT_REGION;
};

const parseWeightsParam = (value: string | null) => {
  if (!value) {
    return [...DEFAULT_WEIGHTS];
  }
  const parsed = value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= 5);
  if (parsed.length === 0) {
    return [...DEFAULT_WEIGHTS];
  }
  return Array.from(new Set(parsed)).sort((a, b) => b - a);
};

const tokenizeSearch = (search: string) =>
  search
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 8);

function renderHighlightedText(text: string, tokens: string[]) {
  if (!text || tokens.length === 0) {
    return text;
  }
  const escaped = tokens
    .map((token) => escapeRegex(token))
    .filter((token) => token.length > 0);
  if (escaped.length === 0) {
    return text;
  }

  const regex = new RegExp(`(${escaped.join("|")})`, "ig");
  const parts = text.split(regex);
  const tokenSet = new Set(tokens.map((token) => token.toLowerCase()));
  return (
    <>
      {parts.map((part, index) => {
        const key = `${part}-${index}`;
        if (tokenSet.has(part.toLowerCase())) {
          return (
            <mark
              key={key}
              className="rounded-sm bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-400/30 dark:text-amber-100"
            >
              {part}
            </mark>
          );
        }
        return <span key={key}>{part}</span>;
      })}
    </>
  );
}

const extractAppCodeFromError = (error: ApolloError | undefined) => {
  if (!error?.graphQLErrors) {
    return null;
  }
  for (const graphError of error.graphQLErrors) {
    const appCode = graphError.extensions?.appCode;
    if (typeof appCode === "string" && appCode.trim().length > 0) {
      return appCode.trim();
    }
  }
  return null;
};

const extractTraceIdFromError = (error: ApolloError | undefined) => {
  if (!error?.graphQLErrors) {
    return null;
  }
  for (const graphError of error.graphQLErrors) {
    const traceId = graphError.extensions?.traceId;
    if (typeof traceId === "string" && traceId.trim().length > 0) {
      return traceId.trim();
    }
  }
  return null;
};

export function EventsArchiveContent() {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentDate = useMemo(
    () => parseDateParamUtc(searchParams.get("date")),
    [searchParams],
  );
  const currentRegion = useMemo(
    () => parseRegionParam(searchParams.get("region")),
    [searchParams],
  );
  const currentWeights = useMemo(
    () => parseWeightsParam(searchParams.get("weights")),
    [searchParams],
  );
  const currentSearch = useMemo(
    () => (searchParams.get("q") ?? "").trim(),
    [searchParams],
  );

  const [searchInput, setSearchInput] = useState(currentSearch);
  const [loadingMoreByVertical, setLoadingMoreByVertical] = useState<
    Partial<Record<ArchiveVertical, boolean>>
  >({});
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const openArchiveDetail = useCallback((processedArticleId: string) => {
    const normalizedId = processedArticleId.trim();
    if (!normalizedId) {
      return;
    }
    setSelectedDetailId(normalizedId);
  }, []);

  useEffect(() => {
    setSearchInput(currentSearch);
  }, [currentSearch]);

  const updateUrl = useCallback(
    (updates: {
      date?: string;
      region?: ArchiveRegion;
      weights?: number[];
      search?: string;
    }) => {
      const nextDate = updates.date ?? currentDate;
      const nextRegion = updates.region ?? currentRegion;
      const nextWeights = (updates.weights ?? currentWeights)
        .slice()
        .sort((a, b) => b - a);
      const nextSearch = (updates.search ?? currentSearch).trim();

      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.set("date", nextDate);

      if (nextRegion === DEFAULT_REGION) {
        nextParams.delete("region");
      } else {
        nextParams.set("region", nextRegion);
      }

      if (
        nextWeights.length === DEFAULT_WEIGHTS.length &&
        nextWeights.every((value, index) => value === DEFAULT_WEIGHTS[index])
      ) {
        nextParams.delete("weights");
      } else {
        nextParams.set("weights", nextWeights.join(","));
      }

      if (!nextSearch) {
        nextParams.delete("q");
      } else {
        nextParams.set("q", nextSearch);
      }

      const query = nextParams.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [
      currentDate,
      currentRegion,
      currentSearch,
      currentWeights,
      pathname,
      router,
      searchParams,
    ],
  );

  const debouncedSearch = useDebounceValue(searchInput, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    const normalized = debouncedSearch.trim();
    if (normalized === currentSearch) {
      return;
    }
    updateUrl({ search: normalized });
  }, [currentSearch, debouncedSearch, updateUrl]);

  const selectedWeightEnums = useMemo(
    () =>
      currentWeights
        .map((weight) => weightToEnum(weight))
        .filter((weight): weight is ArchiveWeight => Boolean(weight)),
    [currentWeights],
  );
  const regionOptions = useMemo(
    () =>
      REGION_OPTIONS.map((value) => ({
        value,
        label: t(`pages.eventsArchive.regions.${value}`, {
          defaultValue: value,
        }),
      })),
    [t],
  );
  const regionLabels = useMemo(
    () =>
      Object.fromEntries(
        regionOptions.map((option) => [option.value, option.label]),
      ) as Record<ArchiveRegion, string>,
    [regionOptions],
  );
  const sectionLabels = useMemo(
    () => ({
      geo: t("pages.eventsArchive.sections.geo", {
        defaultValue: "地缘热点组",
      }),
      macro: t("pages.eventsArchive.sections.macro", {
        defaultValue: "宏观事务组",
      }),
    }),
    [t],
  );
  const verticalLabels = useMemo(
    () => ({
      EAST_SEA: t("pages.eventsArchive.verticals.EAST_SEA", {
        defaultValue: VERTICAL_FALLBACK_LABEL.EAST_SEA,
      }),
      SOUTH_SEA: t("pages.eventsArchive.verticals.SOUTH_SEA", {
        defaultValue: VERTICAL_FALLBACK_LABEL.SOUTH_SEA,
      }),
      WEST_FRONT: t("pages.eventsArchive.verticals.WEST_FRONT", {
        defaultValue: VERTICAL_FALLBACK_LABEL.WEST_FRONT,
      }),
      FOREIGN_AFFAIRS: t("pages.eventsArchive.verticals.FOREIGN_AFFAIRS", {
        defaultValue: VERTICAL_FALLBACK_LABEL.FOREIGN_AFFAIRS,
      }),
      DOMESTIC_AFFAIRS: t("pages.eventsArchive.verticals.DOMESTIC_AFFAIRS", {
        defaultValue: VERTICAL_FALLBACK_LABEL.DOMESTIC_AFFAIRS,
      }),
    }),
    [t],
  );
  const weightOptions = useMemo(
    () =>
      WEIGHT_OPTIONS.map((value) => ({
        value,
        label: t(`pages.eventsArchive.weights.${WEIGHT_LABEL_KEY[value]}`, {
          defaultValue: `${"★".repeat(value)} ${value}`,
        }),
      })),
    [t],
  );
  const normalizedDebouncedSearch = debouncedSearch.trim();
  const isSearchQueryTooShort =
    normalizedDebouncedSearch.length > 0 &&
    normalizedDebouncedSearch.length < MIN_ARCHIVE_SEARCH_QUERY_LENGTH;
  const archiveSearchQuery = isSearchQueryTooShort
    ? ""
    : normalizedDebouncedSearch;

  const archiveInput = useMemo(
    () => ({
      anchorDate: toAnchorIso(currentDate),
      region: currentRegion,
      ...(archiveSearchQuery ? { search: archiveSearchQuery } : {}),
      weights: selectedWeightEnums,
      pageSize: ARCHIVE_PAGE_SIZE,
    }),
    [archiveSearchQuery, currentDate, currentRegion, selectedWeightEnums],
  );

  const {
    data: digestData,
    loading: digestLoading,
    error: digestError,
    refetch: refetchDigest,
    fetchMore: fetchMoreDigest,
  } = useQuery<{ archiveDigest: ArchiveDigestData }>(ARCHIVE_DIGEST_QUERY, {
    variables: { input: archiveInput },
    fetchPolicy: "network-only",
  });

  const monthParam = currentDate.slice(0, 7);
  const { data: calendarData, error: calendarError } = useQuery<{
    archiveCalendar: ArchiveCalendarDay[];
  }>(ARCHIVE_CALENDAR_QUERY, {
    variables: {
      input: {
        month: monthParam,
        region: currentRegion,
      },
    },
    fetchPolicy: "cache-and-network",
  });

  const selectedDate = useMemo(
    () => dayjs.utc(`${currentDate}T00:00:00.000Z`),
    [currentDate],
  );
  const prevDateParam = useMemo(
    () => selectedDate.subtract(1, "day").format("YYYY-MM-DD"),
    [selectedDate],
  );
  const nextDateParam = useMemo(
    () => selectedDate.add(1, "day").format("YYYY-MM-DD"),
    [selectedDate],
  );
  const nextMonthParam = useMemo(
    () => nextDateParam.slice(0, 7),
    [nextDateParam],
  );
  const needsNextMonthCalendar = nextMonthParam !== monthParam;
  const { data: nextMonthCalendarData, error: nextMonthCalendarError } =
    useQuery<{
      archiveCalendar: ArchiveCalendarDay[];
    }>(ARCHIVE_CALENDAR_QUERY, {
      variables: {
        input: {
          month: nextMonthParam,
          region: currentRegion,
        },
      },
      skip: !needsNextMonthCalendar,
      fetchPolicy: "cache-and-network",
    });
  const digest = digestData?.archiveDigest;
  const totalCount = digest?.totalCount ?? 0;
  const preparation = digest?.preparation ?? null;
  const groupMap = useMemo<Map<ArchiveVertical, ArchiveVerticalGroup>>(
    () =>
      new Map<ArchiveVertical, ArchiveVerticalGroup>(
        (digest?.groups ?? []).map((group) => [group.vertical, group]),
      ),
    [digest?.groups],
  );
  const calendarCountByDate = useMemo(
    () => buildCalendarCountMap(calendarData?.archiveCalendar),
    [calendarData?.archiveCalendar],
  );
  const nextMonthCountByDate = useMemo(
    () => buildCalendarCountMap(nextMonthCalendarData?.archiveCalendar),
    [nextMonthCalendarData?.archiveCalendar],
  );
  const todayDateParam = useMemo(() => dayjs.utc().format("YYYY-MM-DD"), []);
  const hasPreparationPending = useMemo(
    () =>
      Boolean(
        preparation &&
          preparation.state !== "READY" &&
          preparation.state !== "IDLE",
      ),
    [preparation],
  );
  const canGoNext = useMemo(() => {
    if (hasPreparationPending) {
      return nextDateParam <= todayDateParam;
    }
    return canNavigateToNextDay({
      nextDateParam,
      currentMonthParam: monthParam,
      currentMonthCountByDate: calendarCountByDate,
      nextMonthCountByDate: needsNextMonthCalendar
        ? nextMonthCountByDate
        : undefined,
    });
  }, [
    calendarCountByDate,
    hasPreparationPending,
    monthParam,
    needsNextMonthCalendar,
    nextDateParam,
    nextMonthCountByDate,
    todayDateParam,
  ]);

  const highlightTokens = useMemo(
    () => tokenizeSearch(debouncedSearch),
    [debouncedSearch],
  );

  const {
    data: detailData,
    loading: detailLoading,
    error: detailError,
  } = useQuery<{ archiveDetail: ArchiveDetailData | null }>(
    ARCHIVE_DETAIL_QUERY,
    {
      variables: { processedArticleId: selectedDetailId ?? "" },
      skip: !selectedDetailId,
      fetchPolicy: "network-only",
    },
  );
  const detail = detailData?.archiveDetail ?? null;
  const detailClassification = detail?.classification ?? null;
  const visibleClassificationSignals = useMemo(
    () =>
      detailClassification
        ? resolveArchiveClassificationSignals(
            detailClassification.ruleSignals,
            8,
          )
        : [],
    [detailClassification],
  );
  const visibleClassificationStaleReasons = useMemo(
    () =>
      detailClassification?.isStale
        ? resolveArchiveClassificationI18nKeys(
            detailClassification.staleReasonI18nKeys,
            4,
          )
        : [],
    [detailClassification],
  );
  const searchMode = archiveSearchQuery.length > 0;
  const normalizedSearchInput = searchInput.trim();
  const isSearchPending = normalizedSearchInput !== normalizedDebouncedSearch;
  const digestAppCode = useMemo(
    () => extractAppCodeFromError(digestError),
    [digestError],
  );
  const digestTraceId = useMemo(
    () => extractTraceIdFromError(digestError),
    [digestError],
  );
  const calendarQueryError = calendarError ?? nextMonthCalendarError;
  const calendarTraceId = useMemo(
    () => extractTraceIdFromError(calendarQueryError ?? undefined),
    [calendarQueryError],
  );

  useEffect(() => {
    if (!digestError) {
      return;
    }
    console.error("events-archive digest query failed", {
      appCode: digestAppCode,
      traceId: digestTraceId,
      anchorDate: currentDate,
      region: currentRegion,
      search: archiveSearchQuery,
      message: digestError.message,
    });
  }, [
    archiveSearchQuery,
    currentDate,
    currentRegion,
    digestAppCode,
    digestError,
    digestTraceId,
  ]);

  useEffect(() => {
    if (!calendarQueryError) {
      return;
    }
    console.error("events-archive calendar query failed", {
      traceId: calendarTraceId,
      month: monthParam,
      region: currentRegion,
      message: calendarQueryError.message,
    });
  }, [calendarQueryError, calendarTraceId, currentRegion, monthParam]);

  useEffect(() => {
    if (!detailError || !selectedDetailId) {
      return;
    }
    const traceId = extractTraceIdFromError(detailError);
    console.error("events-archive detail query failed", {
      processedArticleId: selectedDetailId,
      traceId,
      message: detailError.message,
    });
  }, [detailError, selectedDetailId]);

  useEffect(() => {
    setLoadingMoreByVertical({});
  }, [archiveInput, currentDate, currentRegion]);

  useEffect(() => {
    if (!normalizedDebouncedSearch) {
      return;
    }
    if (isSearchQueryTooShort) {
      void trackSearchTelemetry({
        eventType: "archive_query_too_short",
        surface: "events_archive",
        queryLength: normalizedDebouncedSearch.length,
      });
      return;
    }
    void trackSearchTelemetry({
      eventType: "archive_search_submit",
      surface: "events_archive",
      queryLength: normalizedDebouncedSearch.length,
    });
  }, [isSearchQueryTooShort, normalizedDebouncedSearch]);

  const digestErrorDescription = useMemo(() => {
    if (!digestError) {
      return null;
    }
    if (!searchMode) {
      return t("pages.eventsArchive.errors.digestLoadFailed", {
        defaultValue: "归档加载失败，请稍后重试。",
      });
    }
    switch (digestAppCode) {
      case "ARCHIVE_EMBEDDING_UNAVAILABLE":
        return t("pages.eventsArchive.errors.embeddingUnavailable", {
          defaultValue: "语义检索模型未配置，请联系管理员。",
        });
      case "ARCHIVE_EMBEDDING_FAILED":
        return t("pages.eventsArchive.errors.embeddingFailed", {
          defaultValue: "语义向量生成失败，请稍后重试。",
        });
      case "ARCHIVE_EMBEDDING_INVALID_RESPONSE":
        return t("pages.eventsArchive.errors.embeddingInvalidResponse", {
          defaultValue: "语义向量返回异常，请稍后重试。",
        });
      case "ARCHIVE_VECTOR_UNAVAILABLE":
        return t("pages.eventsArchive.errors.vectorUnavailable", {
          defaultValue: "向量召回服务不可用，请稍后重试。",
        });
      case "ARCHIVE_RERANK_FAILED":
        return t("pages.eventsArchive.errors.rerankFailed", {
          defaultValue: "结果精排失败，请稍后重试。",
        });
      case "ARCHIVE_RERANK_INVALID_RESPONSE":
        return t("pages.eventsArchive.errors.rerankInvalidResponse", {
          defaultValue: "结果精排返回异常，请稍后重试。",
        });
      case "ARCHIVE_SCAN_LIMIT_EXCEEDED":
        return t("pages.eventsArchive.errors.scanLimitExceeded", {
          defaultValue: "当前筛选范围过大，请缩小日期或条件后重试。",
        });
      default:
        return digestError.message;
    }
  }, [digestAppCode, digestError, searchMode, t]);
  const preparationAlert = useMemo(() => {
    if (
      !preparation ||
      preparation.state === "READY" ||
      preparation.state === "IDLE"
    ) {
      return null;
    }

    if (preparation.state === "FAILED") {
      return {
        type: "warning" as const,
        message: t("pages.eventsArchive.preparation.failedTitle", {
          defaultValue: "归档后台补齐失败",
        }),
        description:
          preparation.errorMessage?.trim() ||
          t("pages.eventsArchive.preparation.failedBody", {
            defaultValue: "后台任务已中断，请点击刷新后重试。",
          }),
      };
    }

    if (preparation.state === "PARTIAL") {
      return {
        type: "info" as const,
        message: t("pages.eventsArchive.preparation.partialTitle", {
          defaultValue: "归档数据正在后台补齐",
        }),
        description: t("pages.eventsArchive.preparation.partialBody", {
          defaultValue:
            "当前已展示 {{ready}} 条就绪结果，仍有 {{missing}} 条待补齐；日历标记与每日计数仅覆盖已准备部分。",
          ready: preparation.readyCount,
          missing: preparation.missingCount,
        }),
      };
    }

    if (searchMode) {
      return {
        type: "info" as const,
        message: t("pages.eventsArchive.preparation.searchCoverageTitle", {
          defaultValue: "搜索状态与归档预热分离显示",
        }),
        description: t("pages.eventsArchive.preparation.searchCoverageBody", {
          defaultValue:
            "当前搜索功能可用，但归档底库仍在后台补齐，搜索结果只覆盖已完成归档分类的记录。",
        }),
      };
    }

    return {
      type: "info" as const,
      message: t("pages.eventsArchive.preparation.loadingTitle", {
        defaultValue: "归档数据准备中",
      }),
      description: t("pages.eventsArchive.preparation.loadingBody", {
        defaultValue:
          "后台正在预热归档分类；日历标记与每日计数暂只覆盖已准备部分，请稍后刷新查看完整结果。",
      }),
    };
  }, [preparation, searchMode, t]);
  const calendarCoverageHint = useMemo(() => {
    if (!hasPreparationPending || searchMode) {
      return null;
    }
    return t("pages.eventsArchive.preparation.calendarCoverageHint", {
      defaultValue: "日历标记和本日统计当前仅覆盖已完成归档分类的部分数据。",
    });
  }, [hasPreparationPending, searchMode, t]);
  const searchFeedback = useMemo(() => {
    if (!normalizedSearchInput) {
      return null;
    }
    if (isSearchPending) {
      return {
        tone: "pending" as const,
        message: t("pages.eventsArchive.searchFeedback.updating", {
          defaultValue: "Updating search…",
        }),
      };
    }
    if (isSearchQueryTooShort) {
      return {
        tone: "info" as const,
        message: t("pages.eventsArchive.searchFeedback.tooShort", {
          defaultValue:
            "Enter at least {{min}} characters to start semantic archive search.",
          min: MIN_ARCHIVE_SEARCH_QUERY_LENGTH,
        }),
      };
    }
    if (digestLoading && searchMode) {
      return {
        tone: "loading" as const,
        message: t("pages.eventsArchive.searchFeedback.loading", {
          defaultValue: "Searching archive…",
        }),
      };
    }
    if (digestError && searchMode) {
      return {
        tone: "error" as const,
        message: t("pages.eventsArchive.searchFeedback.error", {
          defaultValue: "Search failed. Please retry.",
        }),
      };
    }
    if (searchMode && totalCount === 0) {
      return {
        tone: "empty" as const,
        message: t("pages.eventsArchive.searchFeedback.empty", {
          defaultValue: "No matching records.",
        }),
      };
    }
    if (searchMode) {
      return {
        tone: "ready" as const,
        message: t("pages.eventsArchive.searchFeedback.ready", {
          defaultValue: "{{count}} records matched",
          count: totalCount,
        }),
      };
    }
    return null;
  }, [
    digestError,
    digestLoading,
    isSearchPending,
    normalizedSearchInput,
    isSearchQueryTooShort,
    searchMode,
    t,
    totalCount,
  ]);
  const searchFeedbackVisualState = useMemo(
    () =>
      searchFeedback
        ? resolveArchiveSearchFeedbackVisualState(searchFeedback.tone)
        : null,
    [searchFeedback],
  );
  const archiveDateDisplay = selectedDate.format("YYYY/MM/DD");
  const currentRegionLabel =
    regionOptions.find((region) => region.value === currentRegion)?.label ??
    currentRegion;
  const unknownCountryLabel = t("pages.eventsArchive.unknownCountry", {
    defaultValue: "未知",
  });
  const untitledArchiveLabel = t("pages.eventsArchive.untitled", {
    defaultValue: "未命名事件",
  });

  const handleDateSelect = (value: Dayjs | null) => {
    if (!value) {
      return;
    }
    const nextDate = parseDateParamUtc(formatSelectedDateParam(value));
    updateUrl({ date: nextDate });
  };

  const handleWeightChange = (values: number[]) => {
    const normalized = values
      .filter((value) => Number.isFinite(value) && value >= 1 && value <= 5)
      .sort((a, b) => b - a);
    updateUrl({
      weights: normalized.length > 0 ? normalized : [...DEFAULT_WEIGHTS],
    });
  };

  const mergeArchiveItems = useCallback(
    (current: ArchiveEventItem[], incoming: ArchiveEventItem[]) => {
      const seen = new Set(current.map((item) => item.processedArticleId));
      const merged = [...current];
      for (const item of incoming) {
        if (seen.has(item.processedArticleId)) {
          continue;
        }
        seen.add(item.processedArticleId);
        merged.push(item);
      }
      return merged;
    },
    [],
  );

  const handleLoadMore = useCallback(
    async (vertical: ArchiveVertical) => {
      const group = groupMap.get(vertical);
      if (!group?.pageInfo.hasMore || !group.pageInfo.nextCursor) {
        return;
      }
      if (loadingMoreByVertical[vertical]) {
        return;
      }

      setLoadingMoreByVertical((current) => ({
        ...current,
        [vertical]: true,
      }));
      void trackSearchTelemetry({
        eventType: "archive_load_more_click",
        surface: "events_archive",
        vertical,
      });
      try {
        await fetchMoreDigest({
          variables: {
            input: {
              ...archiveInput,
              cursors: [{ vertical, cursor: group.pageInfo.nextCursor }],
            },
          },
          updateQuery: (previous, { fetchMoreResult }) => {
            if (!fetchMoreResult?.archiveDigest) {
              return previous;
            }
            const incomingDigest = fetchMoreResult.archiveDigest;
            const incomingGroup = incomingDigest.groups.find(
              (entry) => entry.vertical === vertical,
            );
            if (!incomingGroup) {
              return previous;
            }

            return {
              archiveDigest: {
                ...incomingDigest,
                groups: previous.archiveDigest.groups.map((entry) => {
                  if (entry.vertical !== vertical) {
                    return entry;
                  }
                  return {
                    ...entry,
                    displayName: incomingGroup.displayName,
                    totalCount: incomingGroup.totalCount,
                    pageInfo: incomingGroup.pageInfo,
                    items: mergeArchiveItems(entry.items, incomingGroup.items),
                  };
                }),
              },
            };
          },
        });
      } finally {
        setLoadingMoreByVertical((current) => ({
          ...current,
          [vertical]: false,
        }));
      }
    },
    [
      archiveInput,
      fetchMoreDigest,
      groupMap,
      loadingMoreByVertical,
      mergeArchiveItems,
    ],
  );

  return (
    <div className="flex flex-col gap-5">
      <section className="relative overflow-hidden rounded-[28px] border border-slate-200/70 bg-white/75 px-5 py-5 shadow-[0_24px_70px_-48px_rgba(15,23,42,0.55)] dark:border-slate-700/70 dark:bg-slate-900/45 sm:px-6 sm:py-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.14),transparent_34%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_30%)] dark:bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.18),transparent_34%),radial-gradient(circle_at_top_right,rgba(96,165,250,0.18),transparent_30%)]" />
        <div className="relative flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex max-w-3xl flex-col gap-2">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t("pages.eventsArchive.title", { defaultValue: "历史档案日报" })}
            </Typography.Title>
            <Typography.Text type="secondary" className="max-w-2xl">
              {t("pages.eventsArchive.subtitle", {
                defaultValue:
                  "按日期回溯已处理新闻情报，并按预设领域编年归档。",
              })}
            </Typography.Text>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 xl:justify-end">
            <span className="inline-flex items-center gap-2 rounded-2xl border border-slate-300/80 bg-white/72 px-3.5 py-2 text-xs font-medium text-slate-700 shadow-sm dark:border-slate-600/80 dark:bg-slate-950/60 dark:text-slate-200">
              <span className="h-2 w-2 rounded-full bg-sky-500 dark:bg-sky-300" />
              {currentRegionLabel}
            </span>
            <span className="inline-flex items-center rounded-2xl border border-slate-300/80 bg-white/72 px-3.5 py-2 text-xs font-medium text-slate-700 shadow-sm dark:border-slate-600/80 dark:bg-slate-950/60 dark:text-slate-200">
              {archiveDateDisplay}
            </span>
            {currentSearch ? (
              <span className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-3.5 py-2 text-xs font-medium text-cyan-800 shadow-sm dark:border-cyan-400/30 dark:bg-cyan-400/15 dark:text-cyan-100">
                <SearchOutlined className="text-[11px]" />
                <span className="max-w-[16rem] truncate">{currentSearch}</span>
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <Card className="content-card !overflow-hidden">
        <div className="flex flex-col gap-5">
          <section className="archive-toolbar">
            <div className="archive-toolbar__region-rail">
              <div className="archive-toolbar__region-track">
                {regionOptions.map((region) => {
                  const active = region.value === currentRegion;
                  return (
                    <button
                      key={region.value}
                      type="button"
                      className={`archive-region-tab ${
                        active ? "archive-region-tab--active" : ""
                      }`}
                      onClick={() => updateUrl({ region: region.value })}
                    >
                      {region.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="archive-toolbar__main">
              <div className="archive-toolbar__panel archive-toolbar__panel--summary">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <Typography.Text className="archive-toolbar__eyebrow">
                      {archiveDateDisplay}
                    </Typography.Text>
                    <Typography.Title
                      level={3}
                      className="archive-toolbar__metric"
                    >
                      {t("pages.eventsArchive.dailyCount", {
                        defaultValue: "本日 {{count}} 条动态",
                        count: totalCount,
                      })}
                    </Typography.Title>
                  </div>

                  <div className="archive-toolbar__date-controls">
                    <Button
                      icon={<LeftOutlined />}
                      onClick={() => updateUrl({ date: prevDateParam })}
                    />
                    <div className="min-w-0 flex-1 sm:flex-none sm:min-w-[188px]">
                      <DatePicker
                        allowClear={false}
                        value={selectedDate}
                        format="YYYY/M/D"
                        onChange={handleDateSelect}
                        disabledDate={(value) =>
                          value.utc().isAfter(dayjs.utc(), "day")
                        }
                        cellRender={(current, info) => {
                          if (info.type !== "date") {
                            return info.originNode;
                          }
                          const dateCell = dayjs(current as Dayjs).utc();
                          if (!dateCell.isValid()) {
                            return info.originNode;
                          }
                          const key = dateCell.format("YYYY-MM-DD");
                          const count = calendarCountByDate.get(key) ?? 0;
                          if (count <= 0) {
                            return info.originNode;
                          }
                          return (
                            <div className="relative h-full">
                              {info.originNode}
                              <span className="absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-amber-500" />
                            </div>
                          );
                        }}
                      />
                    </div>
                    <Button
                      icon={<RightOutlined />}
                      onClick={() => updateUrl({ date: nextDateParam })}
                      disabled={!canGoNext}
                    />
                  </div>

                  <Typography.Text className="archive-toolbar__hint">
                    {calendarCoverageHint ?? "\u00A0"}
                  </Typography.Text>
                </div>
              </div>

              <div className="archive-toolbar__panel archive-toolbar__panel--filters">
                <div className="archive-toolbar__controls">
                  <div className="archive-toolbar__control-row">
                    <div className="w-full lg:max-w-[248px]">
                      <Select
                        mode="multiple"
                        size="middle"
                        value={currentWeights}
                        options={weightOptions}
                        onChange={handleWeightChange}
                        className="w-full"
                        maxTagCount="responsive"
                        placeholder={t(
                          "pages.eventsArchive.filters.weightPlaceholder",
                          { defaultValue: "所有权重" },
                        )}
                      />
                    </div>
                    <Button
                      className="archive-toolbar__refresh-button"
                      onClick={() => refetchDigest()}
                      loading={digestLoading}
                    >
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </div>

                  <div className="archive-toolbar__search-stack">
                    <Input
                      allowClear
                      prefix={
                        <SearchOutlined className="text-slate-400 dark:text-slate-500" />
                      }
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      placeholder={t("pages.eventsArchive.searchPlaceholder", {
                        defaultValue: "搜索国家、事件、关键词...",
                      })}
                    />
                    <div className="archive-toolbar__feedback-slot">
                      {searchFeedback && searchFeedbackVisualState ? (
                        <div
                          className={`search-feedback-pill archive-toolbar__feedback search-feedback-pill--${searchFeedbackVisualState}`}
                          role="status"
                          aria-live="polite"
                        >
                          <span
                            className="search-feedback-pill__icon"
                            aria-hidden
                          >
                            {searchFeedbackVisualState === "loading" ||
                            searchFeedbackVisualState === "debouncing" ? (
                              <Spin size="small" />
                            ) : (
                              <SearchOutlined />
                            )}
                          </span>
                          <span className="search-feedback-pill__text">
                            {searchFeedback.message}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {digestError ? (
            <Alert
              type="error"
              showIcon
              message={
                searchMode
                  ? t("pages.eventsArchive.errors.searchFailedTitle", {
                      defaultValue: "智能搜索失败",
                    })
                  : t("pages.eventsArchive.errors.digestFailedTitle", {
                      defaultValue: "归档加载失败",
                    })
              }
              description={
                <div className="flex flex-col gap-1">
                  <span>{digestErrorDescription}</span>
                  {digestTraceId ? (
                    <Typography.Text type="secondary" className="text-xs">
                      {`Trace ID: ${digestTraceId}`}
                    </Typography.Text>
                  ) : null}
                </div>
              }
            />
          ) : null}

          {!digestError && preparationAlert ? (
            <Alert
              type={preparationAlert.type}
              showIcon
              message={preparationAlert.message}
              description={preparationAlert.description}
            />
          ) : null}

          {calendarQueryError ? (
            <Alert
              type="error"
              showIcon
              message={t("pages.eventsArchive.errors.calendarFailedTitle", {
                defaultValue: "日历加载失败",
              })}
              description={
                <div className="flex flex-col gap-1">
                  <span>
                    {t("pages.eventsArchive.errors.calendarFailed", {
                      defaultValue:
                        "日期标记与前进导航不可用，请稍后刷新重试。",
                    })}
                  </span>
                  {calendarTraceId ? (
                    <Typography.Text type="secondary" className="text-xs">
                      {`Trace ID: ${calendarTraceId}`}
                    </Typography.Text>
                  ) : null}
                </div>
              }
            />
          ) : null}

          {digestLoading && !digest ? (
            <div className="flex items-center justify-center py-12">
              <Spin />
            </div>
          ) : totalCount === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("pages.eventsArchive.empty", {
                defaultValue: "该日期暂无归档",
              })}
            >
              {debouncedSearch.trim().length > 0 ? (
                <Typography.Text type="secondary">
                  {t("pages.eventsArchive.emptySearchHint", {
                    defaultValue: "尝试使用更通用的关键词",
                  })}
                </Typography.Text>
              ) : null}
            </Empty>
          ) : (
            <div className="flex flex-col gap-5">
              {VERTICAL_SECTIONS.map((section) => (
                <section key={section.key} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-300/75 to-slate-200/40 dark:via-slate-600/75 dark:to-slate-700/30" />
                    <Typography.Text className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                      {sectionLabels[section.key as keyof typeof sectionLabels]}
                    </Typography.Text>
                    <span className="h-px flex-1 bg-gradient-to-l from-transparent via-slate-300/75 to-slate-200/40 dark:via-slate-600/75 dark:to-slate-700/30" />
                  </div>
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-5">
                    {section.verticals.map((vertical) => {
                      const group = groupMap.get(vertical);
                      const items = group?.items ?? [];
                      const title = verticalLabels[vertical];
                      const tone = resolveArchiveVerticalTone(vertical);
                      return (
                        <Card
                          key={vertical}
                          size="small"
                          styles={{
                            body: {
                              padding: 0,
                            },
                          }}
                          className="h-full overflow-hidden border border-slate-200/80 bg-white/72 shadow-[0_18px_38px_-28px_rgba(15,23,42,0.18)] transition-all duration-200 hover:border-slate-300/80 hover:shadow-[0_22px_44px_-28px_rgba(15,23,42,0.22)] dark:border-slate-800/80 dark:bg-slate-950/58 dark:hover:border-slate-700/80"
                        >
                          <div
                            className={`h-1.5 w-full bg-gradient-to-r ${tone.accentGlowClassName}`}
                          />
                          <div className="flex flex-col gap-4 p-4 sm:p-5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex items-start gap-3">
                                <span
                                  className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full shadow-sm ${tone.accentDotClassName}`}
                                />
                                <div className="min-w-0">
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone.titlePillClassName}`}
                                  >
                                    {title}
                                  </span>
                                </div>
                              </div>
                              <span className="inline-flex min-w-[2.25rem] items-center justify-center rounded-full border border-slate-300/80 bg-white/70 px-3 py-1 text-[11px] font-semibold text-slate-700 dark:border-slate-600/80 dark:bg-slate-950/70 dark:text-slate-200">
                                {group?.totalCount ?? 0}
                              </span>
                            </div>

                            {items.length === 0 ? (
                              <div className="rounded-2xl border border-dashed border-slate-300/80 bg-slate-50/80 px-4 py-6 text-center dark:border-slate-700/80 dark:bg-slate-900/65">
                                <Typography.Text type="secondary">
                                  {t("pages.eventsArchive.groupEmpty", {
                                    defaultValue: "暂无动态",
                                  })}
                                </Typography.Text>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-2.5">
                                {items.map((item) => {
                                  const { country, summary } =
                                    resolveArchiveItemPreview(item, {
                                      countryLabel: unknownCountryLabel,
                                      summary: untitledArchiveLabel,
                                    });
                                  const relevancePercent =
                                    resolveArchiveRelevancePercent(
                                      item.relevanceScore,
                                    );
                                  const matchOriginLabel =
                                    item.matchOrigin === "HYBRID"
                                      ? t(
                                          "pages.eventsArchive.matchOrigin.hybrid",
                                          {
                                            defaultValue: "混合",
                                          },
                                        )
                                      : item.matchOrigin === "SEMANTIC"
                                        ? t(
                                            "pages.eventsArchive.matchOrigin.semantic",
                                            {
                                              defaultValue: "语义",
                                            },
                                          )
                                        : item.matchOrigin === "LEXICAL"
                                          ? t(
                                              "pages.eventsArchive.matchOrigin.lexical",
                                              {
                                                defaultValue: "词法",
                                              },
                                            )
                                          : null;
                                  return (
                                    <div
                                      key={item.processedArticleId}
                                      className="group cursor-pointer rounded-2xl border border-slate-200/80 bg-white/78 p-3.5 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.18)] transition-all duration-200 hover:border-slate-300/80 hover:shadow-[0_16px_32px_-24px_rgba(15,23,42,0.24)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 dark:border-slate-800/80 dark:bg-slate-900/82 dark:hover:border-slate-700/80"
                                      role="button"
                                      tabIndex={0}
                                      aria-haspopup="dialog"
                                      aria-label={t(
                                        "pages.eventsArchive.detail.open",
                                        {
                                          defaultValue: "打开事件详情",
                                        },
                                      )}
                                      onClick={() =>
                                        openArchiveDetail(
                                          item.processedArticleId,
                                        )
                                      }
                                      onKeyDown={(event) => {
                                        if (
                                          event.key !== "Enter" &&
                                          event.key !== " "
                                        ) {
                                          return;
                                        }
                                        event.preventDefault();
                                        openArchiveDetail(
                                          item.processedArticleId,
                                        );
                                      }}
                                    >
                                      <div className="flex items-start gap-3">
                                        <span
                                          className={`mt-2 h-2 w-2 shrink-0 rounded-full ${tone.accentDotClassName}`}
                                        />
                                        <div className="min-w-0 flex-1">
                                          <Typography.Paragraph
                                            className="!mb-1.5 text-sm leading-6 text-slate-700 dark:text-slate-300"
                                            ellipsis={{
                                              rows: 2,
                                              expandable: false,
                                            }}
                                          >
                                            <span className="font-semibold text-slate-950 dark:text-slate-50">
                                              {renderHighlightedText(
                                                country,
                                                highlightTokens,
                                              )}
                                            </span>
                                            <span className="text-slate-400 dark:text-slate-500">
                                              ：
                                            </span>
                                            <span>
                                              {renderHighlightedText(
                                                summary,
                                                highlightTokens,
                                              )}
                                            </span>
                                          </Typography.Paragraph>
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span className="inline-flex rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200">
                                              {resolveArchiveWeightStars(
                                                item.weight,
                                              )}
                                            </span>
                                            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                              {dayjs(
                                                item.publishedAt ?? item.sortAt,
                                              ).format("YYYY/MM/DD")}
                                            </span>
                                            {item.matchOrigin &&
                                            matchOriginLabel ? (
                                              <span
                                                className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${MATCH_ORIGIN_BADGE_CLASS_NAME[item.matchOrigin]}`}
                                              >
                                                {matchOriginLabel}
                                              </span>
                                            ) : null}
                                            {relevancePercent !== null ? (
                                              <span className="inline-flex rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-400/15 dark:text-cyan-200">
                                                {t(
                                                  "pages.eventsArchive.relevanceTag",
                                                  {
                                                    defaultValue:
                                                      "相关度 {{percent}}%",
                                                    percent: relevancePercent,
                                                  },
                                                )}
                                              </span>
                                            ) : null}
                                            {item.sourceLabel ? (
                                              <span className="inline-flex rounded-full border border-slate-300/80 bg-slate-100/80 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700/80 dark:bg-slate-800/80 dark:text-slate-300">
                                                {item.sourceLabel}
                                              </span>
                                            ) : null}
                                          </div>
                                          {item.keywordHighlights.length > 0 ? (
                                            <div className="mt-2.5 flex flex-wrap gap-2">
                                              {item.keywordHighlights
                                                .slice(0, 4)
                                                .map((keyword) => (
                                                  <span
                                                    key={`${item.processedArticleId}-${keyword}`}
                                                    className="inline-flex rounded-full border border-slate-300/80 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-300"
                                                  >
                                                    {renderHighlightedText(
                                                      keyword,
                                                      highlightTokens,
                                                    )}
                                                  </span>
                                                ))}
                                            </div>
                                          ) : null}
                                        </div>
                                        <Button
                                          type="text"
                                          size="small"
                                          className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-transparent transition-colors ${tone.actionClassName}`}
                                          icon={<PlusOutlined />}
                                          aria-haspopup="dialog"
                                          aria-label={t(
                                            "pages.eventsArchive.detail.open",
                                            {
                                              defaultValue: "打开事件详情",
                                            },
                                          )}
                                          onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            openArchiveDetail(
                                              item.processedArticleId,
                                            );
                                          }}
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {group?.pageInfo.hasMore ? (
                              <Button
                                type="link"
                                className="!px-0 !text-slate-600 hover:!text-slate-900 dark:!text-slate-300 dark:hover:!text-white"
                                loading={Boolean(
                                  loadingMoreByVertical[vertical],
                                )}
                                onClick={() => handleLoadMore(vertical)}
                              >
                                {t("pages.eventsArchive.loadMore", {
                                  defaultValue: "加载更多",
                                })}
                              </Button>
                            ) : null}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Drawer
        title={t("pages.eventsArchive.detail.title", {
          defaultValue: "事件详情",
        })}
        placement="right"
        width={screens.lg ? 620 : "100%"}
        open={Boolean(selectedDetailId)}
        onClose={() => setSelectedDetailId(null)}
        destroyOnClose
        styles={{
          body: {
            paddingTop: 0,
          },
        }}
      >
        {detailLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spin />
          </div>
        ) : detailError ? (
          <Typography.Text type="danger">
            {t("pages.eventsArchive.detail.loadFailed", {
              defaultValue: "加载详情失败。",
            })}
            : {detailError.message}
          </Typography.Text>
        ) : !detail ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("pages.eventsArchive.detail.notFound", {
              defaultValue: "未找到详情。",
            })}
          />
        ) : (
          <div className="flex flex-col gap-4 pb-2">
            <section className="rounded-2xl border border-slate-200/80 bg-white/75 p-4 shadow-[0_18px_40px_-34px_rgba(15,23,42,0.5)] dark:border-slate-800/80 dark:bg-slate-950/60">
              <div className="flex flex-col gap-2">
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {detail.title || untitledArchiveLabel}
                </Typography.Title>
                {detail.summary ? (
                  <Typography.Paragraph className="!mb-0 text-sm leading-6 text-slate-700 dark:text-slate-300">
                    {detail.summary}
                  </Typography.Paragraph>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white/75 p-4 dark:border-slate-800/80 dark:bg-slate-950/60">
              <div className="flex flex-col gap-3">
                <Typography.Text className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t("pages.eventsArchive.detail.classification", {
                    defaultValue: "分类依据",
                  })}
                </Typography.Text>
                {!detailClassification ? (
                  <Typography.Text type="secondary">
                    {t("pages.eventsArchive.detail.classificationPending", {
                      defaultValue:
                        "分类准备中，后台完成归档后会显示判定依据。",
                    })}
                  </Typography.Text>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${resolveArchiveVerticalTone(detailClassification.vertical).titlePillClassName}`}
                      >
                        {verticalLabels[detailClassification.vertical]}
                      </span>
                      <span className="inline-flex rounded-full border border-slate-300/80 bg-slate-100/80 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-slate-700/80 dark:bg-slate-800/80 dark:text-slate-200">
                        {regionLabels[detailClassification.region] ??
                          detailClassification.region}
                      </span>
                      <span className="inline-flex rounded-full border border-slate-300/80 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-300">
                        {`taxonomy ${detailClassification.taxonomyVersion}`}
                      </span>
                      <span className="inline-flex rounded-full border border-slate-300/80 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-300">
                        {`pipeline ${detailClassification.pipelineVersion}`}
                      </span>
                      <span className="inline-flex rounded-full border border-amber-300/80 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        {t(detailClassification.decisionReasonI18nKey, {
                          defaultValue: detailClassification.decisionReason,
                        })}
                      </span>
                      {detailClassification.isStale ? (
                        <span className="inline-flex rounded-full border border-rose-300/80 bg-rose-50/80 px-2.5 py-1 text-[11px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                          {t("pages.eventsArchive.detail.classificationStale", {
                            defaultValue: "展示旧分类结果",
                          })}
                        </span>
                      ) : null}
                    </div>

                    {detailClassification.isStale ? (
                      <div className="rounded-xl border border-amber-200/80 bg-amber-50/80 p-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                        <Typography.Text className="block text-sm text-amber-800 dark:text-amber-100">
                          {t(
                            "pages.eventsArchive.detail.classificationStaleHint",
                            {
                              defaultValue:
                                "当前分类结果与现行模型或分类版本不一致，正在展示最近一次可用的归档判断。",
                            },
                          )}
                        </Typography.Text>
                        {visibleClassificationStaleReasons.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {visibleClassificationStaleReasons.map((reason) => (
                              <span
                                key={reason}
                                className="inline-flex rounded-full border border-amber-300/80 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:border-amber-400/30 dark:bg-slate-950/50 dark:text-amber-200"
                              >
                                {t(reason, { defaultValue: reason })}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-800/80 dark:bg-slate-900/70">
                        <Typography.Text className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                          {t("pages.eventsArchive.detail.embeddingModel", {
                            defaultValue: "Embedding model",
                          })}
                        </Typography.Text>
                        <Typography.Paragraph className="!mb-0 mt-1 break-all text-sm text-slate-700 dark:text-slate-200">
                          {detailClassification.embeddingModel}
                        </Typography.Paragraph>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-800/80 dark:bg-slate-900/70">
                        <Typography.Text className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                          {t("pages.eventsArchive.detail.rerankModel", {
                            defaultValue: "Rerank model",
                          })}
                        </Typography.Text>
                        <Typography.Paragraph className="!mb-0 mt-1 break-all text-sm text-slate-700 dark:text-slate-200">
                          {detailClassification.rerankModel}
                        </Typography.Paragraph>
                      </div>
                    </div>

                    {visibleClassificationSignals.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {visibleClassificationSignals.map((signal) => (
                          <span
                            key={signal}
                            className="inline-flex rounded-full border border-slate-300/80 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-300"
                          >
                            {signal}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="flex flex-col gap-2">
                      {detailClassification.scoreEntries.map((entry) => {
                        const fusedPercent =
                          resolveArchiveRelevancePercent(entry.fusedScore) ?? 0;
                        const tone = resolveArchiveVerticalTone(entry.vertical);
                        return (
                          <div
                            key={entry.vertical}
                            className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-800/80 dark:bg-slate-900/70"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span
                                className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${tone.titlePillClassName}`}
                              >
                                {verticalLabels[entry.vertical]}
                              </span>
                              <Typography.Text className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                {t("pages.eventsArchive.detail.fusedScore", {
                                  defaultValue: "融合 {{percent}}%",
                                  percent: fusedPercent,
                                })}
                              </Typography.Text>
                            </div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800/80">
                              <div
                                className={`h-full bg-gradient-to-r ${tone.accentGlowClassName}`}
                                style={{ width: `${fusedPercent}%` }}
                              />
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                              {[
                                {
                                  key: "rule",
                                  label: t(
                                    "pages.eventsArchive.detail.ruleScore",
                                    {
                                      defaultValue: "Rule",
                                    },
                                  ),
                                  value: entry.ruleScore,
                                },
                                {
                                  key: "embedding",
                                  label: t(
                                    "pages.eventsArchive.detail.embeddingScore",
                                    {
                                      defaultValue: "Embedding",
                                    },
                                  ),
                                  value: entry.embeddingScore,
                                },
                                {
                                  key: "rerank",
                                  label: t(
                                    "pages.eventsArchive.detail.rerankScore",
                                    {
                                      defaultValue: "Rerank",
                                    },
                                  ),
                                  value: entry.rerankScore,
                                },
                                {
                                  key: "fused",
                                  label: t("pages.eventsArchive.detail.fused", {
                                    defaultValue: "Fusion",
                                  }),
                                  value: entry.fusedScore,
                                },
                              ].map((metric) => (
                                <div
                                  key={`${entry.vertical}-${metric.key}`}
                                  className="rounded-lg border border-slate-200/80 bg-white/80 px-2.5 py-2 dark:border-slate-700/80 dark:bg-slate-950/70"
                                >
                                  <Typography.Text className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
                                    {metric.label}
                                  </Typography.Text>
                                  <Typography.Text className="text-sm font-medium text-slate-700 dark:text-slate-200">
                                    {`${resolveArchiveRelevancePercent(metric.value) ?? 0}%`}
                                  </Typography.Text>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white/75 p-4 dark:border-slate-800/80 dark:bg-slate-950/60">
              <div className="flex flex-col gap-3">
                <Typography.Text className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t("pages.eventsArchive.detail.entities", {
                    defaultValue: "涉及国家/实体",
                  })}
                </Typography.Text>
                {detail.fullEntities.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {detail.fullEntities.map((entity) => (
                      <span
                        key={entity}
                        className="inline-flex rounded-full border border-slate-300/80 bg-slate-100/80 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-slate-700/80 dark:bg-slate-800/80 dark:text-slate-200"
                      >
                        {entity}
                      </span>
                    ))}
                  </div>
                ) : (
                  <Typography.Text type="secondary">
                    {t("pages.eventsArchive.detail.entitiesEmpty", {
                      defaultValue: "暂无标签",
                    })}
                  </Typography.Text>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white/75 p-4 dark:border-slate-800/80 dark:bg-slate-950/60">
              <div className="flex flex-col gap-2">
                <Typography.Text className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t("pages.eventsArchive.detail.source", {
                    defaultValue: "来源",
                  })}
                </Typography.Text>
                <Typography.Text className="text-sm text-slate-700 dark:text-slate-200">
                  {detail.sourceLabel ||
                    t("pages.eventsArchive.detail.sourceUnknown", {
                      defaultValue: "未知来源",
                    })}
                </Typography.Text>
                {safeHttpUrl(detail.sourceUrl) ? (
                  <a
                    href={safeHttpUrl(detail.sourceUrl) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-sky-700 transition-colors hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                  >
                    {t("pages.eventsArchive.detail.openOriginal", {
                      defaultValue: "打开原文链接",
                    })}
                  </a>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white/75 p-4 dark:border-slate-800/80 dark:bg-slate-950/60">
              <div className="flex flex-col gap-3">
                <Typography.Text className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t("pages.eventsArchive.detail.timeline", {
                    defaultValue: "时间线",
                  })}
                </Typography.Text>
                {detail.timeline.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t("pages.eventsArchive.detail.timelineEmpty", {
                      defaultValue: "暂无关联时间线",
                    })}
                  </Typography.Text>
                ) : (
                  <div className="flex flex-col gap-3">
                    {detail.timeline.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-800/80 dark:bg-slate-900/70"
                      >
                        <Typography.Text className="text-xs font-medium text-slate-500 dark:text-slate-400">
                          {dayjs(entry.bucketStart).format("YYYY/MM/DD")}
                        </Typography.Text>
                        {entry.title ? (
                          <Typography.Paragraph className="!mb-0 mt-1 font-medium text-slate-900 dark:text-slate-100">
                            {entry.title}
                          </Typography.Paragraph>
                        ) : null}
                        {entry.summary ? (
                          <Typography.Paragraph className="!mb-0 mt-1 text-sm text-slate-600 dark:text-slate-300">
                            {entry.summary}
                          </Typography.Paragraph>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white/75 p-4 dark:border-slate-800/80 dark:bg-slate-950/60">
              <div className="flex flex-col gap-3">
                <Typography.Text className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t("pages.eventsArchive.detail.related", {
                    defaultValue: "关联原文",
                  })}
                </Typography.Text>
                {detail.relatedArticles.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t("pages.eventsArchive.detail.relatedEmpty", {
                      defaultValue: "暂无关联原文",
                    })}
                  </Typography.Text>
                ) : (
                  <div className="flex flex-col gap-3">
                    {detail.relatedArticles.map((article) => (
                      <div
                        key={article.processedArticleId}
                        className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-800/80 dark:bg-slate-900/70"
                      >
                        <Typography.Text
                          strong
                          className="block text-slate-900 dark:text-slate-100"
                        >
                          {article.title || untitledArchiveLabel}
                        </Typography.Text>
                        {article.summary ? (
                          <Typography.Paragraph className="!mb-1 mt-1 text-sm text-slate-600 dark:text-slate-300">
                            {article.summary}
                          </Typography.Paragraph>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {article.sourceLabel ? (
                            <span className="inline-flex rounded-full border border-slate-300/80 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-300">
                              {article.sourceLabel}
                            </span>
                          ) : null}
                          {article.publishedAt ? (
                            <Typography.Text className="text-xs font-medium text-slate-500 dark:text-slate-400">
                              {dayjs(article.publishedAt).format(
                                "YYYY/MM/DD HH:mm",
                              )}
                            </Typography.Text>
                          ) : null}
                          {safeHttpUrl(article.sourceUrl) ? (
                            <a
                              href={safeHttpUrl(article.sourceUrl) ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm font-medium text-sky-700 transition-colors hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                            >
                              {t("pages.eventsArchive.detail.openOriginal", {
                                defaultValue: "打开原文链接",
                              })}
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </Drawer>
    </div>
  );
}

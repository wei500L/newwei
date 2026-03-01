"use client";

import { LeftOutlined, PlusOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
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
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { safeHttpUrl } from "@/lib/url";
import { useDebounceValue } from "@/lib/use-debounce-value";
import {
  buildCalendarCountMap,
  canNavigateToNextDay,
  formatSelectedDateParam,
  parseDateParamUtc,
  toAnchorIso,
} from "./events-archive-helpers";

type ArchiveRegion =
  | "APAC"
  | "MIDDLE_EAST"
  | "AMERICAS"
  | "EUROPE"
  | "AFRICA"
  | "OTHER";
type ArchiveVertical =
  | "EAST_SEA"
  | "SOUTH_SEA"
  | "WEST_FRONT"
  | "FOREIGN_AFFAIRS"
  | "DOMESTIC_AFFAIRS";
type ArchiveWeight = "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";

interface ArchiveEventItem {
  processedArticleId: string;
  eventId?: string | null;
  title?: string | null;
  summary?: string | null;
  countryLabel?: string | null;
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  weight: number;
  qualityScore?: number | null;
  publishedAt?: string | null;
  sortAt: string;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  entityTags: string[];
  keywordHighlights: string[];
}

interface ArchiveVerticalGroup {
  vertical: ArchiveVertical;
  displayName: string;
  totalCount: number;
  items: ArchiveEventItem[];
}

interface ArchiveDigestData {
  anchorDate: string;
  region: ArchiveRegion;
  totalCount: number;
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
      groups {
        vertical
        displayName
        totalCount
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

const REGION_OPTIONS: ArchiveRegion[] = [
  "APAC",
  "MIDDLE_EAST",
  "AMERICAS",
  "EUROPE",
  "AFRICA",
  "OTHER",
];

const VERTICAL_SECTIONS: Array<{
  key: string;
  verticals: ArchiveVertical[];
}> = [
  {
    key: "geo",
    verticals: ["EAST_SEA", "SOUTH_SEA", "WEST_FRONT"],
  },
  {
    key: "macro",
    verticals: ["FOREIGN_AFFAIRS", "DOMESTIC_AFFAIRS"],
  },
];

const VERTICAL_FALLBACK_LABEL: Record<ArchiveVertical, string> = {
  EAST_SEA: "【东海】",
  SOUTH_SEA: "【南海】",
  WEST_FRONT: "【西面】",
  FOREIGN_AFFAIRS: "【外务】",
  DOMESTIC_AFFAIRS: "【内务】",
};

const WEIGHT_OPTIONS = [5, 4, 3, 2, 1] as const;
const WEIGHT_LABEL_KEY: Record<number, "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE"> =
  {
    1: "ONE",
    2: "TWO",
    3: "THREE",
    4: "FOUR",
    5: "FIVE",
  };

const DEFAULT_REGION: ArchiveRegion = "APAC";
const DEFAULT_WEIGHTS = [5, 4, 3, 2, 1];
const SEARCH_DEBOUNCE_MS = 300;
const INITIAL_VISIBLE_ITEMS = 6;

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
    return DEFAULT_WEIGHTS;
  }
  const parsed = value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= 5);
  if (parsed.length === 0) {
    return DEFAULT_WEIGHTS;
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
            <mark key={key} className="bg-amber-200 px-0.5 rounded-sm">
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
  const [expandedByVertical, setExpandedByVertical] = useState<
    Record<ArchiveVertical, boolean>
  >({
    EAST_SEA: false,
    SOUTH_SEA: false,
    WEST_FRONT: false,
    FOREIGN_AFFAIRS: false,
    DOMESTIC_AFFAIRS: false,
  });
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);

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

  const archiveInput = useMemo(
    () => ({
      anchorDate: toAnchorIso(currentDate),
      region: currentRegion,
      ...(debouncedSearch.trim().length > 0
        ? { search: debouncedSearch.trim() }
        : {}),
      weights: selectedWeightEnums,
      limitPerVertical: 60,
    }),
    [currentDate, currentRegion, debouncedSearch, selectedWeightEnums],
  );

  const {
    data: digestData,
    loading: digestLoading,
    error: digestError,
    refetch: refetchDigest,
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
  const nextMonthParam = useMemo(() => nextDateParam.slice(0, 7), [nextDateParam]);
  const needsNextMonthCalendar = nextMonthParam !== monthParam;
  const { data: nextMonthCalendarData, error: nextMonthCalendarError } = useQuery<{
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
  const groupMap = useMemo(
    () =>
      new Map((digest?.groups ?? []).map((group) => [group.vertical, group])),
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
  const canGoNext = useMemo(
    () =>
      canNavigateToNextDay({
        nextDateParam,
        currentMonthParam: monthParam,
        currentMonthCountByDate: calendarCountByDate,
        nextMonthCountByDate: needsNextMonthCalendar
          ? nextMonthCountByDate
          : undefined,
      }),
    [
      calendarCountByDate,
      monthParam,
      needsNextMonthCalendar,
      nextDateParam,
      nextMonthCountByDate,
    ],
  );

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
  const searchMode = debouncedSearch.trim().length > 0;
  const normalizedSearchInput = searchInput.trim();
  const normalizedDebouncedSearch = debouncedSearch.trim();
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
      search: debouncedSearch.trim(),
      message: digestError.message,
    });
  }, [
    currentDate,
    currentRegion,
    debouncedSearch,
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
    searchMode,
    t,
    totalCount,
  ]);
  const searchFeedbackVisualState = useMemo(() => {
    if (!searchFeedback) {
      return null;
    }
    if (searchFeedback.tone === "pending") {
      return "debouncing";
    }
    return searchFeedback.tone;
  }, [searchFeedback]);

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
      weights: normalized.length > 0 ? normalized : DEFAULT_WEIGHTS,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.eventsArchive.title", { defaultValue: "历史档案日报" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.eventsArchive.subtitle", {
            defaultValue: "按日期回溯已处理新闻情报，并按预设领域编年归档。",
          })}
        </Typography.Text>
      </Space>

      <Card className="content-card">
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <div className="inline-flex min-w-full border-b border-slate-200">
              {regionOptions.map((region) => {
                const active = region.value === currentRegion;
                return (
                  <button
                    key={region.value}
                    type="button"
                    className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                      active
                        ? "border-amber-500 text-amber-700 font-semibold"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}
                    onClick={() => updateUrl({ region: region.value })}
                  >
                    {region.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col xl:flex-row xl:items-center gap-3 justify-between">
            <Space wrap size="small">
              <Space size={8}>
                <Button
                  icon={<LeftOutlined />}
                  onClick={() => updateUrl({ date: prevDateParam })}
                />
                <DatePicker
                  allowClear={false}
                  value={selectedDate}
                  format="YYYY/M/D"
                  onChange={handleDateSelect}
                  disabledDate={(value) => value.utc().isAfter(dayjs.utc(), "day")}
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
                        <span className="absolute left-1/2 -translate-x-1/2 bottom-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                      </div>
                    );
                  }}
                />
                <Button
                  icon={<RightOutlined />}
                  onClick={() => updateUrl({ date: nextDateParam })}
                  disabled={!canGoNext}
                />
              </Space>
              <Typography.Text type="secondary">
                {t("pages.eventsArchive.dailyCount", {
                  defaultValue: "本日 {{count}} 条动态",
                  count: totalCount,
                })}
              </Typography.Text>
            </Space>

            <Space wrap size="small">
              <Select
                mode="multiple"
                size="small"
                value={currentWeights}
                options={weightOptions}
                onChange={handleWeightChange}
                style={{ minWidth: 220 }}
                maxTagCount="responsive"
                placeholder={t(
                  "pages.eventsArchive.filters.weightPlaceholder",
                  { defaultValue: "所有权重" },
                )}
              />
              <div
                className="flex flex-col gap-1"
                style={{ width: screens.md ? 300 : "100%" }}
              >
                <Input
                  allowClear
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder={t("pages.eventsArchive.searchPlaceholder", {
                    defaultValue: "搜索国家、事件、关键词...",
                  })}
                />
                {searchFeedback && searchFeedbackVisualState ? (
                  <div
                    className={`search-feedback-pill search-feedback-pill--${searchFeedbackVisualState}`}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="search-feedback-pill__icon" aria-hidden>
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
              <Button onClick={() => refetchDigest()} loading={digestLoading}>
                {t("common.refresh", { defaultValue: "Refresh" })}
              </Button>
            </Space>
          </div>

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
                <div key={section.key} className="flex flex-col gap-3">
                  <Typography.Text strong className="text-slate-700">
                    {sectionLabels[section.key as keyof typeof sectionLabels]}
                  </Typography.Text>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {section.verticals.map((vertical) => {
                      const group = groupMap.get(vertical);
                      const items = group?.items ?? [];
                      const expanded = expandedByVertical[vertical] ?? false;
                      const visibleItems = expanded
                        ? items
                        : items.slice(0, INITIAL_VISIBLE_ITEMS);
                      const title = verticalLabels[vertical];
                      return (
                        <Card
                          key={vertical}
                          styles={{
                            body: {
                              backgroundColor: "#f8f1dc",
                              borderRadius: 12,
                            },
                          }}
                          className="shadow-sm hover:shadow-md transition-all duration-200"
                        >
                          <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                              <Typography.Text strong>{title}</Typography.Text>
                              <Tag>{group?.totalCount ?? 0}</Tag>
                            </div>

                            {visibleItems.length === 0 ? (
                              <Typography.Text type="secondary">
                                {t("pages.eventsArchive.groupEmpty", {
                                  defaultValue: "暂无动态",
                                })}
                              </Typography.Text>
                            ) : (
                              <div className="flex flex-col gap-2">
                                {visibleItems.map((item) => {
                                  const country =
                                    item.countryLabel?.trim() ||
                                    t("pages.eventsArchive.unknownCountry", {
                                      defaultValue: "未知",
                                    });
                                  const summary =
                                    item.summary?.trim() ||
                                    item.title?.trim() ||
                                    "";
                                  return (
                                    <div
                                      key={item.processedArticleId}
                                      className="flex items-start gap-2"
                                    >
                                      <span className="text-slate-500 mt-1">
                                        ●
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <Typography.Paragraph
                                          className="!mb-1 text-sm leading-6"
                                          ellipsis={{
                                            rows: 2,
                                            expandable: false,
                                          }}
                                        >
                                          <span className="font-semibold">
                                            {renderHighlightedText(
                                              country,
                                              highlightTokens,
                                            )}
                                          </span>
                                          <span>：</span>
                                          <span>
                                            {renderHighlightedText(
                                              summary,
                                              highlightTokens,
                                            )}
                                          </span>
                                        </Typography.Paragraph>
                                        <Space size={6} wrap>
                                          <Tag color="gold">
                                            {`★`.repeat(
                                              Math.max(
                                                1,
                                                Math.min(item.weight, 5),
                                              ),
                                            )}
                                          </Tag>
                                          <Typography.Text
                                            type="secondary"
                                            className="text-xs"
                                          >
                                            {dayjs(
                                              item.publishedAt ?? item.sortAt,
                                            ).format("YYYY/MM/DD")}
                                          </Typography.Text>
                                        </Space>
                                      </div>
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<PlusOutlined />}
                                        style={{ color: "#dc2626" }}
                                        onClick={() =>
                                          setSelectedDetailId(
                                            item.processedArticleId,
                                          )
                                        }
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {items.length > INITIAL_VISIBLE_ITEMS ? (
                              <Button
                                type="link"
                                className="!px-0 self-start"
                                onClick={() =>
                                  setExpandedByVertical((current) => ({
                                    ...current,
                                    [vertical]: !current[vertical],
                                  }))
                                }
                              >
                                {expanded
                                  ? t("pages.eventsArchive.collapse", {
                                      defaultValue: "收起",
                                    })
                                  : t("pages.eventsArchive.expand", {
                                      defaultValue: "展开更多",
                                    })}
                              </Button>
                            ) : null}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
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
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Typography.Title level={5} style={{ margin: 0 }}>
                {detail.title ||
                  t("pages.eventsArchive.detail.untitled", {
                    defaultValue: "未命名事件",
                  })}
              </Typography.Title>
              {detail.summary ? (
                <Typography.Paragraph className="!mb-0">
                  {detail.summary}
                </Typography.Paragraph>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Typography.Text strong>
                {t("pages.eventsArchive.detail.entities", {
                  defaultValue: "涉及国家/实体",
                })}
              </Typography.Text>
              {detail.fullEntities.length > 0 ? (
                <Space wrap>
                  {detail.fullEntities.map((entity) => (
                    <Tag key={entity}>{entity}</Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {t("pages.eventsArchive.detail.entitiesEmpty", {
                    defaultValue: "暂无标签",
                  })}
                </Typography.Text>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Typography.Text strong>
                {t("pages.eventsArchive.detail.source", {
                  defaultValue: "来源",
                })}
              </Typography.Text>
              <Typography.Text type="secondary">
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
                  className="text-sky-600"
                >
                  {t("pages.eventsArchive.detail.openOriginal", {
                    defaultValue: "打开原文链接",
                  })}
                </a>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Typography.Text strong>
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
                <div className="flex flex-col gap-2">
                  {detail.timeline.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-md border border-slate-200 p-2"
                    >
                      <Typography.Text type="secondary" className="text-xs">
                        {dayjs(entry.bucketStart).format("YYYY/MM/DD")}
                      </Typography.Text>
                      {entry.title ? (
                        <Typography.Paragraph className="!mb-0">
                          {entry.title}
                        </Typography.Paragraph>
                      ) : null}
                      {entry.summary ? (
                        <Typography.Paragraph className="!mb-0 text-sm text-slate-600">
                          {entry.summary}
                        </Typography.Paragraph>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Typography.Text strong>
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
                <div className="flex flex-col gap-2">
                  {detail.relatedArticles.map((article) => (
                    <div
                      key={article.processedArticleId}
                      className="rounded-md border border-slate-200 p-2"
                    >
                      <Typography.Text strong className="block">
                        {article.title ||
                          t("pages.eventsArchive.detail.untitled", {
                            defaultValue: "未命名事件",
                          })}
                      </Typography.Text>
                      {article.summary ? (
                        <Typography.Paragraph className="!mb-1 text-sm text-slate-600">
                          {article.summary}
                        </Typography.Paragraph>
                      ) : null}
                      <Space size={8} wrap>
                        {article.sourceLabel ? (
                          <Tag>{article.sourceLabel}</Tag>
                        ) : null}
                        {article.publishedAt ? (
                          <Typography.Text type="secondary" className="text-xs">
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
                            className="text-sky-600 text-sm"
                          >
                            {t("pages.eventsArchive.detail.openOriginal", {
                              defaultValue: "打开原文链接",
                            })}
                          </a>
                        ) : null}
                      </Space>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

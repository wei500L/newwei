"use client";

import { gql, useQuery } from "@apollo/client";
import { Alert, Button, Card, Empty, Radio, Select, Skeleton, Space, Switch, Typography } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import {
  buildRssReaderPreferencesFingerprint,
  buildRssReaderPreferencesStorageKey,
  filterRssSourcesByLanguages,
  normalizeRssReaderPreferences,
  resolveRssReaderPersistedPayload,
  resolveRssSourceLanguageOptions,
  resolveRssSourceSelectionOptions,
  resolveRssSourceSelectionUiState,
  resolveTopRssSourceIds
} from "@/lib/rss-reader-ui";
import type { NormalizedRssReaderPreferences } from "@/lib/rss-reader-ui";
import type { FilterState } from "@/app/(app)/items/components/faceted-search";
import {
  isChineseTargetLanguage,
  RSS_TRANSLATION_STATUS_QUERY,
  RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  type RssTranslationProvider,
  type RssTranslationStatusQuery,
  type RssTranslationStatusQueryVariables
} from "@/lib/rss-translation";

import { ItemsView } from "../items/items-view";
import { RSS_ITEMS_VIEW_PRESET } from "./rss-reader-preset";

const DEFAULT_WINDOW_DAYS = 7;
const TOP_RSS_SOURCES_SHORTCUT_COUNT = 20;
const DEFAULT_TARGET_LANGUAGE = "zh-CN";
const RSS_READER_UI_SETTINGS_PATH = "user-settings/ui/rss-reader";
const SAVE_DEBOUNCE_MS = 900;

interface RemoteRssReaderUiSettingsResponse {
  version: number;
  updatedAt?: {
    settings?: string;
  };
  settings: Record<string, unknown> | null;
}

function readJsonFromStorage(key: string): unknown | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeJsonToStorage(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / serialization failures
  }
}

interface RssSourceOption {
  id: string;
  name: string;
  language?: string | null;
  siteUrl: string;
  feedUrl: string;
  latestItemAt?: string | null;
  itemCountWindow: number;
}

interface RssSourcesQuery {
  rssSources: RssSourceOption[];
}

interface RssSourcesQueryVariables {
  windowDays?: number;
  onlyWithItems?: boolean;
}

const RSS_SOURCES_QUERY = gql`
  query RssSources($windowDays: Int, $onlyWithItems: Boolean) {
    rssSources(windowDays: $windowDays, onlyWithItems: $onlyWithItems) {
      id
      name
      language
      siteUrl
      feedUrl
      latestItemAt
      itemCountWindow
    }
  }
`;

export function RssContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken]
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [hasExplicitSourceSelection, setHasExplicitSourceSelection] = useState(false);
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);
  const [persistedSelectedSourceIds, setPersistedSelectedSourceIds] = useState<string[] | null>(null);
  const [sourceLanguageFilters, setSourceLanguageFilters] = useState<string[]>([]);
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationProvider, setTranslationProvider] = useState<RssTranslationProvider>("deeplx");
  const [targetLanguage, setTargetLanguage] = useState(DEFAULT_TARGET_LANGUAGE);
  const [showOriginalContent, setShowOriginalContent] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedFingerprintRef = useRef<string | null>(null);
  const initialFilters = useMemo<FilterState>(
    () => ({
      dateRange: [dayjs().subtract(DEFAULT_WINDOW_DAYS - 1, "day").startOf("day"), dayjs().endOf("day")]
    }),
    []
  );

  const { data, loading, error } = useQuery<RssSourcesQuery, RssSourcesQueryVariables>(
    RSS_SOURCES_QUERY,
    {
      variables: {
        windowDays: DEFAULT_WINDOW_DAYS,
        onlyWithItems: true
      },
      fetchPolicy: "cache-and-network"
    }
  );

  const sources = useMemo(() => data?.rssSources ?? [], [data?.rssSources]);
  const sortedSources = useMemo(
    () => resolveRssSourceSelectionOptions(sources),
    [sources]
  );
  const sourceLanguageOptions = useMemo(
    () => resolveRssSourceLanguageOptions(sortedSources),
    [sortedSources]
  );
  const availableSourceIds = useMemo(
    () => sortedSources.map((source) => source.id),
    [sortedSources]
  );
  const availableSourceLanguages = useMemo(
    () => sourceLanguageOptions.map((option) => option.value),
    [sourceLanguageOptions]
  );
  const sourceIdsForNormalization =
    availableSourceIds.length > 0 ? availableSourceIds : undefined;
  const sourceLanguagesForNormalization =
    availableSourceLanguages.length > 0 ? availableSourceLanguages : undefined;
  const storageKey = useMemo(
    () =>
      status === "loading"
        ? null
        : buildRssReaderPreferencesStorageKey(session?.orgId, session?.user?.id),
    [session?.orgId, session?.user?.id, status]
  );
  const sourceUiState = useMemo(
    () =>
      resolveRssSourceSelectionUiState({
        loading,
        hasData: Boolean(data),
        hasError: Boolean(error),
        sourcesCount: sources.length,
        selectionInitialized,
        selectedSourceCount: selectedSourceIds.length
      }),
    [data, error, loading, selectedSourceIds.length, selectionInitialized, sources.length]
  );
  const displayedSelectedSourceIds = useMemo(
    () =>
      sourceUiState.selectionReady
        ? selectedSourceIds
        : sources.map((source) => source.id),
    [selectedSourceIds, sourceUiState.selectionReady, sources]
  );
  const showItemsLoadingSkeleton =
    sourceUiState.showLoading || !preferencesHydrated || (sources.length > 0 && !sourceUiState.selectionReady);
  const showSourceControls =
    preferencesHydrated && !sourceUiState.showLoading && sources.length > 0;

  const { data: translationStatusData } = useQuery<
    RssTranslationStatusQuery,
    RssTranslationStatusQueryVariables
  >(RSS_TRANSLATION_STATUS_QUERY, {
    variables: { targetLanguage },
    fetchPolicy: "cache-and-network"
  });

  const providerStatuses = translationStatusData?.rssTranslationStatus ?? [];
  const selectedProviderStatus = providerStatuses.find(
    (status) => status.provider === translationProvider
  );
  const translationReady = Boolean(
    translationEnabled &&
      selectedProviderStatus?.available &&
      selectedProviderStatus?.targetLanguageSupported
  );

  useEffect(() => {
    if (translationProvider === "deeplx" && !isChineseTargetLanguage(targetLanguage)) {
      setTargetLanguage(DEFAULT_TARGET_LANGUAGE);
    }
  }, [targetLanguage, translationProvider]);

  useEffect(() => {
    if (!storageKey || status === "loading") {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const localFallback = normalizeRssReaderPreferences({
      value: readJsonFromStorage(storageKey),
      availableSourceIds: sourceIdsForNormalization,
      availableSourceLanguages: sourceLanguagesForNormalization,
      defaultTargetLanguage: DEFAULT_TARGET_LANGUAGE,
      defaultProvider: "deeplx"
    });

    const applyRestoredPreferences = (restored: NormalizedRssReaderPreferences) => {
      setPersistedSelectedSourceIds(restored.selectedSourceIds);
      setHasExplicitSourceSelection(restored.selectedSourceIds !== null);
      setSourceLanguageFilters(restored.sourceLanguageFilters);
      setTranslationEnabled(restored.translationEnabled);
      setTranslationProvider(restored.translationProvider);
      setTargetLanguage(restored.targetLanguage);
      setShowOriginalContent(restored.showOriginalContent);
      lastSavedFingerprintRef.current = buildRssReaderPreferencesFingerprint(
        resolveRssReaderPersistedPayload(restored)
      );
      setPreferencesHydrated(true);
    };

    if (status !== "authenticated" || !accessToken) {
      applyRestoredPreferences(localFallback);
      return;
    }

    let cancelled = false;

    apiClient
      .get<RemoteRssReaderUiSettingsResponse>(RSS_READER_UI_SETTINGS_PATH)
      .then((response) => {
        if (cancelled) {
          return;
        }

        const remoteSettings = normalizeRssReaderPreferences({
          value: response.data?.settings,
          availableSourceIds: sourceIdsForNormalization,
          availableSourceLanguages: sourceLanguagesForNormalization,
          defaultTargetLanguage: DEFAULT_TARGET_LANGUAGE,
          defaultProvider: "deeplx"
        });
        writeJsonToStorage(
          storageKey,
          resolveRssReaderPersistedPayload(remoteSettings)
        );
        applyRestoredPreferences(remoteSettings);
      })
      .catch((syncError) => {
        if (cancelled) {
          return;
        }
        captureClientError("Failed to load RSS reader UI settings", syncError);
        applyRestoredPreferences(localFallback);
      });

    return () => {
      cancelled = true;
    };
  }, [
    accessToken,
    apiClient,
    sourceIdsForNormalization,
    sourceLanguagesForNormalization,
    status,
    storageKey
  ]);

  useEffect(() => {
    if (!preferencesHydrated) {
      return;
    }
    if (sources.length === 0) {
      setSelectedSourceIds([]);
      setSelectionInitialized(false);
      return;
    }

    const sourceIdSet = new Set(sources.map((source) => source.id));
    const restoredSourceIds =
      persistedSelectedSourceIds === null
        ? null
        : persistedSelectedSourceIds.filter((id) => sourceIdSet.has(id));

    setSelectedSourceIds((prev) => {
      if (!selectionInitialized) {
        return restoredSourceIds ?? sources.map((source) => source.id);
      }
      return prev.filter((id) => sourceIdSet.has(id));
    });
    if (!selectionInitialized) {
      setSelectionInitialized(true);
    }
  }, [persistedSelectedSourceIds, preferencesHydrated, selectionInitialized, sources]);

  useEffect(() => {
    if (!preferencesHydrated || !storageKey || !selectionInitialized) {
      return;
    }

    const payload = resolveRssReaderPersistedPayload({
      selectedSourceIds: hasExplicitSourceSelection ? selectedSourceIds : null,
      sourceLanguageFilters,
      translationEnabled,
      translationProvider,
      targetLanguage,
      showOriginalContent
    });
    const nextFingerprint = buildRssReaderPreferencesFingerprint(payload);

    writeJsonToStorage(storageKey, payload);

    if (nextFingerprint === lastSavedFingerprintRef.current) {
      return;
    }

    if (status !== "authenticated" || !accessToken) {
      lastSavedFingerprintRef.current = nextFingerprint;
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      apiClient
        .put(RSS_READER_UI_SETTINGS_PATH, { settings: payload })
        .then(() => {
          lastSavedFingerprintRef.current = nextFingerprint;
        })
        .catch((syncError) => {
          captureClientError("Failed to save RSS reader UI settings", syncError);
        });
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    accessToken,
    apiClient,
    hasExplicitSourceSelection,
    preferencesHydrated,
    selectedSourceIds,
    selectionInitialized,
    showOriginalContent,
    sourceLanguageFilters,
    status,
    storageKey,
    targetLanguage,
    translationEnabled,
    translationProvider
  ]);
  const visibleSources = useMemo(
    () => filterRssSourcesByLanguages(sortedSources, sourceLanguageFilters),
    [sortedSources, sourceLanguageFilters]
  );
  const topSourceIds = useMemo(
    () => resolveTopRssSourceIds(visibleSources, TOP_RSS_SOURCES_SHORTCUT_COUNT),
    [visibleSources]
  );
  const visibleSourceIdSet = useMemo(
    () => new Set(visibleSources.map((source) => source.id)),
    [visibleSources]
  );
  const displayedSelectedSourceIdSet = useMemo(
    () => new Set(displayedSelectedSourceIds),
    [displayedSelectedSourceIds]
  );
  const visibleSelectedSourceIds = useMemo(
    () => displayedSelectedSourceIds.filter((id) => visibleSourceIdSet.has(id)),
    [displayedSelectedSourceIds, visibleSourceIdSet]
  );
  const hiddenSelectedSourceIds = useMemo(
    () => displayedSelectedSourceIds.filter((id) => !visibleSourceIdSet.has(id)),
    [displayedSelectedSourceIds, visibleSourceIdSet]
  );
  const hasAllSourcesSelected =
    visibleSources.length > 0 && visibleSources.every((source) => displayedSelectedSourceIdSet.has(source.id));
  const hasTopSourcesSelected =
    topSourceIds.length > 0 &&
    topSourceIds.every((id) => displayedSelectedSourceIdSet.has(id));
  const selectOptions = useMemo(
    () =>
      visibleSources.map((source) => ({
        value: source.id,
        searchText: source.searchText,
        label: (
          <div className="flex min-w-0 flex-col py-0.5">
            <span className="truncate font-medium">{source.name}</span>
            <span className="truncate text-xs text-gray-500 dark:text-gray-400">
              {[
                source.language,
                source.siteHostname ?? source.feedHostname,
                t("pages.rss.activityCount", {
                  count: source.itemCountWindow,
                  defaultValue: "{{count}} recent items"
                }),
                source.latestItemAt
                  ? t("pages.rss.latestSourceItem", {
                      defaultValue: "Latest {{time}}",
                      time: dayjs(source.latestItemAt).format("MM-DD HH:mm")
                    })
                  : null
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        )
      })),
    [t, visibleSources]
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card className="content-card">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 8 }}>
              {t("pages.rss.title", { defaultValue: "RSS Reader" })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("pages.rss.subtitle", {
                defaultValue: "Read processed articles from RSS sources in a focused stream."
              })}
            </Typography.Text>
            <br />
            <Typography.Text type="secondary">
              {t("pages.rss.readerHint", {
                defaultValue: "Optimized for focused scanning with layered filters."
              })}
            </Typography.Text>
          </div>

          {error ? (
            <Alert
              type="error"
              showIcon
              message={t("pages.rss.loadFailed", { defaultValue: "Failed to load RSS sources." })}
              description={error.message}
            />
          ) : null}

          {sourceUiState.showLoading || !preferencesHydrated ? (
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <Typography.Text strong>
                {t("pages.rss.sourceLabel", { defaultValue: "RSS Sources" })}
              </Typography.Text>
              <Skeleton.Input active block style={{ width: "100%", height: 32 }} />
              <Skeleton.Input active size="small" style={{ width: 180 }} />
            </Space>
          ) : null}

          {sourceUiState.showEmpty ? (
            <Empty description={t("pages.rss.emptySources", { defaultValue: "No RSS sources with recent items were found." })} />
          ) : null}

          {showSourceControls ? (
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <Typography.Text strong>
                {t("pages.rss.sourceLabel", { defaultValue: "RSS Sources" })}
              </Typography.Text>
              <Space wrap>
                <Select
                  mode="multiple"
                  allowClear
                  size="small"
                  style={{ minWidth: 220 }}
                  placeholder={t("pages.rss.languageFilterPlaceholder", {
                    defaultValue: "All languages"
                  })}
                  value={sourceLanguageFilters}
                  options={sourceLanguageOptions.map((option) => ({
                    value: option.value,
                    label: `${option.value} (${option.count})`
                  }))}
                  onChange={(next) => setSourceLanguageFilters(next)}
                  maxTagCount="responsive"
                />
                {sourceLanguageFilters.length > 0 ? (
                  <Button size="small" onClick={() => setSourceLanguageFilters([])}>
                    {t("pages.rss.clearLanguageFilter", {
                      defaultValue: "All languages"
                    })}
                  </Button>
                ) : null}
              </Space>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setHasExplicitSourceSelection(true);
                    setSelectedSourceIds(visibleSources.map((source) => source.id));
                  }}
                  disabled={hasAllSourcesSelected}
                >
                  {t(
                    sourceLanguageFilters.length > 0
                      ? "pages.rss.selectVisibleSources"
                      : "pages.rss.selectAllSources",
                    {
                      defaultValue:
                        sourceLanguageFilters.length > 0 ? "Select visible" : "Select all"
                    }
                  )}
                </Button>
                {visibleSources.length > TOP_RSS_SOURCES_SHORTCUT_COUNT ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setHasExplicitSourceSelection(true);
                      setSelectedSourceIds(topSourceIds);
                    }}
                    disabled={hasTopSourcesSelected}
                  >
                    {t("pages.rss.selectTopSources", {
                      count: TOP_RSS_SOURCES_SHORTCUT_COUNT,
                      defaultValue: "Top {{count}}"
                    })}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  onClick={() => {
                    setHasExplicitSourceSelection(true);
                    setSelectedSourceIds([]);
                  }}
                  disabled={displayedSelectedSourceIds.length === 0}
                >
                  {t("pages.rss.clearSources", { defaultValue: "Clear all" })}
                </Button>
              </Space>
              <Select
                mode="multiple"
                allowClear
                showSearch
                style={{ width: "100%" }}
                placeholder={t("pages.rss.sourcePlaceholder", { defaultValue: "Select RSS sources" })}
                options={selectOptions}
                value={visibleSelectedSourceIds}
                onChange={(next) => {
                  setHasExplicitSourceSelection(true);
                  setSelectedSourceIds([...hiddenSelectedSourceIds, ...next]);
                }}
                maxTagCount="responsive"
                loading={loading}
                filterOption={(input, option) => {
                  const searchText =
                    typeof option?.searchText === "string" ? option.searchText : "";
                  return searchText.includes(input.trim().toLowerCase());
                }}
              />
              <Typography.Text type="secondary">
                {t("pages.rss.selectedCount", {
                  count: displayedSelectedSourceIds.length,
                  defaultValue: "{{count}} sources selected"
                })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("pages.rss.visibleSourcesCount", {
                  visible: visibleSources.length,
                  total: sortedSources.length,
                  defaultValue: "Showing {{visible}} of {{total}} sources"
                })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("pages.rss.sourceSortHint", {
                  defaultValue: "Sources are sorted by recent activity, then latest publish time."
                })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("pages.rss.preferencesHint", {
                  defaultValue: "This page syncs your selected sources and translation settings to your account."
                })}
              </Typography.Text>
            </Space>
          ) : null}

          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            <Typography.Text strong>
              {t("pages.rss.translation.title", { defaultValue: "Translation" })}
            </Typography.Text>
            <Space wrap>
              <Space>
                <Typography.Text>
                  {t("pages.rss.translation.enable", { defaultValue: "Enable" })}
                </Typography.Text>
                <Switch
                  checked={translationEnabled}
                  onChange={(checked) => {
                    setTranslationError(null);
                    setTranslationEnabled(checked);
                  }}
                />
              </Space>

              <Radio.Group
                value={translationProvider}
                onChange={(event) => {
                  setTranslationError(null);
                  setTranslationProvider(event.target.value as RssTranslationProvider);
                }}
                optionType="button"
                buttonStyle="solid"
                disabled={!translationEnabled}
              >
                <Radio.Button value="deeplx">
                  {t("pages.rss.translation.provider.deeplx", { defaultValue: "DeepLX API" })}
                </Radio.Button>
                <Radio.Button value="llm">
                  {t("pages.rss.translation.provider.llm", { defaultValue: "LLM" })}
                </Radio.Button>
              </Radio.Group>

              <Select
                style={{ minWidth: 160 }}
                value={targetLanguage}
                onChange={(next) => {
                  setTranslationError(null);
                  setTargetLanguage(next);
                }}
                disabled={!translationEnabled || translationProvider === "deeplx"}
                options={RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS}
              />

              {translationEnabled ? (
                <Space>
                  <Typography.Text>
                    {t("pages.rss.translation.showOriginal", {
                      defaultValue: "Show original"
                    })}
                  </Typography.Text>
                  <Switch
                    checked={showOriginalContent}
                    onChange={(checked) => setShowOriginalContent(checked)}
                  />
                </Space>
              ) : null}
            </Space>

            <Typography.Text type="secondary">
              {t("pages.rss.translation.scopeHint", {
                defaultValue:
                  "Only titles and summaries are translated here. Items without translated content stay in the original language."
              })}
            </Typography.Text>

            {translationEnabled && selectedProviderStatus && !selectedProviderStatus.available ? (
              <Alert
                type="warning"
                showIcon
                message={t("pages.rss.translation.unavailable", {
                  defaultValue: "Selected translation source is unavailable."
                })}
                description={selectedProviderStatus.message ?? t("common.notAvailable")}
              />
            ) : null}

            {translationEnabled &&
            selectedProviderStatus &&
            selectedProviderStatus.available &&
            !selectedProviderStatus.targetLanguageSupported ? (
              <Alert
                type="warning"
                showIcon
                message={t("pages.rss.translation.targetUnsupported", {
                  defaultValue: "Target language is not supported by selected source."
                })}
                description={selectedProviderStatus.message ?? t("common.notAvailable")}
              />
            ) : null}

            {translationEnabled && translationError ? (
              <Alert
                type="error"
                showIcon
                message={t("pages.rss.translation.failed", { defaultValue: "Translation failed." })}
                description={translationError}
              />
            ) : null}
          </Space>
        </Space>
      </Card>

      {showItemsLoadingSkeleton ? (
        <Card className="content-card">
          <Skeleton active title={{ width: "36%" }} paragraph={{ rows: 6 }} />
        </Card>
      ) : null}

      {sourceUiState.showSelectionAlert ? (
        <Alert
          type="info"
          showIcon
          message={t("pages.rss.sourcePlaceholder", { defaultValue: "Select RSS sources" })}
        />
      ) : null}

      {sourceUiState.showItemsView ? (
        <ItemsView
          initialView="feed"
          lockedView="feed"
          sortMode="publishedDesc"
          {...RSS_ITEMS_VIEW_PRESET}
          initialFilters={initialFilters}
          fixedSourceIds={selectedSourceIds}
          hideQuickNav
          rssTranslationConfig={
            translationEnabled
              ? {
                  enabled: translationReady,
                  provider: translationProvider,
                  targetLanguage,
                  fields: ["title", "summary"],
                  showOriginal: showOriginalContent
                }
              : undefined
          }
          onTranslationError={setTranslationError}
        />
      ) : null}
    </Space>
  );
}

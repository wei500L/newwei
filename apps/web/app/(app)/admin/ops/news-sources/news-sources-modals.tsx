"use client";

import type {
  Grid,
  message} from "antd";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { FormInstance } from "antd/es/form";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import type { ChangeEvent, MutableRefObject } from "react";
import type { useTranslation } from "react-i18next";

import { CreateCrawlTaskDrawer } from "@/app/(app)/crawl/components/CreateCrawlTaskDrawer";
import type { CreateCrawlTaskFormValues } from "@/app/(app)/crawl/types";
import { applyAutoBrowserHeadersToCrawlOptions } from "@/lib/crawl-browser-headers";
import { findUnsupportedProxyIssues } from "@/lib/crawl-config-policy";
import {
  buildNewsSourceCloudflarePresetValues,
  buildNewsSourceReutersCfPresetValues,
} from "@/lib/crawl-presets";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import {
  getDefaultSeedCacheTtlSecondsByMode,
  normalizeSeedMode,
  resolveSeedCacheTtlPolicy,
  type SeedSchedulerRuntimeSettings,
} from "@/lib/news-source-seed";

import {
  buildNewsSourceConfig,
  findDisallowedCrawl4aiLlmKeys,
  formatPolicyIssues,
  getCrawlStrategyTags,
  isPlainObject,
  NEWS_SOURCE_CREATE_INITIAL_VALUES,
  parseJsonField,
} from "./news-sources.helpers";
import type {
  NewsSourceFormValues,
  NewsSourceOpmlImportReport,
  NewsSourceOpmlMode,
  NewsSourceOpmlPresetSummary,
  NewsSourceOpmlPreviewEntry,
  NewsSourceOpmlPreviewResponse,
  NewsSourcePreviewCandidate,
  NewsSourcePreviewResponse,
  NewsSourceRecord,
  NewsSourceScheduleValues,
  NewsSourceSchedulerSettingsResponse,
} from "./news-sources.types";

export interface NewsSourcesModalsProps {
  t: ReturnType<typeof useTranslation>["t"];
  locale: SupportedLocale;
  canManage: boolean;
  canWriteItems: boolean;
  screens: ReturnType<typeof Grid.useBreakpoint>;
  form: FormInstance<NewsSourceFormValues>;
  createDrawerForm: FormInstance<CreateCrawlTaskFormValues>;
  scheduleForm: FormInstance<NewsSourceScheduleValues>;
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;
  editingSource: NewsSourceRecord | null;
  setEditingSource: (source: NewsSourceRecord | null) => void;
  createDrawerOpen: boolean;
  saving: boolean;
  creatingFromTaskDrawer: boolean;
  showCrawlSettings: boolean;
  templateOptions: { value: string; label: string }[];
  workflowOptions: { label: string; value: string }[];
  uniqueGroups: string[];
  siteTypeOptions: { value: string; label: string }[];
  resolvedSeedRuntimeSettings: SeedSchedulerRuntimeSettings;
  seedSchedulerSettings: NewsSourceSchedulerSettingsResponse | null;
  seedSchedulerSettingsLoadFailed: boolean;
  seedModeRef: MutableRefObject<NewsSourceFormValues["seedMode"]>;
  opmlModalOpen: boolean;
  setOpmlModalOpen: (open: boolean) => void;
  opmlMode: NewsSourceOpmlMode;
  opmlPresets: NewsSourceOpmlPresetSummary[];
  opmlPresetId: string;
  setOpmlPresetId: (id: string) => void;
  opmlDefaultLanguage: string;
  setOpmlDefaultLanguage: (language: string) => void;
  opmlContent: string;
  setOpmlContent: (content: string) => void;
  opmlFileName: string | null;
  opmlPreview: NewsSourceOpmlPreviewResponse | null;
  setOpmlPreview: (preview: NewsSourceOpmlPreviewResponse | null) => void;
  opmlLoadingPresets: boolean;
  opmlPreviewing: boolean;
  opmlImporting: boolean;
  opmlImportReport: NewsSourceOpmlImportReport | null;
  setOpmlImportReport: (report: NewsSourceOpmlImportReport | null) => void;
  previewOpen: boolean;
  setPreviewOpen: (open: boolean) => void;
  previewLoading: boolean;
  previewRunNowLoading: boolean;
  previewSource: NewsSourceRecord | null;
  setPreviewSource: (source: NewsSourceRecord | null) => void;
  previewData: NewsSourcePreviewResponse | null;
  setPreviewData: (data: NewsSourcePreviewResponse | null) => void;
  scheduleOpen: boolean;
  scheduleLoading: boolean;
  scheduleTargets: NewsSourceRecord[];
  scheduleDeliveryMode: "crawl4ai" | "rss" | "mixed";
  handleSubmit: (values: NewsSourceFormValues) => Promise<void>;
  handleCreateFromTaskDrawer: (
    values: CreateCrawlTaskFormValues,
  ) => Promise<void>;
  closeCreateDrawer: () => void;
  handleOpmlModeChange: (mode: NewsSourceOpmlMode) => void;
  handleOpmlFileChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePreviewOpml: () => Promise<void>;
  handleApplyOpmlDefaultLanguage: () => void;
  handleImportOpml: () => Promise<void>;
  handleSchedule: (values: NewsSourceScheduleValues) => Promise<void>;
  closeSchedule: () => void;
  reloadPreview: () => Promise<void>;
  handleRunNowFromPreview: () => Promise<void>;
  handleScheduleFromPreview: () => void;
  updateOpmlPreviewEntry: (
    index: number,
    patch: Partial<NewsSourceOpmlPreviewEntry>,
  ) => void;
  messageApi: ReturnType<typeof message.useMessage>[0];
}

export function NewsSourcesModals({
  t,
  locale,
  canManage,
  canWriteItems,
  screens,
  form,
  createDrawerForm,
  scheduleForm,
  modalOpen,
  setModalOpen,
  editingSource,
  setEditingSource,
  createDrawerOpen,
  saving,
  creatingFromTaskDrawer,
  showCrawlSettings,
  templateOptions,
  workflowOptions,
  uniqueGroups,
  siteTypeOptions,
  resolvedSeedRuntimeSettings,
  seedSchedulerSettingsLoadFailed,
  seedModeRef,
  opmlModalOpen,
  setOpmlModalOpen,
  opmlMode,
  opmlPresets,
  opmlPresetId,
  setOpmlPresetId,
  opmlDefaultLanguage,
  setOpmlDefaultLanguage,
  opmlContent,
  opmlFileName,
  opmlPreview,
  setOpmlPreview,
  opmlLoadingPresets,
  opmlPreviewing,
  opmlImporting,
  opmlImportReport,
  setOpmlImportReport,
  previewOpen,
  setPreviewOpen,
  previewLoading,
  previewRunNowLoading,
  previewSource,
  setPreviewSource,
  previewData,
  setPreviewData,
  scheduleOpen,
  scheduleLoading,
  scheduleTargets,
  scheduleDeliveryMode,
  handleSubmit,
  handleCreateFromTaskDrawer,
  closeCreateDrawer,
  handleOpmlModeChange,
  handleOpmlFileChange,
  handlePreviewOpml,
  handleApplyOpmlDefaultLanguage,
  handleImportOpml,
  handleSchedule,
  closeSchedule,
  reloadPreview,
  handleRunNowFromPreview,
  handleScheduleFromPreview,
  updateOpmlPreviewEntry,
  messageApi,
}: NewsSourcesModalsProps) {
  const buildConfig = (values: NewsSourceFormValues) =>
    buildNewsSourceConfig(values, editingSource, t);

  const previewColumns: ColumnsType<NewsSourcePreviewCandidate> = [
    {
      title: t("newsSources.preview.columns.url"),
      dataIndex: "url",
      key: "url",
      render: (value: string, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Link
            href={value}
            target="_blank"
            rel="noreferrer"
            title={value}
            ellipsis
          >
            {value}
          </Typography.Link>
          {record.title ? (
            <Typography.Text type="secondary">{record.title}</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("newsSources.preview.columns.relevance"),
      dataIndex: "relevanceScore",
      key: "relevanceScore",
      width: 110,
      render: (value?: number) =>
        typeof value === "number" && Number.isFinite(value)
          ? value.toFixed(3)
          : "-",
    },
    {
      title: t("newsSources.preview.columns.timeSignal"),
      key: "timeSignal",
      width: 220,
      render: (_: unknown, record) => {
        if (record.publishedAt) {
          return (
            <Space direction="vertical" size={2}>
              <Typography.Text>
                {formatDateTime(record.publishedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
              <Tag color="green">
                {t("newsSources.preview.timePublished")}
              </Tag>
            </Space>
          );
        }

        if (record.crawledAt) {
          return (
            <Space direction="vertical" size={2}>
              <Typography.Text>
                {formatDateTime(record.crawledAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Typography.Text>
              <Space size={4} wrap>
                <Tag color="blue">
                  {t("newsSources.preview.timeCrawled")}
                </Tag>
                <Tag color="orange">
                  {t("newsSources.preview.publishDateMissing")}
                </Tag>
              </Space>
            </Space>
          );
        }

        return <Typography.Text type="secondary">-</Typography.Text>;
      },
    },
    {
      title: t("newsSources.preview.columns.status"),
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: NewsSourcePreviewCandidate["status"]) =>
        value === "success" ? (
          <Tag color="green">
            {t("common.success")}
          </Tag>
        ) : (
          <Tag color="red">
            {t("common.failed")}
          </Tag>
        ),
    },
    {
      title: t("newsSources.preview.columns.dedupe"),
      dataIndex: "alreadyCrawled",
      key: "alreadyCrawled",
      width: 160,
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          {record.alreadyCrawled ? (
            <Tag color="default">
              {t("newsSources.preview.alreadyCrawled")}
            </Tag>
          ) : (
            <Tag color="blue">
              {t("newsSources.preview.newUrl")}
            </Tag>
          )}
          {record.alreadyQueued ? (
            <Tooltip
              title={
                record.inFlightStatus
                  ? t("newsSources.preview.inFlightStatus", {
                      status: record.inFlightStatus,
                    })
                  : t("newsSources.preview.inFlight")
              }
            >
              <Tag color="orange">
                {t("newsSources.preview.inFlight")}
              </Tag>
            </Tooltip>
          ) : null}
          {record.lastCrawlAt
            ? formatDateTime(record.lastCrawlAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : null}
        </Space>
      ),
    },
    {
      title: t("newsSources.preview.columns.error"),
      dataIndex: "error",
      key: "error",
      render: (value?: string) =>
        value ? (
          <Tooltip title={value}>
            <Typography.Text type="danger" ellipsis={{ tooltip: value }}>
              {value}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
  ];

  return (
    <>
      <Form<NewsSourceFormValues>
        form={form}
        layout="vertical"
        initialValues={NEWS_SOURCE_CREATE_INITIAL_VALUES}
        onFinish={handleSubmit}
        onValuesChange={(changedValues, allValues) => {
          if (
            !Object.prototype.hasOwnProperty.call(changedValues, "seedMode")
          ) {
            return;
          }
          const previousMode = normalizeSeedMode(seedModeRef.current);
          const nextMode = normalizeSeedMode(changedValues.seedMode);
          seedModeRef.current = nextMode;

          const schedulerRuntimeSettings = resolvedSeedRuntimeSettings;
          const currentTtl = allValues.seedCacheTtlSeconds;
          const previousDefaultTtl = getDefaultSeedCacheTtlSecondsByMode(
            previousMode,
            schedulerRuntimeSettings,
          );
          if (
            typeof currentTtl === "number" &&
            Number.isFinite(currentTtl) &&
            currentTtl !== previousDefaultTtl
          ) {
            return;
          }

          form.setFieldsValue({
            seedCacheTtlSeconds: getDefaultSeedCacheTtlSecondsByMode(
              nextMode,
              schedulerRuntimeSettings,
            ),
          });
        }}
        component={false}
      >
        <Modal
          open={modalOpen}
          title={
            editingSource
              ? t("newsSources.actions.edit")
              : t("newsSources.actions.new")
          }
          onCancel={() => {
            setModalOpen(false);
            setEditingSource(null);
            seedModeRef.current = "sitemap";
            form.resetFields();
          }}
          onOk={() => form.submit()}
          okButtonProps={{ loading: saving }}
          destroyOnHidden
        >
          <Form.Item
            name="name"
            label={t("newsSources.fields.name")}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="url"
            label={t("newsSources.fields.url")}
            rules={[{ required: true, type: "url" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="siteType"
            label={t("newsSources.fields.type")}
            rules={[{ required: true }]}
          >
            <Select options={siteTypeOptions} />
          </Form.Item>
          <Form.Item
            name="language"
            label={t("newsSources.fields.language")}
          >
            <Input
              placeholder={t("newsSources.fields.languageHint")}
            />
          </Form.Item>
          {showCrawlSettings ? (
            <Form.Item
              name="crawlTemplateId"
              label={t("newsSources.fields.template")}
            >
              <Select
                showSearch
                allowClear
                options={templateOptions}
                placeholder={t("common.none")}
              />
            </Form.Item>
          ) : null}
          <Form.Item
            name="workflowId"
            label={t("newsSources.fields.workflow")}
          >
            <Select
              showSearch
              allowClear
              options={workflowOptions}
              placeholder={t("common.none")}
            />
          </Form.Item>
          <Form.Item
            name="workflowBindingMode"
            label={t("newsSources.fields.workflowMode")}
          >
            <Select
              options={[
                { label: "published", value: "published" },
                { label: "pinned", value: "pinned" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="workflowVersionId"
            label={t("newsSources.fields.workflowVersion")}
          >
            <Input placeholder="workflow-version-id" />
          </Form.Item>
          <Form.Item
            name="group"
            label={t("newsSources.fields.group")}
          >
            <Select
              showSearch
              allowClear
              mode="tags"
              maxCount={1}
              options={uniqueGroups.map((g) => ({ value: g, label: g }))}
              placeholder={t("newsSources.fields.groupPlaceholder")}
              notFoundContent={null}
              filterOption={(input, option) =>
                ((option?.label as string) ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("newsSources.sections.schedule")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("newsSources.sections.scheduleHint")}
          </Typography.Text>

          <Form.Item
            name="scheduleMode"
            label={t("newsSources.fields.scheduleMode")}
          >
            <Select
              options={[
                {
                  value: "interval",
                  label: t("newsSources.scheduleMode.interval"),
                },
                {
                  value: "cron",
                  label: t("newsSources.scheduleMode.cron"),
                },
              ]}
            />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, nextValues) =>
              prevValues.scheduleMode !== nextValues.scheduleMode
            }
          >
            {({ getFieldValue }) => {
              const mode =
                getFieldValue("scheduleMode") === "cron" ? "cron" : "interval";
              if (mode !== "cron") {
                return null;
              }

              return (
                <>
                  <Form.Item
                    name="cronExpression"
                    label={t("newsSources.fields.cronExpression")}
                    dependencies={["scheduleMode"]}
                    rules={[
                      ({ getFieldValue: get }) => ({
                        validator: (_rule, value: string | undefined) => {
                          if (get("scheduleMode") !== "cron") {
                            return Promise.resolve();
                          }
                          if (
                            typeof value === "string" &&
                            value.trim().length > 0
                          ) {
                            return Promise.resolve();
                          }
                          return Promise.reject(
                            new Error(
                              t("newsSources.fields.cronExpressionRequired"),
                            ),
                          );
                        },
                      }),
                    ]}
                  >
                    <Input placeholder="*/15 * * * *" />
                  </Form.Item>
                  <Form.Item
                    name="cronTimezone"
                    label={t("newsSources.fields.cronTimezone")}
                    tooltip={t("newsSources.fields.cronTimezoneHint")}
                  >
                    <Input placeholder="UTC" />
                  </Form.Item>
                  <Form.Item
                    name="cronWindowDaysOfWeek"
                    label={t("newsSources.fields.cronWindowDays")}
                  >
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder={t("common.none")}
                      options={[
                        {
                          value: 1,
                          label: t("common.weekday.mon"),
                        },
                        {
                          value: 2,
                          label: t("common.weekday.tue"),
                        },
                        {
                          value: 3,
                          label: t("common.weekday.wed"),
                        },
                        {
                          value: 4,
                          label: t("common.weekday.thu"),
                        },
                        {
                          value: 5,
                          label: t("common.weekday.fri"),
                        },
                        {
                          value: 6,
                          label: t("common.weekday.sat"),
                        },
                        {
                          value: 0,
                          label: t("common.weekday.sun"),
                        },
                      ]}
                    />
                  </Form.Item>
                  <Row gutter={[12, 0]}>
                    <Col span={12}>
                      <Form.Item
                        name="cronWindowStartHour"
                        label={t("newsSources.fields.cronWindowStartHour")}
                      >
                        <InputNumber
                          min={0}
                          max={23}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name="cronWindowEndHour"
                        label={t("newsSources.fields.cronWindowEndHour")}
                      >
                        <InputNumber
                          min={1}
                          max={24}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                </>
              );
            }}
          </Form.Item>

          <Form.Item
            name="frequencySeconds"
            label={t("newsSources.fields.frequency")}
            rules={[{ required: true }]}
          >
            <InputNumber min={60} max={2_592_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="priority"
            label={t("newsSources.fields.priority")}
            rules={[{ required: true }]}
          >
            <InputNumber min={-100} max={100} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="isActive"
            label={t("newsSources.fields.active")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="keywords"
            label={t("newsSources.fields.keywords")}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.keywordsHint")}
            />
          </Form.Item>
          <Form.Item
            name="tags"
            label={t("newsSources.fields.tags")}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.tagsHint")}
            />
          </Form.Item>
          <Form.Item
            name="summaryHints"
            label={t("newsSources.fields.summaryHints")}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("newsSources.fields.summaryHintsHint")}
            />
          </Form.Item>
          <Form.Item
            name="metadataJson"
            label={t("newsSources.fields.metadata")}
          >
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          {showCrawlSettings ? (
            <>
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.crawl.proxyDisabledTitle")}
                description={t("newsSources.crawl.proxyDisabledDescription")}
              />

              <Typography.Title level={5} style={{ marginBottom: 0 }}>
                {t("newsSources.sections.crawlStrategy")}
              </Typography.Title>
              <Typography.Text type="secondary">
                {t("newsSources.sections.crawlStrategyHint")}
              </Typography.Text>
              <Alert
                style={{ marginBottom: 12, marginTop: 8 }}
                showIcon
                type="info"
                message={t("newsSources.hints.noLlmTitle")}
                description={t("newsSources.hints.noLlmDescription")}
              />
              <Form.Item
                name="crawlScanMode"
                label={t("newsSources.fields.crawlScanMode")}
                tooltip={t("newsSources.fields.crawlScanModeHint")}
              >
                <Select
                  options={[
                    {
                      value: "default",
                      label: t("newsSources.scanMode.default"),
                    },
                    {
                      value: "full_page",
                      label: t("newsSources.scanMode.fullPage"),
                    },
                    {
                      value: "virtual_scroll",
                      label: t("newsSources.scanMode.virtualScroll"),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prevValues, nextValues) =>
                  prevValues.crawlScanMode !== nextValues.crawlScanMode
                }
              >
                {({ getFieldValue }) => {
                  const scanMode =
                    getFieldValue("crawlScanMode") === "full_page"
                      ? "full_page"
                      : getFieldValue("crawlScanMode") === "virtual_scroll"
                        ? "virtual_scroll"
                        : "default";

                  return (
                    <>
                      <Alert
                        style={{ marginBottom: 12 }}
                        showIcon
                        type={
                          scanMode === "full_page"
                            ? "success"
                            : scanMode === "virtual_scroll"
                              ? "warning"
                              : "info"
                        }
                        message={
                          scanMode === "full_page"
                            ? t("crawl.settings.scanModes.fullPageTitle")
                            : scanMode === "virtual_scroll"
                              ? t("crawl.settings.scanModes.virtualScrollTitle")
                              : t("crawl.settings.scanModes.defaultTitle")
                        }
                        description={
                          scanMode === "full_page"
                            ? t("crawl.settings.scanModes.fullPageDescription")
                            : scanMode === "virtual_scroll"
                              ? t(
                                  "crawl.settings.scanModes.virtualScrollDescription",
                                )
                              : t("crawl.settings.scanModes.defaultDescription")
                        }
                      />
                      {scanMode === "full_page" ? (
                        <Form.Item
                          name="crawlScrollDelayMs"
                          label={t("newsSources.fields.crawlScrollDelayMs")}
                        >
                          <InputNumber
                            min={0}
                            max={5000}
                            step={100}
                            style={{ width: "100%" }}
                          />
                        </Form.Item>
                      ) : null}
                      {scanMode === "virtual_scroll" ? (
                        <>
                          <Form.Item
                            name="crawlVirtualScrollContainerSelector"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollContainerSelector",
                            )}
                          >
                            <Input placeholder="body" />
                          </Form.Item>
                          <Form.Item
                            name="crawlVirtualScrollScrollCount"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollScrollCount",
                            )}
                          >
                            <InputNumber
                              min={1}
                              max={1000}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                          <Form.Item
                            name="crawlVirtualScrollScrollBy"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollScrollBy",
                            )}
                          >
                            <Select
                              options={[
                                {
                                  value: "page_height",
                                  label: t(
                                    "crawl.virtualScroll.scrollByOptions.pageHeight",
                                  ),
                                },
                                {
                                  value: "container_height",
                                  label: t(
                                    "crawl.virtualScroll.scrollByOptions.containerHeight",
                                  ),
                                },
                                {
                                  value: "pixels",
                                  label: t(
                                    "crawl.virtualScroll.scrollByOptions.pixels",
                                  ),
                                },
                              ]}
                            />
                          </Form.Item>
                          <Form.Item
                            noStyle
                            shouldUpdate={(prevValues, nextValues) =>
                              prevValues.crawlVirtualScrollScrollBy !==
                              nextValues.crawlVirtualScrollScrollBy
                            }
                          >
                            {({ getFieldValue: getScrollBy }) =>
                              getScrollBy("crawlVirtualScrollScrollBy") ===
                              "pixels" ? (
                                <Form.Item
                                  name="crawlVirtualScrollScrollByPixels"
                                  label={t(
                                    "newsSources.fields.crawlVirtualScrollScrollByPixels",
                                  )}
                                >
                                  <InputNumber
                                    min={1}
                                    max={20000}
                                    step={50}
                                    style={{ width: "100%" }}
                                  />
                                </Form.Item>
                              ) : null
                            }
                          </Form.Item>
                          <Form.Item
                            name="crawlVirtualScrollWaitAfterScrollMs"
                            label={t(
                              "newsSources.fields.crawlVirtualScrollWaitAfterScrollMs",
                            )}
                          >
                            <InputNumber
                              min={0}
                              max={60000}
                              step={100}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </>
                      ) : null}
                    </>
                  );
                }}
              </Form.Item>

              <Form.Item
                name="crawlQualityProfile"
                label={t("newsSources.fields.crawlQualityProfile")}
                tooltip={t("crawl.settings.qualityProfileHint")}
              >
                <Select
                  allowClear
                  options={[
                    {
                      value: "quality_first",
                      label: t(
                        "crawl.settings.qualityProfileOptions.qualityFirst",
                      ),
                    },
                    {
                      value: "balanced",
                      label: t("crawl.settings.qualityProfileOptions.balanced"),
                    },
                    {
                      value: "speed_first",
                      label: t(
                        "crawl.settings.qualityProfileOptions.speedFirst",
                      ),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="crawlPageTypeHint"
                label={t("newsSources.fields.crawlPageTypeHint")}
                tooltip={t("crawl.settings.pageTypeHintHint")}
              >
                <Select
                  allowClear
                  options={[
                    {
                      value: "auto",
                      label: t("crawl.settings.pageTypeHintOptions.auto"),
                    },
                    {
                      value: "list",
                      label: t("crawl.settings.pageTypeHintOptions.list"),
                    },
                    {
                      value: "detail",
                      label: t("crawl.settings.pageTypeHintOptions.detail"),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="crawlAutoExpandDetails"
                label={t("newsSources.fields.crawlAutoExpandDetails")}
                tooltip={t("crawl.settings.autoExpandDetailsHint")}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prevValues, nextValues) =>
                  prevValues.crawlAutoExpandDetails !==
                  nextValues.crawlAutoExpandDetails
                }
              >
                {({ getFieldValue }) => {
                  if (getFieldValue("crawlAutoExpandDetails") !== true) {
                    return null;
                  }
                  return (
                    <>
                      <Form.Item
                        name="crawlDetailMaxUrls"
                        label={t("newsSources.fields.crawlDetailMaxUrls")}
                        extra={t("crawl.detailExpansion.maxDetailUrlsHint")}
                      >
                        <InputNumber
                          min={1}
                          max={30}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailMinRelevanceScore"
                        label={t(
                          "newsSources.fields.crawlDetailMinRelevanceScore",
                        )}
                        extra={t("crawl.detailExpansion.minRelevanceScoreHint")}
                      >
                        <InputNumber
                          min={0}
                          max={1}
                          step={0.01}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailRequireSameDomain"
                        label={t(
                          "newsSources.fields.crawlDetailRequireSameDomain",
                        )}
                        extra={t("crawl.detailExpansion.requireSameDomainHint")}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailAllowExternalLinks"
                        label={t(
                          "newsSources.fields.crawlDetailAllowExternalLinks",
                        )}
                        extra={t(
                          "crawl.detailExpansion.allowExternalLinksHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailMinPublishTimeConfidence"
                        label={t(
                          "newsSources.fields.crawlDetailMinPublishTimeConfidence",
                        )}
                        extra={t(
                          "crawl.detailExpansion.minPublishTimeConfidenceHint",
                        )}
                      >
                        <InputNumber
                          min={0}
                          max={1}
                          step={0.01}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailPreferFitMarkdownForQuality"
                        label={t(
                          "newsSources.fields.crawlDetailPreferFitMarkdownForQuality",
                        )}
                        extra={t(
                          "crawl.detailExpansion.preferFitMarkdownForQualityHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailExcludeUrlPatterns"
                        label={t(
                          "newsSources.fields.crawlDetailExcludeUrlPatterns",
                        )}
                        extra={t(
                          "crawl.detailExpansion.excludeUrlPatternsHint",
                        )}
                      >
                        <Select mode="tags" tokenSeparators={[","]} />
                      </Form.Item>
                      <Form.Item
                        name="crawlDetailIncludeUrlPatterns"
                        label={t(
                          "newsSources.fields.crawlDetailIncludeUrlPatterns",
                        )}
                        extra={t(
                          "crawl.detailExpansion.includeUrlPatternsHint",
                        )}
                      >
                        <Select mode="tags" tokenSeparators={[","]} />
                      </Form.Item>
                    </>
                  );
                }}
              </Form.Item>

              <Typography.Title level={5} style={{ marginBottom: 0 }}>
                {t("newsSources.sections.crawlMarkdown")}
              </Typography.Title>
              <Typography.Text type="secondary">
                {t("newsSources.sections.crawlMarkdownHint")}
              </Typography.Text>
              <Alert
                style={{ marginBottom: 12, marginTop: 8 }}
                showIcon
                type="success"
                message={t("newsSources.hints.ragReadyTitle")}
                description={t("newsSources.hints.ragReadyDescription")}
              />
              <Form.Item
                name="crawlMarkdownContentSource"
                label={t("newsSources.fields.crawlMarkdownContentSource")}
              >
                <Select
                  options={[
                    {
                      value: "cleaned_html",
                      label: t("crawl.markdown.sourceOptions.cleaned"),
                    },
                    {
                      value: "raw_html",
                      label: t("crawl.markdown.sourceOptions.raw"),
                    },
                    {
                      value: "fit_html",
                      label: t("crawl.markdown.sourceOptions.fit"),
                    },
                  ]}
                />
              </Form.Item>
              <Row gutter={[12, 0]}>
                <Col span={12}>
                  <Form.Item
                    name="crawlMarkdownEscapeHtmlMode"
                    label={t("newsSources.fields.crawlMarkdownEscapeHtmlMode")}
                  >
                    <Select
                      options={[
                        {
                          value: "auto",
                          label: t("newsSources.crawlTriState.auto"),
                        },
                        {
                          value: "enable",
                          label: t("newsSources.crawlTriState.enable"),
                        },
                        {
                          value: "disable",
                          label: t("newsSources.crawlTriState.disable"),
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="crawlMarkdownCitationsMode"
                    label={t("newsSources.fields.crawlMarkdownCitationsMode")}
                  >
                    <Select
                      options={[
                        {
                          value: "auto",
                          label: t("newsSources.crawlTriState.auto"),
                        },
                        {
                          value: "enable",
                          label: t("newsSources.crawlTriState.enable"),
                        },
                        {
                          value: "disable",
                          label: t("newsSources.crawlTriState.disable"),
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item noStyle shouldUpdate>
                {({ getFieldsValue }) => {
                  const values = getFieldsValue(true) as NewsSourceFormValues;
                  const previewValues: NewsSourceFormValues = {
                    ...values,
                    metadataJson: undefined,
                    keywords: undefined,
                    tags: undefined,
                    summaryHints: undefined,
                  };

                  let crawlOptionsPreview = "{}";
                  let previewError: string | null = null;

                  try {
                    const previewConfig = buildConfig(previewValues);
                    const previewOptions =
                      previewConfig && isPlainObject(previewConfig.crawlOptions)
                        ? (previewConfig.crawlOptions as Record<
                            string,
                            unknown
                          >)
                        : null;
                    crawlOptionsPreview = previewOptions
                      ? JSON.stringify(previewOptions, null, 2)
                      : "{}";
                  } catch (error) {
                    previewError =
                      error instanceof Error
                        ? error.message
                        : t("newsSources.hints.crawlOptionsPreviewError");
                  }

                  return (
                    <Card
                      size="small"
                      title={t("newsSources.sections.crawlOptionsPreview")}
                      style={{ marginBottom: 12 }}
                    >
                      <Typography.Paragraph
                        type="secondary"
                        style={{ marginTop: 0 }}
                      >
                        {t("newsSources.sections.crawlOptionsPreviewHint")}
                      </Typography.Paragraph>
                      {previewError ? (
                        <Alert
                          type="warning"
                          showIcon
                          message={previewError}
                          style={{ marginBottom: 8 }}
                        />
                      ) : null}
                      <Input.TextArea
                        value={crawlOptionsPreview}
                        autoSize={{ minRows: 4, maxRows: 10 }}
                        readOnly
                      />
                    </Card>
                  );
                }}
              </Form.Item>

              <Space style={{ marginBottom: 8 }}>
                <Button
                  size="small"
                  onClick={() => {
                    try {
                      const currentRaw = form.getFieldValue(
                        "crawlOptionsJson",
                      ) as string | undefined;
                      const current =
                        parseJsonField(currentRaw, "crawlOptions") ?? {};
                      const next =
                        applyAutoBrowserHeadersToCrawlOptions(current);
                      form.setFieldsValue({
                        crawlOptionsJson: JSON.stringify(next, null, 2),
                      });
                    } catch (error) {
                      messageApi.error(
                        error instanceof Error
                          ? error.message
                          : t("common.operationFailed"),
                      );
                    }
                  }}
                >
                  {t("crawl.browser.headers.autoFillSecCh")}
                </Button>
                <Typography.Text type="secondary">
                  {t("crawl.browser.headers.autoFillSecChHint")}
                </Typography.Text>
              </Space>

              <Form.Item
                name="crawlOptionsJson"
                label={t("newsSources.fields.crawlOptions")}
                tooltip={t("newsSources.fields.crawlOptionsHint")}
                validateTrigger="onBlur"
                rules={[
                  {
                    validator: async (_rule, value) => {
                      const trimmed =
                        typeof value === "string" ? value.trim() : "";
                      if (!trimmed) {
                        return;
                      }
                      let parsed: unknown;
                      try {
                        parsed = JSON.parse(trimmed);
                      } catch (error) {
                        throw new Error(
                          error instanceof Error
                            ? error.message
                            : "crawlOptions must be a valid JSON object",
                        );
                      }
                      if (
                        !parsed ||
                        typeof parsed !== "object" ||
                        Array.isArray(parsed)
                      ) {
                        throw new Error("crawlOptions must be a JSON object");
                      }
                      const proxyIssues = findUnsupportedProxyIssues(
                        parsed,
                        "config.crawlOptions",
                      );
                      if (proxyIssues.length > 0) {
                        throw new Error(formatPolicyIssues(proxyIssues, t));
                      }
                      const blockedKeys = findDisallowedCrawl4aiLlmKeys(parsed);
                      if (blockedKeys.length === 0) {
                        return;
                      }
                      const list = blockedKeys.slice(0, 5).join(", ");
                      const suffix =
                        blockedKeys.length > 5
                          ? ` (+${blockedKeys.length - 5} more)`
                          : "";
                      throw new Error(
                        t("newsSources.errors.crawlOptionsLlmBlocked", {
                          keys: list,
                          suffix,
                        }),
                      );
                    },
                  },
                ]}
              >
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
              </Form.Item>
              <Form.Item
                name="crawlHeadlessMode"
                label={t("newsSources.fields.crawlHeadlessMode")}
                tooltip={t("newsSources.fields.crawlHeadlessModeHint")}
              >
                <Select
                  options={[
                    {
                      label: t("newsSources.crawlHeadlessMode.auto"),
                      value: "auto",
                    },
                    {
                      label: t("newsSources.crawlHeadlessMode.headless"),
                      value: "headless",
                    },
                    {
                      label: t("newsSources.crawlHeadlessMode.headed"),
                      value: "headed",
                    },
                  ]}
                />
              </Form.Item>
              <Row gutter={[12, 0]}>
                <Col span={8}>
                  <Form.Item
                    name="crawlUndetectedMode"
                    label={t("newsSources.fields.crawlUndetectedMode")}
                    tooltip={t("newsSources.fields.crawlUndetectedModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.crawlTriState.auto"),
                          value: "auto",
                        },
                        {
                          label: t("newsSources.crawlTriState.enable"),
                          value: "enable",
                        },
                        {
                          label: t("newsSources.crawlTriState.disable"),
                          value: "disable",
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    name="crawlStealthMode"
                    label={t("newsSources.fields.crawlStealthMode")}
                    tooltip={t("newsSources.fields.crawlStealthModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.crawlTriState.auto"),
                          value: "auto",
                        },
                        {
                          label: t("newsSources.crawlTriState.enable"),
                          value: "enable",
                        },
                        {
                          label: t("newsSources.crawlTriState.disable"),
                          value: "disable",
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    name="crawlAntiBotMode"
                    label={t("newsSources.fields.crawlAntiBotMode")}
                    tooltip={t("newsSources.fields.crawlAntiBotModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.crawlTriState.auto"),
                          value: "auto",
                        },
                        {
                          label: t("newsSources.crawlTriState.enable"),
                          value: "enable",
                        },
                        {
                          label: t("newsSources.crawlTriState.disable"),
                          value: "disable",
                        },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Typography.Paragraph style={{ marginBottom: 12 }}>
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() =>
                      form.setFieldsValue(
                        buildNewsSourceCloudflarePresetValues(),
                      )
                    }
                  >
                    {t("newsSources.presets.cloudflare")}
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      form.setFieldsValue(
                        buildNewsSourceReutersCfPresetValues(),
                      )
                    }
                  >
                    {t("newsSources.presets.reutersCf")}
                  </Button>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.cloudflareHint")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.reutersCfHint")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.cloudflareDefaultHint")}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("newsSources.presets.cloudflareRuntimeHint")}
                  </Typography.Text>
                </Space>
              </Typography.Paragraph>
              <Form.Item
                name="forceRefresh"
                label={t("newsSources.fields.forceRefresh")}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </>
          ) : null}

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("newsSources.sections.seed")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("newsSources.sections.seedHint")}
          </Typography.Text>

          <Form.Item
            name="seedEnabled"
            label={t("newsSources.fields.seedEnabled")}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, nextValues) =>
              prevValues.seedEnabled !== nextValues.seedEnabled ||
              prevValues.seedMode !== nextValues.seedMode ||
              prevValues.seedCacheTtlSeconds !== nextValues.seedCacheTtlSeconds
            }
          >
            {({ getFieldValue }) => {
              const seedEnabled = getFieldValue("seedEnabled") === true;
              const seedMode = normalizeSeedMode(getFieldValue("seedMode"));
              const currentSeedCacheTtlSeconds = getFieldValue(
                "seedCacheTtlSeconds",
              );
              const resolvedSeedCachePolicy = resolveSeedCacheTtlPolicy(
                seedMode,
                currentSeedCacheTtlSeconds,
                resolvedSeedRuntimeSettings,
              );
              const seedCacheTtlInputDisabled =
                resolvedSeedCachePolicy.isGlobalForced;
              const schedulerSitemapRssTtl =
                resolvedSeedRuntimeSettings.seedCacheTtlSecondsSitemapRss;
              const schedulerListDeepTtl =
                resolvedSeedRuntimeSettings.seedCacheTtlSecondsListDeep;

              return (
                <div style={{ display: seedEnabled ? "block" : "none" }}>
                  <Form.Item
                    name="seedMode"
                    label={t("newsSources.fields.seedMode")}
                    tooltip={t("newsSources.fields.seedModeHint")}
                  >
                    <Select
                      options={[
                        {
                          label: t("newsSources.seedMode.sitemap"),
                          value: "sitemap",
                        },
                        {
                          label: t("newsSources.seedMode.rss"),
                          value: "rss",
                        },
                        {
                          label: t("newsSources.seedMode.list"),
                          value: "list",
                        },
                        {
                          label: t("newsSources.seedMode.deep"),
                          value: "deep",
                        },
                      ]}
                    />
                  </Form.Item>

                  {seedMode === "rss" ? (
                    <>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={t("newsSources.seed.rssDirectTitle")}
                        description={t(
                          "newsSources.seed.rssDirectDescription",
                        )}
                      />
                      <Form.Item
                        name="seedFeedUrl"
                        label={t("newsSources.fields.seedFeedUrl")}
                        tooltip={t("newsSources.fields.seedFeedUrlHint")}
                      >
                        <Input placeholder="https://example.com/rss.xml" />
                      </Form.Item>
                      <Form.Item
                        name="seedRssAdaptiveEnabled"
                        label={t("newsSources.fields.seedRssAdaptiveEnabled")}
                        tooltip={t(
                          "newsSources.fields.seedRssAdaptiveEnabledHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="seedRssAdvancedEnabled"
                        label={t("newsSources.fields.seedRssAdvancedEnabled")}
                        tooltip={t(
                          "newsSources.fields.seedRssAdvancedEnabledHint",
                        )}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        noStyle
                        shouldUpdate={(prevValues, nextValues) =>
                          prevValues.seedRssAdvancedEnabled !==
                          nextValues.seedRssAdvancedEnabled
                        }
                      >
                        {({ getFieldValue }) =>
                          getFieldValue("seedRssAdvancedEnabled") === true ? (
                            <>
                              <Form.Item
                                name="seedRssRequestTimeoutMs"
                                label={t(
                                  "newsSources.fields.seedRssRequestTimeoutMs",
                                )}
                                tooltip={t(
                                  "newsSources.fields.seedRssRequestTimeoutMsHint",
                                )}
                              >
                                <InputNumber
                                  min={1000}
                                  max={120000}
                                  step={1000}
                                  style={{ width: "100%" }}
                                />
                              </Form.Item>
                              <Form.Item
                                name="seedRssBodySourceStrategy"
                                label={t(
                                  "newsSources.fields.seedRssBodySourceStrategy",
                                )}
                                tooltip={t(
                                  "newsSources.fields.seedRssBodySourceStrategyHint",
                                )}
                              >
                                <Select
                                  options={[
                                    {
                                      value: "content_first",
                                      label: t(
                                        "newsSources.seedRss.bodySource.contentFirst",
                                      ),
                                    },
                                    {
                                      value: "content_only",
                                      label: t(
                                        "newsSources.seedRss.bodySource.contentOnly",
                                      ),
                                    },
                                    {
                                      value: "summary_only",
                                      label: t(
                                        "newsSources.seedRss.bodySource.summaryOnly",
                                      ),
                                    },
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item
                                name="seedRssNoBodyPolicy"
                                label={t(
                                  "newsSources.fields.seedRssNoBodyPolicy",
                                )}
                                tooltip={t(
                                  "newsSources.fields.seedRssNoBodyPolicyHint",
                                )}
                              >
                                <Select
                                  options={[
                                    {
                                      value: "skip",
                                      label: t(
                                        "newsSources.seedRss.noBody.skip",
                                      ),
                                    },
                                    {
                                      value: "title_description_stub",
                                      label: t(
                                        "newsSources.seedRss.noBody.stub",
                                      ),
                                    },
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item
                                noStyle
                                shouldUpdate={(prevValues, nextValues) =>
                                  prevValues.seedRssNoBodyPolicy !==
                                  nextValues.seedRssNoBodyPolicy
                                }
                              >
                                {({ getFieldValue }) =>
                                  getFieldValue("seedRssNoBodyPolicy") ===
                                  "title_description_stub" ? (
                                    <Alert
                                      type="warning"
                                      showIcon
                                      style={{ marginBottom: 12 }}
                                      message={t(
                                        "newsSources.seed.rssStubWarningTitle",
                                      )}
                                      description={t(
                                        "newsSources.seed.rssStubWarningDescription",
                                      )}
                                    />
                                  ) : null
                                }
                              </Form.Item>
                            </>
                          ) : null
                        }
                      </Form.Item>
                    </>
                  ) : (
                    <>
                      <Form.Item
                        name="seedDomain"
                        label={t("newsSources.fields.seedDomain")}
                        tooltip={t("newsSources.fields.seedDomainHint")}
                      >
                        <Input placeholder="https://example.com" />
                      </Form.Item>
                      <Form.Item
                        name="seedPattern"
                        label={
                          seedMode === "list"
                            ? t("newsSources.fields.seedPatternList")
                            : t("newsSources.fields.seedPattern")
                        }
                        tooltip={t("newsSources.fields.seedPatternHint")}
                      >
                        <Input placeholder="*news*" />
                      </Form.Item>
                    </>
                  )}
                  <Form.Item
                    name="seedQuery"
                    label={t("newsSources.fields.seedQuery")}
                    tooltip={t("newsSources.fields.seedQueryHint")}
                  >
                    <Input
                      placeholder={t(
                        "newsSources.fields.seedQueryPlaceholder",
                      )}
                    />
                  </Form.Item>
                  <Form.Item
                    name="seedMaxUrls"
                    label={t("newsSources.fields.seedMaxUrls")}
                  >
                    <InputNumber min={1} max={2000} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="seedMaxNewUrlsPerRun"
                    label={t("newsSources.fields.seedMaxNewUrlsPerRun")}
                  >
                    <InputNumber min={1} max={500} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="seedScoreThreshold"
                    label={t("newsSources.fields.seedScoreThreshold")}
                    tooltip={t("newsSources.fields.seedScoreThresholdHint")}
                  >
                    <InputNumber
                      min={0}
                      max={1}
                      step={0.05}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="seedDedupeWindowHours"
                    label={t("newsSources.fields.seedDedupeWindowHours")}
                  >
                    <InputNumber min={0} max={720} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="seedQueryParamAllowlist"
                    label={t("newsSources.fields.seedQueryParamAllowlist")}
                    tooltip={t(
                      "newsSources.fields.seedQueryParamAllowlistHint",
                    )}
                  >
                    <Select
                      mode="tags"
                      tokenSeparators={[",", " ", "\n", "\t"]}
                      options={resolvedSeedRuntimeSettings.seedUrlQueryParamAllowlist.map(
                        (entry) => ({
                          label: entry,
                          value: entry,
                        }),
                      )}
                      placeholder={t(
                        "newsSources.fields.seedQueryParamAllowlistPlaceholder",
                      )}
                    />
                  </Form.Item>
                  <Space wrap size={[8, 8]} style={{ marginBottom: 8 }}>
                    <Tag color={seedCacheTtlInputDisabled ? "gold" : "blue"}>
                      {seedCacheTtlInputDisabled
                        ? t("newsSources.seedCachePolicy.globalForcedTag")
                        : t("newsSources.seedCachePolicy.sourceAwareTag")}
                    </Tag>
                    <Tag>
                      {t("newsSources.seedCachePolicy.sitemapRssTag", {
                        ttl: schedulerSitemapRssTtl,
                      })}
                    </Tag>
                    <Tag>
                      {t("newsSources.seedCachePolicy.listDeepTag", {
                        ttl: schedulerListDeepTtl,
                      })}
                    </Tag>
                  </Space>
                  {seedSchedulerSettingsLoadFailed ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t(
                        "newsSources.seedCachePolicy.loadFailedTitle",
                      )}
                      description={t(
                        "newsSources.seedCachePolicy.loadFailedDescription",
                      )}
                    />
                  ) : seedCacheTtlInputDisabled ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t(
                        "newsSources.seedCachePolicy.globalForcedTitle",
                      )}
                      description={t(
                        "newsSources.seedCachePolicy.globalForcedDescription",
                        {
                          sitemapRss: schedulerSitemapRssTtl,
                          listDeep: schedulerListDeepTtl,
                        },
                      )}
                    />
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t(
                        "newsSources.seedCachePolicy.sourceAwareTitle",
                      )}
                      description={t(
                        "newsSources.seedCachePolicy.sourceAwareDescription",
                        {
                          sitemapRss: schedulerSitemapRssTtl,
                          listDeep: schedulerListDeepTtl,
                        },
                      )}
                    />
                  )}
                  <Form.Item
                    name="seedCacheTtlSeconds"
                    label={t("newsSources.fields.seedCacheTtlSeconds")}
                    tooltip={t("newsSources.fields.seedCacheTtlSecondsHint")}
                    extra={t("newsSources.seedCachePolicy.effectiveTtlHint", {
                      ttl: resolvedSeedCachePolicy.effectiveCacheTtlSeconds,
                    })}
                  >
                    <InputNumber
                      min={10}
                      max={3600}
                      style={{ width: "100%" }}
                      disabled={seedCacheTtlInputDisabled}
                    />
                  </Form.Item>
                  <Form.Item
                    name="seedConcurrency"
                    label={t("newsSources.fields.seedConcurrency")}
                    tooltip={t("newsSources.fields.seedConcurrencyHint")}
                  >
                    <InputNumber min={1} max={10} style={{ width: "100%" }} />
                  </Form.Item>
                  {seedMode === "list" ? (
                    <>
                      <Form.Item
                        name="seedListMaxPages"
                        label={t("newsSources.fields.seedListMaxPages")}
                        tooltip={t("newsSources.fields.seedListMaxPagesHint")}
                      >
                        <InputNumber
                          min={1}
                          max={20}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="seedListPageConcurrency"
                        label={t("newsSources.fields.seedListPageConcurrency")}
                        tooltip={t(
                          "newsSources.fields.seedListPageConcurrencyHint",
                        )}
                      >
                        <InputNumber
                          min={1}
                          max={5}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="seedFollowPagination"
                        label={t("newsSources.fields.seedFollowPagination")}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedFollowPaginationHint",
                        )}
                      >
                        <Switch />
                      </Form.Item>
                    </>
                  ) : null}
                  {seedMode === "deep" ? (
                    <>
                      <Typography.Text type="secondary">
                        {t("newsSources.fields.seedDeepHint")}
                      </Typography.Text>
                      <Row gutter={[12, 0]}>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepMaxPages"
                            label={t("newsSources.fields.seedDeepMaxPages")}
                            tooltip={t(
                              "newsSources.fields.seedDeepMaxPagesHint",
                            )}
                          >
                            <InputNumber
                              min={5}
                              max={300}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepMaxDepth"
                            label={t("newsSources.fields.seedDeepMaxDepth")}
                            tooltip={t(
                              "newsSources.fields.seedDeepMaxDepthHint",
                            )}
                          >
                            <InputNumber
                              min={1}
                              max={4}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepTimeBudgetSeconds"
                            label={t(
                              "newsSources.fields.seedDeepTimeBudgetSeconds",
                            )}
                          >
                            <InputNumber
                              min={10}
                              max={180}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={[12, 0]}>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepPageConcurrency"
                            label={t(
                              "newsSources.fields.seedDeepPageConcurrency",
                            )}
                          >
                            <InputNumber
                              min={1}
                              max={6}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepScoreThreshold"
                            label={t(
                              "newsSources.fields.seedDeepScoreThreshold",
                            )}
                            tooltip={t(
                              "newsSources.fields.seedDeepScoreThresholdHint",
                            )}
                          >
                            <InputNumber
                              min={0}
                              max={1}
                              step={0.05}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={8}>
                          <Form.Item
                            name="seedDeepCandidatePoolSize"
                            label={t(
                              "newsSources.fields.seedDeepCandidatePoolSize",
                            )}
                          >
                            <InputNumber
                              min={20}
                              max={400}
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item
                        name="seedDeepHeadFetchTopK"
                        label={t("newsSources.fields.seedDeepHeadFetchTopK")}
                        tooltip={t(
                          "newsSources.fields.seedDeepHeadFetchTopKHint",
                        )}
                      >
                        <InputNumber
                          min={10}
                          max={120}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="seedDeepPreferPathDate"
                        label={t("newsSources.fields.seedDeepPreferPathDate")}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedDeepPreferPathDateHint",
                        )}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="seedDeepEnableSecondaryHubs"
                        label={t(
                          "newsSources.fields.seedDeepEnableSecondaryHubs",
                        )}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedDeepEnableSecondaryHubsHint",
                        )}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="seedDeepIgnoreRobotsTxt"
                        label={t("newsSources.fields.seedDeepIgnoreRobotsTxt")}
                        valuePropName="checked"
                        tooltip={t(
                          "newsSources.fields.seedDeepIgnoreRobotsTxtHint",
                        )}
                      >
                        <Switch disabled />
                      </Form.Item>
                    </>
                  ) : null}
                </div>
              );
            }}
          </Form.Item>
        </Modal>
      </Form>

      <Modal
        open={opmlModalOpen}
        title={t("newsSources.opml.title")}
        width={screens.md ? 1120 : "100%"}
        onCancel={() => {
          setOpmlModalOpen(false);
          setOpmlImportReport(null);
          setOpmlPreview(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setOpmlModalOpen(false);
                setOpmlImportReport(null);
                setOpmlPreview(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handlePreviewOpml()}
              loading={opmlPreviewing}
              disabled={
                opmlMode === "preset"
                  ? opmlPresetId.trim().length === 0
                  : opmlContent.trim().length === 0
              }
            >
              {t("newsSources.opml.actions.preview")}
            </Button>
            <Button
              type="primary"
              onClick={() => void handleImportOpml()}
              loading={opmlImporting}
              disabled={
                !opmlPreview ||
                opmlPreview.entries.filter((entry) => entry.enabled).length ===
                  0
              }
            >
              {t("newsSources.opml.actions.import")}
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message={t("newsSources.opml.hint.title")}
            description={t("newsSources.opml.hint.description")}
          />

          <Row gutter={[12, 12]}>
            <Col xs={24} md={8}>
              <Typography.Text strong>
                {t("newsSources.opml.fields.mode")}
              </Typography.Text>
              <Select<NewsSourceOpmlMode>
                style={{ width: "100%", marginTop: 6 }}
                value={opmlMode}
                onChange={handleOpmlModeChange}
                options={[
                  {
                    label: t("newsSources.opml.mode.preset"),
                    value: "preset",
                  },
                  {
                    label: t("newsSources.opml.mode.upload"),
                    value: "upload",
                  },
                ]}
              />
            </Col>
            <Col xs={24} md={16}>
              {opmlMode === "preset" ? (
                <>
                  <Typography.Text strong>
                    {t("newsSources.opml.fields.preset")}
                  </Typography.Text>
                  <Select
                    style={{ width: "100%", marginTop: 6 }}
                    loading={opmlLoadingPresets}
                    value={opmlPresetId}
                    onChange={(value) => {
                      setOpmlPresetId(value);
                      const preset = opmlPresets.find(
                        (item) => item.id === value,
                      );
                      if (preset?.defaultLanguage) {
                        setOpmlDefaultLanguage(preset.defaultLanguage);
                      }
                      setOpmlPreview(null);
                      setOpmlImportReport(null);
                    }}
                    options={opmlPresets.map((preset) => ({
                      label: `${preset.name} (${preset.entryCount})`,
                      value: preset.id,
                    }))}
                  />
                </>
              ) : (
                <>
                  <Typography.Text strong>
                    {t("newsSources.opml.fields.file")}
                  </Typography.Text>
                  <Input
                    style={{ marginTop: 6 }}
                    type="file"
                    accept=".opml,.xml,text/xml,application/xml"
                    onChange={(event) => void handleOpmlFileChange(event)}
                  />
                  {opmlFileName ? (
                    <Typography.Text type="secondary">
                      {t("newsSources.opml.fields.fileLoaded", {
                        name: opmlFileName,
                      })}
                    </Typography.Text>
                  ) : null}
                </>
              )}
            </Col>
          </Row>

          <Space wrap>
            <Input
              style={{ width: 220 }}
              value={opmlDefaultLanguage}
              onChange={(event) =>
                setOpmlDefaultLanguage(event.target.value.trim())
              }
              placeholder={t("newsSources.opml.fields.language")}
            />
            <Button onClick={handleApplyOpmlDefaultLanguage}>
              {t("newsSources.opml.actions.applyLanguage")}
            </Button>
          </Space>

          {opmlPreview ? (
            <Card size="small">
              <Space wrap>
                <Tag color="blue">
                  {t("newsSources.opml.summary.total", {
                    count: opmlPreview.summary.total,
                  })}
                </Tag>
                <Tag color="green">
                  {t("newsSources.opml.summary.valid", {
                    count: opmlPreview.summary.valid,
                  })}
                </Tag>
                <Tag color="gold">
                  {t("newsSources.opml.summary.duplicates", {
                    count: opmlPreview.summary.duplicates,
                  })}
                </Tag>
                <Tag color="purple">
                  {t("newsSources.opml.summary.enabled", {
                    count: opmlPreview.entries.filter((entry) => entry.enabled)
                      .length,
                  })}
                </Tag>
                {opmlPreview.title ? (
                  <Typography.Text type="secondary">
                    {t("newsSources.opml.summary.title", {
                      title: opmlPreview.title,
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            </Card>
          ) : null}

          {opmlImportReport ? (
            <Alert
              type={opmlImportReport.summary.failed > 0 ? "warning" : "success"}
              showIcon
              message={t("newsSources.opml.report.title")}
              description={t("newsSources.opml.report.summary", {
                created: opmlImportReport.summary.created,
                skipped: opmlImportReport.summary.skipped,
                failed: opmlImportReport.summary.failed,
              })}
            />
          ) : null}

          {opmlPreview ? (
            <Table
              rowKey={(record, index) =>
                `${record.url}-${record.feedUrl}-${index}`
              }
              size="small"
              pagination={{ pageSize: screens.md ? 12 : 6 }}
              dataSource={opmlPreview.entries}
              columns={[
                {
                  title: t("newsSources.opml.columns.import"),
                  width: 80,
                  render: (_value, record, index) => (
                    <Checkbox
                      checked={record.enabled}
                      disabled={!record.valid || record.alreadyExists}
                      onChange={(event) =>
                        updateOpmlPreviewEntry(index, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                  ),
                },
                {
                  title: t("newsSources.opml.columns.name"),
                  dataIndex: "name",
                  width: 220,
                },
                {
                  title: t("newsSources.opml.columns.siteUrl"),
                  dataIndex: "url",
                  ellipsis: true,
                },
                {
                  title: t("newsSources.opml.columns.feedUrl"),
                  dataIndex: "feedUrl",
                  ellipsis: true,
                },
                {
                  title: t("newsSources.opml.columns.language"),
                  width: 130,
                  render: (_value, record, index) => (
                    <Input
                      value={record.language}
                      disabled={!record.enabled}
                      onChange={(event) =>
                        updateOpmlPreviewEntry(index, {
                          language: event.target.value.trim(),
                        })
                      }
                    />
                  ),
                },
                {
                  title: t("newsSources.opml.columns.group"),
                  dataIndex: "group",
                  width: 130,
                  render: (group: string | null) =>
                    group ? <Tag>{group}</Tag> : null,
                },
                {
                  title: t("newsSources.opml.columns.status"),
                  width: 260,
                  render: (_value, record) => {
                    if (record.alreadyExists) {
                      return (
                        <Tag color="gold">
                          {t("newsSources.opml.status.duplicate")}
                        </Tag>
                      );
                    }
                    if (!record.valid) {
                      return (
                        <Typography.Text type="danger">
                          {record.errors.join("; ")}
                        </Typography.Text>
                      );
                    }
                    if (record.errors.length > 0) {
                      return (
                        <Typography.Text type="secondary">
                          {record.errors.join("; ")}
                        </Typography.Text>
                      );
                    }
                    return (
                      <Tag color="green">
                        {t("newsSources.opml.status.ready")}
                      </Tag>
                    );
                  },
                },
              ]}
            />
          ) : (
            <Typography.Text type="secondary">
              {t("newsSources.opml.empty")}
            </Typography.Text>
          )}
        </Space>
      </Modal>

      {canManage ? (
        <CreateCrawlTaskDrawer
          form={createDrawerForm}
          open={createDrawerOpen}
          loading={creatingFromTaskDrawer}
          canWriteItems={canWriteItems}
          title={t("newsSources.actions.new")}
          submitLabel={t("common.create")}
          defaultTemplateKey="news"
          onClose={closeCreateDrawer}
          onSubmit={handleCreateFromTaskDrawer}
        />
      ) : null}

      <Form<NewsSourceScheduleValues>
        form={scheduleForm}
        layout="vertical"
        onFinish={handleSchedule}
        component={false}
      >
        <Modal
          open={scheduleOpen}
          title={t("newsSources.schedule.title")}
          onCancel={closeSchedule}
          onOk={() => scheduleForm.submit()}
          okText={
            scheduleTargets.length > 1
              ? t("newsSources.actions.scheduleBatch", {
                  count: scheduleTargets.length,
                })
              : scheduleTargets[0]?.nextRunAt
                ? t("newsSources.actions.reschedule")
                : t("newsSources.actions.schedule")
          }
          okButtonProps={{ loading: scheduleLoading }}
          destroyOnHidden
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t(
              scheduleDeliveryMode === "rss"
                ? "newsSources.schedule.hintTitleRss"
                : scheduleDeliveryMode === "mixed"
                  ? "newsSources.schedule.hintTitleMixed"
                  : "newsSources.schedule.hintTitleCrawl4ai",
              {
                defaultValue:
                  scheduleDeliveryMode === "rss"
                    ? "Queued directly to pipeline"
                    : scheduleDeliveryMode === "mixed"
                      ? "Mixed scheduling modes"
                      : "Queued via crawl4ai",
              },
            )}
            description={t(
              scheduleDeliveryMode === "rss"
                ? "newsSources.schedule.descriptionRss"
                : scheduleDeliveryMode === "mixed"
                  ? "newsSources.schedule.descriptionMixed"
                  : "newsSources.schedule.descriptionCrawl4ai",
              {
                defaultValue:
                  scheduleDeliveryMode === "rss"
                    ? "Sets the next run time. The scheduler checks every 30 seconds, prefetches RSS feed entries, and queues pipeline jobs directly without creating Crawl4AI tasks."
                    : scheduleDeliveryMode === "mixed"
                      ? "Sets the next run time. RSS sources queue pipeline jobs directly, while other sources create CrawlTask jobs and run through Crawl4AI."
                      : "Sets the next run time. The scheduler checks every 30 seconds and enqueues a CrawlTask; crawl4ai limits concurrency to avoid blocking.",
              },
            )}
          />
          {scheduleTargets.some((target) => !target.isActive) ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t("newsSources.schedule.enablesSource", {
                count: scheduleTargets.filter((target) => !target.isActive)
                  .length,
              })}
            />
          ) : null}
          <Form.Item
            name="nextRunAt"
            label={t("newsSources.fields.nextRunAt")}
            rules={[
              { required: true },
              {
                validator: (_rule, value: Dayjs | undefined) => {
                  if (!value || !value.isValid()) {
                    return Promise.reject(
                      new Error(
                        t("newsSources.schedule.validation.invalid"),
                      ),
                    );
                  }
                  if (value.isBefore(dayjs())) {
                    return Promise.reject(
                      new Error(
                        t("newsSources.schedule.validation.future"),
                      ),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <DatePicker
              showTime
              allowClear={false}
              style={{ width: "100%" }}
              disabledDate={(current) =>
                Boolean(current && current.isBefore(dayjs().startOf("day")))
              }
            />
          </Form.Item>
          <Space wrap size={8} style={{ marginBottom: 8 }}>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(5, "minute"),
                })
              }
            >
              {t("newsSources.schedule.presets.in5m")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(30, "minute"),
                })
              }
            >
              {t("newsSources.schedule.presets.in30m")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(1, "hour"),
                })
              }
            >
              {t("newsSources.schedule.presets.in1h")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(1, "hour").startOf("hour"),
                })
              }
            >
              {t("newsSources.schedule.presets.nextHour")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                scheduleForm.setFieldsValue({
                  nextRunAt: dayjs().add(1, "day").startOf("day").hour(9),
                })
              }
            >
              {t("newsSources.schedule.presets.tomorrow9")}
            </Button>
            {scheduleTargets.length === 1 ? (
              <Button
                size="small"
                onClick={() =>
                  scheduleForm.setFieldsValue({
                    nextRunAt: dayjs().add(
                      scheduleTargets[0]!.frequencySeconds,
                      "second",
                    ),
                  })
                }
              >
                {t("newsSources.schedule.presets.nextInterval")}
              </Button>
            ) : null}
          </Space>
          {scheduleTargets.length > 1 ? (
            <Typography.Text type="secondary">
              {t("newsSources.schedule.selectedCount", {
                count: scheduleTargets.length,
              })}
            </Typography.Text>
          ) : scheduleTargets.length === 1 ? (
            <Typography.Text type="secondary">
              {t("newsSources.schedule.frequencyHint", {
                seconds: scheduleTargets[0]!.frequencySeconds,
              })}
            </Typography.Text>
          ) : null}
        </Modal>
      </Form>

      <Modal
        open={previewOpen}
        title={t("newsSources.preview.title")}
        width={screens.md ? 980 : "100%"}
        onCancel={() => {
          setPreviewOpen(false);
          setPreviewSource(null);
          setPreviewData(null);
        }}
        footer={
          <Space>
            {canManage ? (
              <Button
                onClick={() => handleScheduleFromPreview()}
                disabled={!previewSource}
              >
                {previewSource?.nextRunAt
                  ? t("newsSources.actions.reschedule")
                  : t("newsSources.actions.schedule")}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                type="primary"
                onClick={() => void handleRunNowFromPreview()}
                loading={previewRunNowLoading}
                disabled={!previewSource}
              >
                {t("newsSources.actions.runNow")}
              </Button>
            ) : null}
            <Button
              onClick={() => void reloadPreview()}
              loading={previewLoading}
              disabled={!previewSource}
            >
              {t("common.refresh")}
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setPreviewOpen(false);
                setPreviewSource(null);
                setPreviewData(null);
              }}
            >
              {t("common.close")}
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        {previewData ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {previewSource
              ? (() => {
                  const strategyTags = getCrawlStrategyTags(
                    previewSource.config,
                    t,
                  );
                  if (!strategyTags.length) {
                    return null;
                  }
                  return (
                    <Space wrap>
                      <Typography.Text type="secondary">
                        {t("newsSources.preview.strategy")}
                        :
                      </Typography.Text>
                      {strategyTags.map((tag) => (
                        <Tag key={"preview-" + tag.key} color={tag.color}>
                          {tag.label}
                        </Tag>
                      ))}
                    </Space>
                  );
                })()
              : null}
            <Space wrap>
              <Tag
                color={
                  previewData.mode === "sitemap"
                    ? "purple"
                    : previewData.mode === "rss"
                      ? "blue"
                      : previewData.mode === "list"
                        ? "gold"
                        : previewData.mode === "deep"
                          ? "geekblue"
                          : "default"
                }
              >
                {previewData.mode === "sitemap"
                  ? t("newsSources.preview.modeSitemap")
                  : previewData.mode === "rss"
                    ? t("newsSources.preview.modeRss")
                    : previewData.mode === "list"
                      ? t("newsSources.preview.modeList")
                      : previewData.mode === "deep"
                        ? t("newsSources.preview.modeDeep")
                        : t("newsSources.preview.modeSingle")}
              </Tag>
              <Typography.Text>
                {t("newsSources.preview.scheduleCount", {
                  count: previewData.scheduleCount,
                })}
              </Typography.Text>
              {typeof previewData.availableToSchedule === "number" ? (
                <Typography.Text type="secondary">
                  {t("newsSources.preview.availableToSchedule", {
                    count: previewData.availableToSchedule,
                  })}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {t("newsSources.preview.skippedCount", {
                  count: previewData.skippedCount,
                })}
              </Typography.Text>
              {typeof previewData.inFlightCount === "number" &&
              typeof previewData.inFlightLimit === "number" ? (
                <Typography.Text type="secondary">
                  {t("newsSources.preview.inFlightCount", {
                    count: previewData.inFlightCount,
                    limit: previewData.inFlightLimit,
                  })}
                </Typography.Text>
              ) : null}
            </Space>

            {previewData.mode === "deep" &&
            (previewData.deepPreviewError || previewData.deepFailureStats) ? (
              <Card
                size="small"
                title={t("newsSources.preview.deepFailure.title")}
              >
                {previewData.deepPreviewError ? (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={`${previewData.deepPreviewError.code}: ${previewData.deepPreviewError.message}`}
                    description={previewData.deepPreviewError.detail}
                  />
                ) : null}
                <Row gutter={[12, 12]}>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("newsSources.preview.deepFailure.total24h")}
                      value={previewData.deepFailureStats?.total24h ?? 0}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("newsSources.preview.deepFailure.streak")}
                      value={previewData.deepFailureStats?.streak ?? 0}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t("newsSources.preview.deepFailure.nextRetryAt")}
                      value={
                        previewData.deepFailureStats?.nextRetryAt
                          ? formatDateTime(
                              previewData.deepFailureStats.nextRetryAt,
                              locale,
                              {
                                dateStyle: "medium",
                                timeStyle: "short",
                              },
                            )
                          : "-"
                      }
                    />
                  </Col>
                </Row>
                {previewData.deepFailureStats?.byCode?.length ? (
                  <Space wrap style={{ marginTop: 12 }}>
                    {previewData.deepFailureStats.byCode.map((entry) => (
                      <Tag color="red" key={`deep-failure-code-${entry.code}`}>
                        {entry.code}: {entry.count}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {previewData.deepFailureStats?.lastFailureAt ? (
                  <Typography.Text
                    type="secondary"
                    style={{ display: "block", marginTop: 8 }}
                  >
                    {t("newsSources.preview.deepFailure.lastFailureAt", {
                      time: formatDateTime(
                        previewData.deepFailureStats.lastFailureAt,
                        locale,
                        {
                          dateStyle: "medium",
                          timeStyle: "short",
                        },
                      ),
                    })}
                  </Typography.Text>
                ) : null}
              </Card>
            ) : null}

            <Table
              rowKey="url"
              size="small"
              loading={previewLoading}
              columns={previewColumns}
              dataSource={previewData.candidates}
              pagination={{ pageSize: screens.md ? 10 : 5 }}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {previewLoading
              ? t("newsSources.preview.loading")
              : t("newsSources.preview.empty")}
          </Typography.Text>
        )}
      </Modal>

    </>
  );
}

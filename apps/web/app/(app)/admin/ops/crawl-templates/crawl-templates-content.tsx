"use client";

import {
  CRAWL4AI_LLM_OPTION_GUARD_MESSAGE,
  assertNoCrawl4aiLlmOptions,
} from "@modular/utils";
import {
  Alert,
  Button,
  Card,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { applyAutoBrowserHeadersToCrawlOptions } from "@/lib/crawl-browser-headers";
import { findUnsupportedProxyIssues } from "@/lib/crawl-config-policy";
import {
  applyHeadlessModeToCrawlOptions,
  resolveHeadlessModeFromHeadlessValue,
} from "@/lib/crawl-headless-mode";

interface CrawlTemplateRecord {
  id: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  crawlOptions?: Record<string, unknown> | null;
}

interface CrawlTemplateFormValues {
  name: string;
  description?: string;
  isActive: boolean;
  userAgent?: string;
  headlessMode?: "auto" | "headless" | "headed";
  antiBotMode?: "auto" | "enabled" | "disabled";
  enableStealthMode: boolean;
  enableUndetectedBrowser: boolean;
  includeImages: boolean;
  qualityProfile?: "balanced" | "quality_first" | "speed_first";
  pageTypeHint?: "auto" | "list" | "detail";
  autoExpandDetails: boolean;
  maxDetailUrls?: number;
  minRelevanceScore?: number;
  requireSameDomain: boolean;
  allowExternalLinks: boolean;
  minPublishTimeConfidence?: number;
  preferFitMarkdownForQuality: boolean;
  includeUrlPatterns?: string;
  excludeUrlPatterns?: string;
  crawlOptionsJson?: string;
}

const parseJsonField = (value: string | undefined, label: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : `${label} must be a valid JSON object`,
    );
  }
};

const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const normalizeBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : false;

const normalizeOptions = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parsePatternText = (value: string | undefined): string[] | undefined => {
  const normalized = (value ?? "")
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) {
    return undefined;
  }
  const unique: string[] = [];
  for (const pattern of normalized) {
    if (!unique.includes(pattern)) {
      unique.push(pattern);
    }
    if (unique.length >= 25) {
      break;
    }
  }
  return unique.length > 0 ? unique : undefined;
};

const stringifyPatternList = (value: unknown): string => {
  if (!Array.isArray(value)) {
    return "";
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized.join("\n") : "";
};

export function CrawlTemplatesContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<CrawlTemplateRecord[]>([]);
  const [search, setSearch] = useState("");
  const [modalState, setModalState] = useState<{
    open: boolean;
    editing: CrawlTemplateRecord | null;
    initialValues: Partial<CrawlTemplateFormValues>;
  }>({ open: false, editing: null, initialValues: {} });
  const screens = Grid.useBreakpoint();
  const formId = "crawl-template-form";

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<CrawlTemplateRecord[]>(
        "admin/crawl-templates",
        {
          params: { search: search.trim() || undefined },
        },
      );
      setTemplates(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl templates", error);
      messageApi.error(
        t("crawlTemplates.errors.loadFailed", {
          defaultValue: "Failed to load crawl templates.",
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, messageApi, search, t]);

  useEffect(() => {
    if (canView) {
      void loadTemplates();
    }
  }, [canView, loadTemplates]);

  const openCreate = () => {
    setModalState({
      open: true,
      editing: null,
      initialValues: {
        isActive: true,
        headlessMode: "auto",
        antiBotMode: "auto",
        enableStealthMode: false,
        enableUndetectedBrowser: false,
        includeImages: true,
        qualityProfile: "quality_first",
        pageTypeHint: "auto",
        autoExpandDetails: false,
        requireSameDomain: true,
        allowExternalLinks: true,
        minPublishTimeConfidence: 0.55,
        preferFitMarkdownForQuality: true,
        includeUrlPatterns: "",
        excludeUrlPatterns: "",
        crawlOptionsJson: "{}",
      },
    });
  };

  const openEdit = (template: CrawlTemplateRecord) => {
    const options = normalizeOptions(template.crawlOptions);
    const headlessMode = resolveHeadlessModeFromHeadlessValue(
      options?.headless,
    );
    const antiBotModeRaw =
      typeof options?.antiBotMode === "string"
        ? options.antiBotMode.trim().toLowerCase()
        : "";
    const antiBotMode =
      antiBotModeRaw === "enabled" ||
      antiBotModeRaw === "disabled" ||
      antiBotModeRaw === "auto"
        ? (antiBotModeRaw as "auto" | "enabled" | "disabled")
        : "auto";
    const detailExpansionOptions =
      options?.detailExpansion &&
      typeof options.detailExpansion === "object" &&
      !Array.isArray(options.detailExpansion)
        ? (options.detailExpansion as Record<string, unknown>)
        : null;
    const maxDetailUrls =
      typeof detailExpansionOptions?.maxDetailUrls === "number" &&
      Number.isFinite(detailExpansionOptions.maxDetailUrls)
        ? detailExpansionOptions.maxDetailUrls
        : undefined;
    const minRelevanceScore =
      typeof detailExpansionOptions?.minRelevanceScore === "number" &&
      Number.isFinite(detailExpansionOptions.minRelevanceScore)
        ? detailExpansionOptions.minRelevanceScore
        : undefined;
    const minPublishTimeConfidence =
      typeof detailExpansionOptions?.minPublishTimeConfidence === "number" &&
      Number.isFinite(detailExpansionOptions.minPublishTimeConfidence)
        ? detailExpansionOptions.minPublishTimeConfidence
        : 0.55;
    setModalState({
      open: true,
      editing: template,
      initialValues: {
        name: template.name,
        description: template.description ?? "",
        isActive: template.isActive,
        userAgent: normalizeString(options?.userAgent),
        headlessMode,
        antiBotMode,
        enableStealthMode: normalizeBoolean(options?.enableStealthMode),
        enableUndetectedBrowser: normalizeBoolean(
          options?.enableUndetectedBrowser,
        ),
        includeImages: options?.includeImages === false ? false : true,
        qualityProfile:
          options?.qualityProfile === "quality_first" ||
          options?.qualityProfile === "balanced" ||
          options?.qualityProfile === "speed_first"
            ? options.qualityProfile
            : "quality_first",
        pageTypeHint:
          options?.pageTypeHint === "auto" ||
          options?.pageTypeHint === "list" ||
          options?.pageTypeHint === "detail"
            ? options.pageTypeHint
            : "auto",
        autoExpandDetails: normalizeBoolean(options?.autoExpandDetails),
        maxDetailUrls,
        minRelevanceScore,
        requireSameDomain:
          typeof detailExpansionOptions?.requireSameDomain === "boolean"
            ? detailExpansionOptions.requireSameDomain
            : true,
        allowExternalLinks:
          typeof detailExpansionOptions?.allowExternalLinks === "boolean"
            ? detailExpansionOptions.allowExternalLinks
            : true,
        minPublishTimeConfidence,
        preferFitMarkdownForQuality:
          typeof detailExpansionOptions?.preferFitMarkdownForQuality ===
          "boolean"
            ? detailExpansionOptions.preferFitMarkdownForQuality
            : true,
        includeUrlPatterns: stringifyPatternList(
          detailExpansionOptions?.includeUrlPatterns,
        ),
        excludeUrlPatterns: stringifyPatternList(
          detailExpansionOptions?.excludeUrlPatterns,
        ),
        crawlOptionsJson: options ? JSON.stringify(options, null, 2) : "{}",
      },
    });
  };

  const buildCrawlOptions = (values: CrawlTemplateFormValues) => {
    const base = parseJsonField(values.crawlOptionsJson, "crawlOptions") ?? {};
    const proxyIssues = findUnsupportedProxyIssues(base, "crawlOptions");
    if (proxyIssues.length > 0) {
      throw new Error(proxyIssues.map((issue) => issue.path).join(", "));
    }
    assertNoCrawl4aiLlmOptions(base, "crawlOptions");

    const userAgent = values.userAgent?.trim() ?? "";
    if (userAgent) {
      base.userAgent = userAgent;
    } else {
      delete base.userAgent;
    }

    applyHeadlessModeToCrawlOptions(base, values.headlessMode);

    if (values.enableStealthMode) {
      base.enableStealthMode = true;
    } else {
      delete base.enableStealthMode;
    }

    if (values.enableUndetectedBrowser) {
      base.enableUndetectedBrowser = true;
    } else {
      delete base.enableUndetectedBrowser;
    }

    if (values.antiBotMode === "enabled" || values.antiBotMode === "disabled") {
      base.antiBotMode = values.antiBotMode;
    } else {
      delete base.antiBotMode;
    }

    if (values.includeImages === false) {
      base.includeImages = false;
    } else {
      delete base.includeImages;
    }

    if (
      values.qualityProfile === "quality_first" ||
      values.qualityProfile === "balanced" ||
      values.qualityProfile === "speed_first"
    ) {
      base.qualityProfile = values.qualityProfile;
    } else {
      delete base.qualityProfile;
    }

    if (
      values.pageTypeHint === "auto" ||
      values.pageTypeHint === "list" ||
      values.pageTypeHint === "detail"
    ) {
      base.pageTypeHint = values.pageTypeHint;
    } else {
      delete base.pageTypeHint;
    }

    if (values.autoExpandDetails) {
      base.autoExpandDetails = true;
      const detailExpansion: Record<string, unknown> = {};
      if (
        typeof values.maxDetailUrls === "number" &&
        Number.isFinite(values.maxDetailUrls)
      ) {
        detailExpansion.maxDetailUrls = Math.max(
          1,
          Math.min(30, Math.round(values.maxDetailUrls)),
        );
      }
      if (
        typeof values.minRelevanceScore === "number" &&
        Number.isFinite(values.minRelevanceScore)
      ) {
        detailExpansion.minRelevanceScore = Number(
          Math.max(0, Math.min(1, values.minRelevanceScore)).toFixed(3),
        );
      }
      if (typeof values.requireSameDomain === "boolean") {
        detailExpansion.requireSameDomain = values.requireSameDomain;
      }
      if (typeof values.allowExternalLinks === "boolean") {
        detailExpansion.allowExternalLinks = values.allowExternalLinks;
      }
      if (
        typeof values.minPublishTimeConfidence === "number" &&
        Number.isFinite(values.minPublishTimeConfidence)
      ) {
        detailExpansion.minPublishTimeConfidence = Number(
          Math.max(0, Math.min(1, values.minPublishTimeConfidence)).toFixed(3),
        );
      }
      if (typeof values.preferFitMarkdownForQuality === "boolean") {
        detailExpansion.preferFitMarkdownForQuality =
          values.preferFitMarkdownForQuality;
      }
      const includeUrlPatterns = parsePatternText(values.includeUrlPatterns);
      if (includeUrlPatterns && includeUrlPatterns.length > 0) {
        detailExpansion.includeUrlPatterns = includeUrlPatterns;
      }
      const excludeUrlPatterns = parsePatternText(values.excludeUrlPatterns);
      if (excludeUrlPatterns && excludeUrlPatterns.length > 0) {
        detailExpansion.excludeUrlPatterns = excludeUrlPatterns;
      }
      if (Object.keys(detailExpansion).length > 0) {
        base.detailExpansion = detailExpansion;
      } else {
        delete base.detailExpansion;
      }
    } else {
      delete base.autoExpandDetails;
      delete base.detailExpansion;
    }

    assertNoCrawl4aiLlmOptions(base, "crawlOptions");

    return Object.keys(base).length ? base : null;
  };

  const handleSubmit = async (values: CrawlTemplateFormValues) => {
    setSaving(true);
    try {
      const crawlOptions = buildCrawlOptions(values);
      const payload = {
        name: values.name,
        description: values.description?.trim() ?? "",
        isActive: values.isActive,
        crawlOptions,
      };
      const currentEditing = modalState.editing;
      if (currentEditing) {
        await apiClient.patch(
          `admin/crawl-templates/${currentEditing.id}`,
          payload,
        );
      } else {
        await apiClient.post("admin/crawl-templates", payload);
      }
      messageApi.success(
        currentEditing
          ? t("crawlTemplates.messages.updated", {
              defaultValue: "Template updated.",
            })
          : t("crawlTemplates.messages.created", {
              defaultValue: "Template created.",
            }),
      );
      setModalState({ open: false, editing: null, initialValues: {} });
      await loadTemplates();
    } catch (error) {
      captureClientError("Failed to save crawl template", error);
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawlTemplates.errors.saveFailed", {
              defaultValue: "Failed to save crawl template.",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (template: CrawlTemplateRecord) => {
    Modal.confirm({
      title: t("crawlTemplates.delete.title", {
        defaultValue: "Delete template?",
      }),
      content: t("crawlTemplates.delete.description", {
        defaultValue: "News sources using this template will stop applying it.",
      }),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiClient.delete(`admin/crawl-templates/${template.id}`);
          await loadTemplates();
          messageApi.success(
            t("crawlTemplates.messages.deleted", {
              defaultValue: "Template deleted.",
            }),
          );
        } catch (error) {
          captureClientError("Failed to delete crawl template", error);
          messageApi.error(
            t("crawlTemplates.errors.deleteFailed", {
              defaultValue: "Failed to delete template.",
            }),
          );
        }
      },
    });
  };

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading..." })}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("crawlTemplates.title", { defaultValue: "Crawl Templates" })}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const renderTemplateStrategy = (record: CrawlTemplateRecord): ReactNode => {
    const options = normalizeOptions(record.crawlOptions);
    if (!options) {
      return (
        <Typography.Text type="secondary">
          {t("common.emptyValue")}
        </Typography.Text>
      );
    }

    const tags: ReactNode[] = [];

    if (options.scanFullPage === true) {
      tags.push(
        <Tag key="scanFullPage" color="blue">
          {t("crawl.settings.scanFullPage")}
        </Tag>,
      );
    }

    if (options.antiBotMode === "enabled") {
      tags.push(
        <Tag key="antiBotMode" color="volcano">
          {t("crawlTemplates.fields.antiBotModeEnabled", {
            defaultValue: "Anti-bot retry: Enabled",
          })}
        </Tag>,
      );
    } else if (options.antiBotMode === "disabled") {
      tags.push(
        <Tag key="antiBotMode" color="default">
          {t("crawlTemplates.fields.antiBotModeDisabled", {
            defaultValue: "Anti-bot retry: Disabled",
          })}
        </Tag>,
      );
    }

    if (
      options.virtualScroll &&
      typeof options.virtualScroll === "object" &&
      !Array.isArray(options.virtualScroll)
    ) {
      tags.push(
        <Tag key="virtualScroll" color="cyan">
          {t("crawl.virtualScroll.title")}
        </Tag>,
      );
    }

    if (options.qualityProfile === "quality_first") {
      tags.push(
        <Tag key="qualityProfile" color="purple">
          {t("crawl.settings.qualityProfileOptions.qualityFirst")}
        </Tag>,
      );
    } else if (options.qualityProfile === "balanced") {
      tags.push(
        <Tag key="qualityProfile" color="purple">
          {t("crawl.settings.qualityProfileOptions.balanced")}
        </Tag>,
      );
    } else if (options.qualityProfile === "speed_first") {
      tags.push(
        <Tag key="qualityProfile" color="purple">
          {t("crawl.settings.qualityProfileOptions.speedFirst")}
        </Tag>,
      );
    }

    if (options.pageTypeHint === "auto") {
      tags.push(
        <Tag key="pageTypeHint" color="magenta">
          {t("crawl.settings.pageTypeHintOptions.auto")}
        </Tag>,
      );
    } else if (options.pageTypeHint === "list") {
      tags.push(
        <Tag key="pageTypeHint" color="magenta">
          {t("crawl.settings.pageTypeHintOptions.list")}
        </Tag>,
      );
    } else if (options.pageTypeHint === "detail") {
      tags.push(
        <Tag key="pageTypeHint" color="magenta">
          {t("crawl.settings.pageTypeHintOptions.detail")}
        </Tag>,
      );
    }

    if (options.autoExpandDetails === true) {
      tags.push(
        <Tag key="autoExpandDetails" color="green">
          {t("crawl.settings.autoExpandDetails")}
        </Tag>,
      );
    }

    const markdownOptions =
      options.markdownOptions &&
      typeof options.markdownOptions === "object" &&
      !Array.isArray(options.markdownOptions)
        ? (options.markdownOptions as Record<string, unknown>)
        : null;
    if (markdownOptions?.contentSource === "cleaned_html") {
      tags.push(
        <Tag key="ragReady" color="geekblue">
          {t("crawl.markdown.ragReadyTitle")}
        </Tag>,
      );
    }

    return tags.length ? (
      <Space wrap size={[4, 4]}>
        {tags}
      </Space>
    ) : (
      <Typography.Text type="secondary">
        {t("crawlTemplates.columns.strategyEmpty", { defaultValue: "Default" })}
      </Typography.Text>
    );
  };

  const columns: ColumnsType<CrawlTemplateRecord> = [
    {
      title: t("crawlTemplates.columns.name", { defaultValue: "Name" }),
      dataIndex: "name",
      key: "name",
      render: (value: string, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{value}</Typography.Text>
          {record.description ? (
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: record.description }}
            >
              {record.description}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("crawlTemplates.columns.strategy", { defaultValue: "Strategy" }),
      key: "strategy",
      render: (_: unknown, record) => renderTemplateStrategy(record),
    },
    {
      title: t("crawlTemplates.columns.status", { defaultValue: "Status" }),
      dataIndex: "isActive",
      key: "isActive",
      render: (value: boolean) => (
        <Tag color={value ? "green" : "default"}>
          {value
            ? t("common.enabled", { defaultValue: "Enabled" })
            : t("common.disabled", { defaultValue: "Disabled" })}
        </Tag>
      ),
    },
    {
      title: t("common.actions", { defaultValue: "Actions" }),
      key: "actions",
      render: (_, record) => (
        <Space>
          {canManage ? (
            <Button size="small" onClick={() => openEdit(record)}>
              {t("common.edit", { defaultValue: "Edit" })}
            </Button>
          ) : null}
          {canManage ? (
            <Button size="small" danger onClick={() => handleDelete(record)}>
              {t("common.delete", { defaultValue: "Delete" })}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("crawlTemplates.title", { defaultValue: "Crawl Templates" })}
        extra={
          canManage ? (
            <Button type="primary" onClick={openCreate}>
              {t("crawlTemplates.actions.new", {
                defaultValue: "New template",
              })}
            </Button>
          ) : null
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Input
            id="crawl-templates-search"
            name="crawlTemplatesSearch"
            placeholder={t("crawlTemplates.searchPlaceholder", {
              defaultValue: "Search templates",
            })}
            allowClear
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onPressEnter={() => void loadTemplates()}
          />
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={templates}
            pagination={{
              pageSize: screens.md ? 10 : 5,
              showSizeChanger: screens.md,
            }}
          />
        </Space>
      </Card>

      <Modal
        open={modalState.open}
        title={
          modalState.editing
            ? t("crawlTemplates.actions.edit", {
                defaultValue: "Edit template",
              })
            : t("crawlTemplates.actions.new", { defaultValue: "New template" })
        }
        onCancel={() => {
          setModalState({ open: false, editing: null, initialValues: {} });
        }}
        okButtonProps={{ loading: saving, htmlType: "submit", form: formId }}
        destroyOnHidden
      >
        <Form
          key={
            modalState.open ? (modalState.editing?.id ?? "create") : "closed"
          }
          id={formId}
          layout="vertical"
          initialValues={modalState.initialValues}
          onFinish={handleSubmit}
        >
          <Form.Item
            name="name"
            label={t("crawlTemplates.fields.name", { defaultValue: "Name" })}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="description"
            label={t("crawlTemplates.fields.description", {
              defaultValue: "Description",
            })}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="isActive"
            label={t("crawlTemplates.fields.active", {
              defaultValue: "Active",
            })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t("crawlTemplates.sections.commonOptions", {
              defaultValue: "Common Options",
            })}
          </Typography.Title>

          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Custom upstream proxies are disabled"
            description="Do not store proxyUrl or proxyConfig in template crawlOptions. Legacy proxy fields remain visible in JSON and block save until removed."
          />
          <Form.Item
            name="userAgent"
            label={t("crawlTemplates.fields.userAgent", {
              defaultValue: "User Agent",
            })}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="headlessMode"
            label={t("crawlTemplates.fields.headless", {
              defaultValue: "Headless mode",
            })}
            tooltip={t("crawlTemplates.fields.headlessHint", {
              defaultValue:
                "Headed mode (headless=false) may require Xvfb/DISPLAY in the crawl4ai container; if you see 'cannot open display' errors, switch back to Headless or enable Xvfb in docker-compose.",
            })}
          >
            <Select
              options={[
                {
                  value: "auto",
                  label: t("crawlTemplates.headless.auto", {
                    defaultValue: "Auto",
                  }),
                },
                {
                  value: "headless",
                  label: t("crawlTemplates.headless.headless", {
                    defaultValue: "Headless",
                  }),
                },
                {
                  value: "headed",
                  label: t("crawlTemplates.headless.headed", {
                    defaultValue: "Headed (Xvfb)",
                  }),
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="enableStealthMode"
            label={t("crawlTemplates.fields.stealth", {
              defaultValue: "Stealth mode",
            })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="enableUndetectedBrowser"
            label={t("crawlTemplates.fields.undetected", {
              defaultValue: "Undetected browser",
            })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="antiBotMode"
            label={t("crawlTemplates.fields.antiBotMode", {
              defaultValue: "Anti-bot retry mode",
            })}
            tooltip={t("crawlTemplates.fields.antiBotModeHint", {
              defaultValue:
                "Auto removes crawlOptions.antiBotMode. Enabled/Disabled explicitly control anti-bot retry when failures occur.",
            })}
          >
            <Select
              options={[
                {
                  value: "auto",
                  label: t("crawlTemplates.triState.auto", {
                    defaultValue: "Auto (inherit)",
                  }),
                },
                {
                  value: "enabled",
                  label: t("crawlTemplates.triState.enable", {
                    defaultValue: "Enabled",
                  }),
                },
                {
                  value: "disabled",
                  label: t("crawlTemplates.triState.disable", {
                    defaultValue: "Disabled",
                  }),
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="includeImages"
            label={t("crawlTemplates.fields.images", {
              defaultValue: "Include images",
            })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="qualityProfile"
            label={t("crawlTemplates.fields.qualityProfile", {
              defaultValue: "Quality profile",
            })}
          >
            <Select
              options={[
                {
                  value: "quality_first",
                  label: t(
                    "crawl.settings.qualityProfileOptions.qualityFirst",
                    {
                      defaultValue: "Quality first (RAG)",
                    },
                  ),
                },
                {
                  value: "balanced",
                  label: t("crawl.settings.qualityProfileOptions.balanced", {
                    defaultValue: "Balanced",
                  }),
                },
                {
                  value: "speed_first",
                  label: t("crawl.settings.qualityProfileOptions.speedFirst", {
                    defaultValue: "Speed first",
                  }),
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="pageTypeHint"
            label={t("crawlTemplates.fields.pageTypeHint", {
              defaultValue: "Page type hint",
            })}
          >
            <Select
              options={[
                {
                  value: "auto",
                  label: t("crawl.settings.pageTypeHintOptions.auto", {
                    defaultValue: "Auto detect",
                  }),
                },
                {
                  value: "list",
                  label: t("crawl.settings.pageTypeHintOptions.list", {
                    defaultValue: "List page",
                  }),
                },
                {
                  value: "detail",
                  label: t("crawl.settings.pageTypeHintOptions.detail", {
                    defaultValue: "Detail page",
                  }),
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="autoExpandDetails"
            label={t("crawlTemplates.fields.autoExpandDetails", {
              defaultValue: "Auto expand details",
            })}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) =>
              prev.autoExpandDetails !== next.autoExpandDetails
            }
          >
            {({ getFieldValue }) =>
              getFieldValue("autoExpandDetails") ? (
                <>
                  <Form.Item
                    name="maxDetailUrls"
                    label={t("crawl.detailExpansion.maxDetailUrls", {
                      defaultValue: "Max detail URLs",
                    })}
                  >
                    <InputNumber min={1} max={30} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="minRelevanceScore"
                    label={t("crawl.detailExpansion.minRelevanceScore", {
                      defaultValue: "Min relevance score",
                    })}
                  >
                    <InputNumber
                      min={0}
                      max={1}
                      step={0.01}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="requireSameDomain"
                    label={t("crawl.detailExpansion.requireSameDomain", {
                      defaultValue: "Require same domain",
                    })}
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    name="allowExternalLinks"
                    label={t("crawl.detailExpansion.allowExternalLinks", {
                      defaultValue: "Allow external links",
                    })}
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    name="minPublishTimeConfidence"
                    label={t(
                      "crawl.detailExpansion.minPublishTimeConfidence",
                      {
                        defaultValue: "Min publish time confidence",
                      },
                    )}
                    tooltip={t(
                      "crawl.detailExpansion.minPublishTimeConfidenceHint",
                      {
                        defaultValue:
                          "Only prioritize links that look like publish-time-stamped detail pages (0~1).",
                      },
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
                    name="preferFitMarkdownForQuality"
                    label={t(
                      "crawl.detailExpansion.preferFitMarkdownForQuality",
                      {
                        defaultValue: "Prefer fit markdown for quality",
                      },
                    )}
                    tooltip={t(
                      "crawl.detailExpansion.preferFitMarkdownForQualityHint",
                      {
                        defaultValue:
                          "Use fit_markdown first when evaluating low-signal/list-like pages.",
                      },
                    )}
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    name="excludeUrlPatterns"
                    label={t("crawl.detailExpansion.excludeUrlPatterns", {
                      defaultValue: "Exclude URL patterns",
                    })}
                    tooltip={t("crawl.detailExpansion.excludeUrlPatternsHint", {
                      defaultValue:
                        "One pattern per line. Supports wildcard * and regex /.../.",
                    })}
                  >
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
                  </Form.Item>
                  <Form.Item
                    name="includeUrlPatterns"
                    label={t("crawl.detailExpansion.includeUrlPatterns", {
                      defaultValue: "Include URL patterns",
                    })}
                    tooltip={t("crawl.detailExpansion.includeUrlPatternsHint", {
                      defaultValue:
                        "Optional allowlist. If set, only URLs matching these patterns are followed.",
                    })}
                  >
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
                  </Form.Item>
                </>
              ) : null
            }
          </Form.Item>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("crawlTemplates.hints.noLlmTitle", {
              defaultValue: "No LLM in crawl stage",
            })}
            description={t("crawlTemplates.hints.noLlmDescription", {
              defaultValue: CRAWL4AI_LLM_OPTION_GUARD_MESSAGE,
            })}
          />
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue, setFieldsValue }) => (
              <Space style={{ marginBottom: 8 }}>
                <Button
                  size="small"
                  onClick={() => {
                    try {
                      const currentRaw = getFieldValue("crawlOptionsJson") as
                        | string
                        | undefined;
                      const current =
                        parseJsonField(currentRaw, "crawlOptions") ?? {};
                      const explicitUserAgent = normalizeString(
                        getFieldValue("userAgent"),
                      );
                      const sourceOptions: Record<string, unknown> = {
                        ...current,
                      };
                      if (explicitUserAgent) {
                        sourceOptions.userAgent = explicitUserAgent;
                      } else {
                        delete sourceOptions.userAgent;
                      }
                      const next =
                        applyAutoBrowserHeadersToCrawlOptions(sourceOptions);
                      setFieldsValue({
                        crawlOptionsJson: JSON.stringify(next, null, 2),
                      });
                    } catch (error) {
                      messageApi.error(
                        error instanceof Error
                          ? error.message
                          : t("common.operationFailed", {
                              defaultValue: "Operation failed.",
                            }),
                      );
                    }
                  }}
                >
                  {t("crawl.browser.headers.autoFillSecCh", {
                    defaultValue: "Auto-fill Sec-CH headers",
                  })}
                </Button>
                <Typography.Text type="secondary">
                  {t("crawl.browser.headers.autoFillSecChHint", {
                    defaultValue:
                      "Adds sec-fetch defaults and, when User-Agent is deterministic Chromium, matching sec-ch headers if missing.",
                  })}
                </Typography.Text>
              </Space>
            )}
          </Form.Item>
          <Form.Item
            name="crawlOptionsJson"
            label={t("crawlTemplates.fields.advancedJson", {
              defaultValue: "Advanced crawl options (JSON)",
            })}
            validateTrigger="onBlur"
            rules={[
              {
                validator: async (_rule, value) => {
                  const trimmed = typeof value === "string" ? value.trim() : "";
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
                    "crawlOptions",
                  );
                  if (proxyIssues.length > 0) {
                    throw new Error(
                      proxyIssues.map((issue) => issue.path).join(", "),
                    );
                  }
                  assertNoCrawl4aiLlmOptions(parsed, "crawlOptions");
                },
              },
            ]}
          >
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

"use client";

import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { gql, useMutation, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Spin,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

interface NewsDedupeScopedThresholdModel {
  sourceId: string | null;
  language: string | null;
  categoryPath: string | null;
  threshold: number;
}

interface NewsDedupeSettingsModel {
  defaultThreshold: number;
  useEmbeddings: boolean;
  llmJudgeInstructions: string | null;
  llmJudgeModel: string | null;
  llmJudgeConcurrency: number;
  llmJudgeMaxComparisons: number;
  llmJudgeCandidateChars: number;
  llmJudgePromptVersion: string;
  llmJudgeSystemPromptTemplate: string;
  llmJudgeUserPromptTemplate: string;
  scopedThresholds: NewsDedupeScopedThresholdModel[];
}

interface QueryData {
  newsDedupeSettings: NewsDedupeSettingsModel;
}

interface MutationData {
  updateNewsDedupeSettings: NewsDedupeSettingsModel;
}

interface FormValues {
  defaultThreshold: number;
  useEmbeddings: boolean;
  llmJudgeInstructions: string | null;
  llmJudgeModel: string | null;
  llmJudgeConcurrency: number | null;
  llmJudgeMaxComparisons: number | null;
  llmJudgeCandidateChars: number | null;
  llmJudgePromptVersion: string | null;
  llmJudgeSystemPromptTemplate: string | null;
  llmJudgeUserPromptTemplate: string | null;
  scopedThresholds: NewsDedupeScopedThresholdModel[];
}

interface UpdateNewsDedupeSettingsInput {
  defaultThreshold: number;
  useEmbeddings: boolean;
  scopedThresholds: NewsDedupeScopedThresholdModel[];
  llmJudgeInstructions?: string | null;
  llmJudgeModel?: string | null;
  llmJudgeConcurrency?: number | null;
  llmJudgeMaxComparisons?: number | null;
  llmJudgeCandidateChars?: number | null;
  llmJudgePromptVersion?: string | null;
  llmJudgeSystemPromptTemplate?: string | null;
  llmJudgeUserPromptTemplate?: string | null;
}

const NEWS_DEDUPE_SETTINGS_QUERY = gql`
  query NewsDedupeSettings {
    newsDedupeSettings {
      defaultThreshold
      useEmbeddings
      llmJudgeInstructions
      llmJudgeModel
      llmJudgeConcurrency
      llmJudgeMaxComparisons
      llmJudgeCandidateChars
      llmJudgePromptVersion
      llmJudgeSystemPromptTemplate
      llmJudgeUserPromptTemplate
      scopedThresholds {
        sourceId
        language
        categoryPath
        threshold
      }
    }
  }
`;

const UPDATE_NEWS_DEDUPE_SETTINGS_MUTATION = gql`
  mutation UpdateNewsDedupeSettings($input: UpdateNewsDedupeSettingsInput!) {
    updateNewsDedupeSettings(input: $input) {
      defaultThreshold
      useEmbeddings
      llmJudgeInstructions
      llmJudgeModel
      llmJudgeConcurrency
      llmJudgeMaxComparisons
      llmJudgeCandidateChars
      llmJudgePromptVersion
      llmJudgeSystemPromptTemplate
      llmJudgeUserPromptTemplate
      scopedThresholds {
        sourceId
        language
        categoryPath
        threshold
      }
    }
  }
`;

function normalizeScopeToken(
  value: string | null | undefined,
  maxLength: number,
  forceLowercase = false
) {
  if (typeof value !== "string") {
    return null;
  }
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) {
    return null;
  }
  const bounded = collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
  return forceLowercase ? bounded.toLowerCase() : bounded;
}

function normalizeScopeKeyPart(value: string | null) {
  if (!value) {
    return "*";
  }
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function buildScopeKey(value: {
  sourceId: string | null;
  language: string | null;
  categoryPath: string | null;
}) {
  return [
    normalizeScopeKeyPart(value.sourceId),
    normalizeScopeKeyPart(value.language),
    normalizeScopeKeyPart(value.categoryPath)
  ].join("|");
}

function normalizeScopedThresholds(values: NewsDedupeScopedThresholdModel[]) {
  const map = new Map<string, NewsDedupeScopedThresholdModel>();
  for (const entry of values) {
    const sourceId = normalizeScopeToken(entry?.sourceId ?? null, 191, false);
    const language = normalizeScopeToken(entry?.language ?? null, 32, true);
    const categoryPath = normalizeScopeToken(entry?.categoryPath ?? null, 240, false);
    if (!sourceId && !language && !categoryPath) {
      continue;
    }
    const threshold =
      typeof entry.threshold === "number" && Number.isFinite(entry.threshold) ? entry.threshold : 0;
    const clamped = Math.min(1, Math.max(0, threshold));
    const normalized: NewsDedupeScopedThresholdModel = {
      sourceId,
      language,
      categoryPath,
      threshold: clamped
    };
    map.set(buildScopeKey(normalized), normalized);
    if (map.size >= 100) {
      break;
    }
  }

  return Array.from(map.values()).sort((left, right) =>
    buildScopeKey(left).localeCompare(buildScopeKey(right))
  );
}

function resolveBaseThreshold(
  settings: { defaultThreshold: number; scopedThresholds: NewsDedupeScopedThresholdModel[] },
  options: { sourceId?: string | null; language?: string | null; categoryPath?: string | null }
) {
  const map = new Map<string, NewsDedupeScopedThresholdModel>();
  for (const entry of settings.scopedThresholds) {
    map.set(buildScopeKey(entry), entry);
  }

  const sourceId = normalizeScopeToken(options.sourceId ?? null, 191, false);
  const language = normalizeScopeToken(options.language ?? null, 32, true);
  const categoryPath = normalizeScopeToken(options.categoryPath ?? null, 240, false);
  const candidates: {
    sourceId: string | null;
    language: string | null;
    categoryPath: string | null;
  }[] = [
    { sourceId, language, categoryPath },
    { sourceId, language, categoryPath: null },
    { sourceId, language: null, categoryPath: null },
    { sourceId: null, language, categoryPath },
    { sourceId: null, language, categoryPath: null },
    { sourceId: null, language: null, categoryPath }
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = buildScopeKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const match = map.get(key);
    if (match) {
      return {
        threshold: match.threshold,
        matchedScope: match
      };
    }
  }

  return { threshold: settings.defaultThreshold };
}

function resolveFinalThreshold(summaryLength: number, base: number) {
  if (!Number.isFinite(summaryLength) || summaryLength <= 0) {
    return base;
  }
  if (summaryLength < 80) {
    return Math.min(0.96, base + 0.04);
  }
  if (summaryLength < 120) {
    return Math.min(0.94, base + 0.02);
  }
  if (summaryLength > 280) {
    return Math.max(0.86, base - 0.03);
  }
  if (summaryLength > 200) {
    return Math.max(0.88, base - 0.02);
  }
  return base;
}

function formatThreshold(value: number) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(2);
}

export function NewsDedupeSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [probeSourceId, setProbeSourceId] = useState<string>("");
  const [probeLanguage, setProbeLanguage] = useState<string>("");
  const [probeCategoryPath, setProbeCategoryPath] = useState<string>("");
  const [probeSummaryLength, setProbeSummaryLength] = useState<number>(200);

  const { data, loading, refetch, error } = useQuery<QueryData>(NEWS_DEDUPE_SETTINGS_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const [updateSettings, { loading: saving }] = useMutation<MutationData>(UPDATE_NEWS_DEDUPE_SETTINGS_MUTATION);

  useEffect(() => {
    if (data?.newsDedupeSettings) {
      form.setFieldsValue({
        defaultThreshold: data.newsDedupeSettings.defaultThreshold,
        useEmbeddings: data.newsDedupeSettings.useEmbeddings,
        llmJudgeInstructions: data.newsDedupeSettings.llmJudgeInstructions,
        llmJudgeModel: data.newsDedupeSettings.llmJudgeModel,
        llmJudgeConcurrency: data.newsDedupeSettings.llmJudgeConcurrency,
        llmJudgeMaxComparisons: data.newsDedupeSettings.llmJudgeMaxComparisons,
        llmJudgeCandidateChars: data.newsDedupeSettings.llmJudgeCandidateChars,
        llmJudgePromptVersion: data.newsDedupeSettings.llmJudgePromptVersion,
        llmJudgeSystemPromptTemplate: data.newsDedupeSettings.llmJudgeSystemPromptTemplate,
        llmJudgeUserPromptTemplate: data.newsDedupeSettings.llmJudgeUserPromptTemplate,
        scopedThresholds: data.newsDedupeSettings.scopedThresholds ?? []
      });
    }
  }, [data?.newsDedupeSettings, form]);

  const watchedDefaultThreshold = Form.useWatch("defaultThreshold", form);
  const scopedThresholds = Form.useWatch("scopedThresholds", form);
  const normalizedPreview = useMemo(
    () => normalizeScopedThresholds(Array.isArray(scopedThresholds) ? scopedThresholds : []),
    [scopedThresholds]
  );

  const effectiveDefaultThreshold = useMemo(() => {
    const base = typeof watchedDefaultThreshold === "number" ? watchedDefaultThreshold : 0.9;
    return Math.min(1, Math.max(0, base));
  }, [watchedDefaultThreshold]);

  const probeResult = useMemo(() => {
    const base = resolveBaseThreshold(
      {
        defaultThreshold: effectiveDefaultThreshold,
        scopedThresholds: normalizedPreview
      },
      {
        sourceId: probeSourceId,
        language: probeLanguage,
        categoryPath: probeCategoryPath
      }
    );
    const finalThreshold = resolveFinalThreshold(probeSummaryLength, base.threshold);
    return {
      ...base,
      finalThreshold
    };
  }, [
    effectiveDefaultThreshold,
    normalizedPreview,
    probeCategoryPath,
    probeLanguage,
    probeSourceId,
    probeSummaryLength
  ]);
  const probeMatchedScopeLabel = useMemo(() => {
    const matched = probeResult.matchedScope;
    if (!matched) {
      return null;
    }
    const parts = [
      matched.sourceId ? `source=${matched.sourceId}` : null,
      matched.language ? `lang=${matched.language}` : null,
      matched.categoryPath ? `path=${matched.categoryPath}` : null
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" | ") : null;
  }, [probeResult.matchedScope]);

  const handleSubmit = async (values: FormValues) => {
    try {
      const payload: UpdateNewsDedupeSettingsInput = {
        defaultThreshold: Math.min(1, Math.max(0, values.defaultThreshold)),
        useEmbeddings: Boolean(values.useEmbeddings),
        scopedThresholds: normalizeScopedThresholds(values.scopedThresholds ?? [])
      };

      if (!values.useEmbeddings) {
        payload.llmJudgeInstructions = values.llmJudgeInstructions?.trim()
          ? values.llmJudgeInstructions.trim()
          : null;
        payload.llmJudgeModel = values.llmJudgeModel?.trim() ? values.llmJudgeModel.trim() : null;
        payload.llmJudgeConcurrency =
          typeof values.llmJudgeConcurrency === "number" && Number.isFinite(values.llmJudgeConcurrency)
            ? values.llmJudgeConcurrency
            : null;
        payload.llmJudgeMaxComparisons =
          typeof values.llmJudgeMaxComparisons === "number" && Number.isFinite(values.llmJudgeMaxComparisons)
            ? values.llmJudgeMaxComparisons
            : null;
        payload.llmJudgeCandidateChars =
          typeof values.llmJudgeCandidateChars === "number" && Number.isFinite(values.llmJudgeCandidateChars)
            ? values.llmJudgeCandidateChars
            : null;
        payload.llmJudgePromptVersion = values.llmJudgePromptVersion?.trim()
          ? values.llmJudgePromptVersion.trim()
          : null;
        payload.llmJudgeSystemPromptTemplate = values.llmJudgeSystemPromptTemplate?.trim()
          ? values.llmJudgeSystemPromptTemplate.trim()
          : null;
        payload.llmJudgeUserPromptTemplate = values.llmJudgeUserPromptTemplate?.trim()
          ? values.llmJudgeUserPromptTemplate.trim()
          : null;
      }
      await updateSettings({ variables: { input: payload } });
      await refetch();
      messageApi.success(t("settings.newsDedupe.messages.saved"));
    } catch (err) {
      captureClientError("Failed to save news dedupe settings", err);
      messageApi.error(t("settings.newsDedupe.messages.saveFailed"));
    }
  };

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            defaultThreshold: effectiveDefaultThreshold,
            scopedThresholds: normalizedPreview
          },
          null,
          2
        )
      );
      messageApi.success(t("settings.newsDedupe.messages.copied"));
    } catch (err) {
      captureClientError("Failed to copy news dedupe settings JSON", err);
      messageApi.error(t("settings.newsDedupe.messages.copyFailed"));
    }
  };

  if (loading && !data?.newsDedupeSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("settings.newsDedupe.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsDedupe.notice.title")}
        description={t("settings.newsDedupe.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsDedupe.messages.loadFailed")}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Card
          size="small"
          title={t("settings.newsDedupe.sections.mode")}
          style={{ marginBottom: "1rem" }}
        >
          <Form.Item
            label={t("settings.newsDedupe.fields.useEmbeddings")}
            name="useEmbeddings"
            valuePropName="checked"
            extra={t("settings.newsDedupe.hints.useEmbeddings")}
          >
            <Switch
              checkedChildren={t("settings.newsDedupe.options.useEmbeddings.on")}
              unCheckedChildren={t("settings.newsDedupe.options.useEmbeddings.off")}
            />
          </Form.Item>

          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) =>
              getFieldValue("useEmbeddings") ? null : (
                <>
                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeModel")}
                    name="llmJudgeModel"
                    extra={t("settings.newsDedupe.hints.llmJudgeModel")}
                  >
                    <Input placeholder="openai/gpt-4o-mini" />
                  </Form.Item>

                  <Space wrap style={{ display: "flex" }}>
                    <Form.Item
                      label={t("settings.newsDedupe.fields.llmJudgeConcurrency")}
                      name="llmJudgeConcurrency"
                      extra={t("settings.newsDedupe.hints.llmJudgeConcurrency")}
                      style={{ flex: 1, minWidth: 240 }}
                    >
                      <InputNumber min={1} max={8} step={1} style={{ width: "100%" }} />
                    </Form.Item>

                    <Form.Item
                      label={t("settings.newsDedupe.fields.llmJudgeMaxComparisons")}
                      name="llmJudgeMaxComparisons"
                      extra={t("settings.newsDedupe.hints.llmJudgeMaxComparisons")}
                      style={{ flex: 1, minWidth: 240 }}
                    >
                      <InputNumber min={1} max={30} step={1} style={{ width: "100%" }} />
                    </Form.Item>

                    <Form.Item
                      label={t("settings.newsDedupe.fields.llmJudgeCandidateChars")}
                      name="llmJudgeCandidateChars"
                      extra={t("settings.newsDedupe.hints.llmJudgeCandidateChars")}
                      style={{ flex: 1, minWidth: 240 }}
                    >
                      <InputNumber min={200} max={5000} step={50} style={{ width: "100%" }} />
                    </Form.Item>
                  </Space>

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeInstructions")}
                    name="llmJudgeInstructions"
                    extra={t("settings.newsDedupe.hints.llmJudgeInstructions")}
                  >
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="…" />
                  </Form.Item>

                  <Divider style={{ margin: "0.75rem 0" }} />

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgePromptVersion")}
                    name="llmJudgePromptVersion"
                    extra={t("settings.newsDedupe.hints.llmJudgePromptVersion")}
                  >
                    <Input placeholder="news-dedupe-judge-v1" />
                  </Form.Item>

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeSystemPromptTemplate")}
                    name="llmJudgeSystemPromptTemplate"
                    extra={t("settings.newsDedupe.hints.llmJudgeSystemPromptTemplate")}
                  >
                    <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} />
                  </Form.Item>

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeUserPromptTemplate")}
                    name="llmJudgeUserPromptTemplate"
                    extra={t("settings.newsDedupe.hints.llmJudgeUserPromptTemplate")}
                  >
                    <Input.TextArea autoSize={{ minRows: 6, maxRows: 16 }} />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
        </Card>

        <Card
          size="small"
          title={t("settings.newsDedupe.sections.overrides")}
          style={{ marginBottom: "1rem" }}
        >
          <Form.Item
            label={t("settings.newsDedupe.fields.defaultThreshold")}
            name="defaultThreshold"
            extra={t("settings.newsDedupe.hints.defaultThreshold")}
            rules={[
              { required: true, message: t("settings.newsDedupe.validation.required") }
            ]}
          >
            <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
          </Form.Item>

          <Divider style={{ margin: "0.75rem 0" }} />

          <Form.List name="scopedThresholds">
            {(fields, { add, remove }) => (
              <>
                <Space wrap style={{ marginBottom: "0.75rem" }}>
                  <Tag>
                    {t("settings.newsDedupe.fields.defaultThreshold")}:{" "}
                    {formatThreshold(effectiveDefaultThreshold)}
                  </Tag>
                  <Tag>
                    {t("settings.newsDedupe.hints.normalizedCount", {
                      count: normalizedPreview.length
                    })}
                  </Tag>
                </Space>

                {fields.length > 0 ? (
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <Typography.Text type="secondary" style={{ width: 220 }}>
                      {t("settings.newsDedupe.fields.sourceId")}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ width: 160 }}>
                      {t("settings.newsDedupe.fields.language")}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ flex: 1, minWidth: 220 }}>
                      {t("settings.newsDedupe.fields.categoryPath")}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ width: 220 }}>
                      {t("settings.newsDedupe.fields.threshold")}
                    </Typography.Text>
                    <div style={{ width: 32 }} />
                  </div>
                ) : null}

                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: "flex", marginBottom: 8 }}>
                    <Form.Item
                      {...field}
                      name={[field.name, "sourceId"]}
                      style={{ width: 220, marginBottom: 0 }}
                    >
                      <Input
                        placeholder={t("settings.newsDedupe.placeholders.sourceId")}
                      />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      name={[field.name, "language"]}
                      style={{ width: 160, marginBottom: 0 }}
                    >
                      <Input placeholder={t("settings.newsDedupe.placeholders.language")} />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      name={[field.name, "categoryPath"]}
                      style={{ flex: 1, minWidth: 220, marginBottom: 0 }}
                    >
                      <Input
                        placeholder={t("settings.newsDedupe.placeholders.categoryPath")}
                      />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      name={[field.name, "threshold"]}
                      rules={[
                        {
                          required: true,
                          message: t("settings.newsDedupe.validation.threshold")
                        }
                      ]}
                      style={{ width: 220, marginBottom: 0 }}
                    >
                      <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
                    </Form.Item>

                    <Button
                      danger
                      type="text"
                      icon={<MinusCircleOutlined />}
                      onClick={() => remove(field.name)}
                      aria-label={t("settings.newsDedupe.actions.remove")}
                    />
                  </Space>
                ))}

                <Form.Item style={{ marginBottom: 0, marginTop: "0.5rem" }}>
                  <Button
                    type="dashed"
                    onClick={() =>
                      add({
                        sourceId: null,
                        language: null,
                        categoryPath: null,
                        threshold: 0.92
                      })
                    }
                    icon={<PlusOutlined />}
                  >
                    {t("settings.newsDedupe.actions.add")}
                  </Button>
                </Form.Item>
              </>
            )}
          </Form.List>
        </Card>

        <Card
          size="small"
          title={t("settings.newsDedupe.sections.preview")}
          extra={
            <Button onClick={handleCopyJson} disabled={loading}>
              {t("settings.newsDedupe.actions.copyJson")}
            </Button>
          }
          style={{ marginBottom: "1rem" }}
        >
          {normalizedPreview.length > 0 ? (
            <Table
              size="small"
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              dataSource={normalizedPreview}
              rowKey={(row) => buildScopeKey(row)}
              columns={[
                {
                  title: t("settings.newsDedupe.fields.sourceId"),
                  dataIndex: "sourceId",
                  key: "sourceId",
                  render: (value: string | null) => value ?? "—"
                },
                {
                  title: t("settings.newsDedupe.fields.language"),
                  dataIndex: "language",
                  key: "language",
                  render: (value: string | null) => value ?? "—"
                },
                {
                  title: t("settings.newsDedupe.fields.categoryPath"),
                  dataIndex: "categoryPath",
                  key: "categoryPath",
                  render: (value: string | null) => value ?? "—"
                },
                {
                  title: t("settings.newsDedupe.fields.threshold"),
                  dataIndex: "threshold",
                  key: "threshold",
                  width: 140,
                  render: (value: number) => <Tag color="geekblue">{formatThreshold(value)}</Tag>
                }
              ]}
            />
          ) : (
            <Empty description={t("settings.newsDedupe.preview.empty")} />
          )}
        </Card>

        <Card
          size="small"
          title={t("settings.newsDedupe.sections.tester")}
          style={{ marginBottom: "1rem" }}
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
            {t("settings.newsDedupe.tester.hint")}
          </Typography.Paragraph>

          <Space direction="vertical" size="middle" style={{ display: "flex" }}>
            <Space wrap style={{ display: "flex" }}>
              <Form.Item
                label={t("settings.newsDedupe.tester.fields.sourceId")}
                style={{ minWidth: 220, flex: 1, marginBottom: 0 }}
              >
                <Input
                  value={probeSourceId}
                  onChange={(event) => setProbeSourceId(event.target.value)}
                  placeholder={t("settings.newsDedupe.tester.placeholders.sourceId")}
                />
              </Form.Item>

              <Form.Item
                label={t("settings.newsDedupe.tester.fields.language")}
                style={{ minWidth: 160, marginBottom: 0 }}
              >
                <Input
                  value={probeLanguage}
                  onChange={(event) => setProbeLanguage(event.target.value)}
                  placeholder={t("settings.newsDedupe.tester.placeholders.language")}
                />
              </Form.Item>

              <Form.Item
                label={t("settings.newsDedupe.tester.fields.categoryPath")}
                style={{ minWidth: 260, flex: 1, marginBottom: 0 }}
              >
                <Input
                  value={probeCategoryPath}
                  onChange={(event) => setProbeCategoryPath(event.target.value)}
                  placeholder={t("settings.newsDedupe.tester.placeholders.categoryPath")}
                />
              </Form.Item>

              <Form.Item
                label={t("settings.newsDedupe.tester.fields.summaryLength")}
                style={{ width: 220, marginBottom: 0 }}
              >
                <InputNumber
                  min={1}
                  max={10_000}
                  value={probeSummaryLength}
                  onChange={(value) => setProbeSummaryLength(typeof value === "number" ? value : 200)}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Space>

            <Space wrap>
              <Tag>
                {t("settings.newsDedupe.tester.results.base")}:{" "}
                {formatThreshold(probeResult.threshold)}
                {probeMatchedScopeLabel
                  ? ` (${t("settings.newsDedupe.tester.results.matched")}: ${
                      probeMatchedScopeLabel
                    })`
                  : ` (${t("settings.newsDedupe.tester.results.default")})`}
              </Tag>
              <Tag color="green">
                {t("settings.newsDedupe.tester.results.final")}:{" "}
                {formatThreshold(probeResult.finalThreshold)}
              </Tag>
            </Space>
          </Space>
        </Card>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

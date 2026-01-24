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
  Select,
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

interface NewsDedupeCategoryThresholdModel {
  category: string;
  threshold: number;
}

interface NewsDedupeSettingsModel {
  defaultThreshold: number;
  useEmbeddings: boolean;
  llmJudgeInstructions: string | null;
  llmJudgeModel: string | null;
  llmJudgeMaxComparisons: number;
  llmJudgeCandidateChars: number;
  llmJudgePromptVersion: string;
  llmJudgeSystemPromptTemplate: string;
  llmJudgeUserPromptTemplate: string;
  categoryThresholds: NewsDedupeCategoryThresholdModel[];
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
  llmJudgeMaxComparisons: number | null;
  llmJudgeCandidateChars: number | null;
  llmJudgePromptVersion: string | null;
  llmJudgeSystemPromptTemplate: string | null;
  llmJudgeUserPromptTemplate: string | null;
  categoryThresholds: NewsDedupeCategoryThresholdModel[];
}

interface UpdateNewsDedupeSettingsInput {
  defaultThreshold: number;
  useEmbeddings: boolean;
  categoryThresholds: NewsDedupeCategoryThresholdModel[];
  llmJudgeInstructions?: string | null;
  llmJudgeModel?: string | null;
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
      llmJudgeMaxComparisons
      llmJudgeCandidateChars
      llmJudgePromptVersion
      llmJudgeSystemPromptTemplate
      llmJudgeUserPromptTemplate
      categoryThresholds {
        category
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
      llmJudgeMaxComparisons
      llmJudgeCandidateChars
      llmJudgePromptVersion
      llmJudgeSystemPromptTemplate
      llmJudgeUserPromptTemplate
      categoryThresholds {
        category
        threshold
      }
    }
  }
`;

function normalizeTopicKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, " ").toLowerCase();
}

function normalizeCategoryThresholds(values: NewsDedupeCategoryThresholdModel[]) {
  const map = new Map<string, NewsDedupeCategoryThresholdModel>();
  for (const entry of values) {
    const category = typeof entry?.category === "string" ? entry.category.trim() : "";
    if (!category) {
      continue;
    }
    const key = normalizeTopicKey(category);
    const threshold =
      typeof entry.threshold === "number" && Number.isFinite(entry.threshold) ? entry.threshold : 0;
    const clamped = Math.min(1, Math.max(0, threshold));
    map.set(key, { category, threshold: clamped });
    if (map.size >= 100) {
      break;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.category.localeCompare(b.category));
}

function resolveBaseThreshold(
  settings: { defaultThreshold: number; categoryThresholds: NewsDedupeCategoryThresholdModel[] },
  options: { category?: string | null; topics?: string[] | null }
) {
  const map = new Map<string, NewsDedupeCategoryThresholdModel>();
  for (const entry of settings.categoryThresholds) {
    const key = normalizeTopicKey(entry.category);
    if (!key) {
      continue;
    }
    map.set(key, entry);
  }

  const candidates: string[] = [];
  if (typeof options.category === "string" && options.category.trim()) {
    candidates.push(options.category);
  }
  if (Array.isArray(options.topics)) {
    for (const topic of options.topics) {
      if (typeof topic === "string" && topic.trim()) {
        candidates.push(topic);
      }
    }
  }

  let best: NewsDedupeCategoryThresholdModel | null = null;
  for (const candidate of candidates) {
    const key = normalizeTopicKey(candidate);
    if (!key) {
      continue;
    }
    const match = map.get(key);
    if (!match) {
      continue;
    }
    if (!best || match.threshold > best.threshold) {
      best = match;
    }
  }

  return best
    ? { threshold: best.threshold, matchedCategory: best.category }
    : { threshold: settings.defaultThreshold };
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
  const [probeCategory, setProbeCategory] = useState<string>("");
  const [probeTopics, setProbeTopics] = useState<string[]>([]);
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
        llmJudgeMaxComparisons: data.newsDedupeSettings.llmJudgeMaxComparisons,
        llmJudgeCandidateChars: data.newsDedupeSettings.llmJudgeCandidateChars,
        llmJudgePromptVersion: data.newsDedupeSettings.llmJudgePromptVersion,
        llmJudgeSystemPromptTemplate: data.newsDedupeSettings.llmJudgeSystemPromptTemplate,
        llmJudgeUserPromptTemplate: data.newsDedupeSettings.llmJudgeUserPromptTemplate,
        categoryThresholds: data.newsDedupeSettings.categoryThresholds ?? []
      });
    }
  }, [data?.newsDedupeSettings, form]);

  const watchedDefaultThreshold = Form.useWatch("defaultThreshold", form);
  const categoryThresholds = Form.useWatch("categoryThresholds", form);
  const normalizedPreview = useMemo(
    () => normalizeCategoryThresholds(Array.isArray(categoryThresholds) ? categoryThresholds : []),
    [categoryThresholds]
  );

  const effectiveDefaultThreshold = useMemo(() => {
    const base = typeof watchedDefaultThreshold === "number" ? watchedDefaultThreshold : 0.9;
    return Math.min(1, Math.max(0, base));
  }, [watchedDefaultThreshold]);

  const probeResult = useMemo(() => {
    const base = resolveBaseThreshold(
      {
        defaultThreshold: effectiveDefaultThreshold,
        categoryThresholds: normalizedPreview
      },
      { category: probeCategory, topics: probeTopics }
    );
    const finalThreshold = resolveFinalThreshold(probeSummaryLength, base.threshold);
    return {
      ...base,
      finalThreshold
    };
  }, [effectiveDefaultThreshold, normalizedPreview, probeCategory, probeSummaryLength, probeTopics]);

  const handleSubmit = async (values: FormValues) => {
    try {
      const payload: UpdateNewsDedupeSettingsInput = {
        defaultThreshold: Math.min(1, Math.max(0, values.defaultThreshold)),
        useEmbeddings: Boolean(values.useEmbeddings),
        categoryThresholds: normalizeCategoryThresholds(values.categoryThresholds ?? [])
      };

      if (!values.useEmbeddings) {
        payload.llmJudgeInstructions = values.llmJudgeInstructions?.trim()
          ? values.llmJudgeInstructions.trim()
          : null;
        payload.llmJudgeModel = values.llmJudgeModel?.trim() ? values.llmJudgeModel.trim() : null;
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
      messageApi.success(t("settings.newsDedupe.messages.saved", { defaultValue: "Saved" }));
    } catch (err) {
      captureClientError("Failed to save news dedupe settings", err);
      messageApi.error(t("settings.newsDedupe.messages.saveFailed", { defaultValue: "Failed to save" }));
    }
  };

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            defaultThreshold: effectiveDefaultThreshold,
            categoryThresholds: normalizedPreview
          },
          null,
          2
        )
      );
      messageApi.success(t("settings.newsDedupe.messages.copied", { defaultValue: "Copied." }));
    } catch (err) {
      captureClientError("Failed to copy news dedupe settings JSON", err);
      messageApi.error(t("settings.newsDedupe.messages.copyFailed", { defaultValue: "Copy failed" }));
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
        {t("settings.newsDedupe.description", {
          defaultValue: "Configure semantic dedupe thresholds per topic/category."
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsDedupe.notice.title", { defaultValue: "How it works" })}
        description={t("settings.newsDedupe.notice.body", {
          defaultValue:
            "The pipeline picks the strictest (highest) threshold among matched category/topics; otherwise it uses the default threshold. Length-based adjustments still apply."
        })}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsDedupe.messages.loadFailed", { defaultValue: "Failed to load settings" })}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Card
          size="small"
          title={t("settings.newsDedupe.sections.mode", { defaultValue: "Similarity method" })}
          style={{ marginBottom: "1rem" }}
        >
          <Form.Item
            label={t("settings.newsDedupe.fields.useEmbeddings", { defaultValue: "Use embeddings" })}
            name="useEmbeddings"
            valuePropName="checked"
            extra={t("settings.newsDedupe.hints.useEmbeddings", {
              defaultValue:
                "On: compute embeddings vectors for semantic dedupe (fast + scalable, but needs embedding support and storage). Off: use an LLM judge to score similarity (slower + higher cost, but no embeddings storage)."
            })}
          >
            <Switch
              checkedChildren={t("settings.newsDedupe.options.useEmbeddings.on", { defaultValue: "Embeddings" })}
              unCheckedChildren={t("settings.newsDedupe.options.useEmbeddings.off", { defaultValue: "LLM" })}
            />
          </Form.Item>

          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) =>
              getFieldValue("useEmbeddings") ? null : (
                <>
                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeModel", {
                      defaultValue: "LLM judge model (optional)"
                    })}
                    name="llmJudgeModel"
                    extra={t("settings.newsDedupe.hints.llmJudgeModel", {
                      defaultValue:
                        "Overrides which model is used for LLM-based dedupe. Leave blank to use the pipeline's default completion model."
                    })}
                  >
                    <Input placeholder="openai/gpt-4o-mini" />
                  </Form.Item>

                  <Space wrap style={{ display: "flex" }}>
                    <Form.Item
                      label={t("settings.newsDedupe.fields.llmJudgeMaxComparisons", {
                        defaultValue: "Max comparisons"
                      })}
                      name="llmJudgeMaxComparisons"
                      extra={t("settings.newsDedupe.hints.llmJudgeMaxComparisons", {
                        defaultValue: "Upper bound on LLM judge calls per item (cost/latency control)."
                      })}
                      style={{ flex: 1, minWidth: 240 }}
                    >
                      <InputNumber min={1} max={30} step={1} style={{ width: "100%" }} />
                    </Form.Item>

                    <Form.Item
                      label={t("settings.newsDedupe.fields.llmJudgeCandidateChars", {
                        defaultValue: "Candidate chars"
                      })}
                      name="llmJudgeCandidateChars"
                      extra={t("settings.newsDedupe.hints.llmJudgeCandidateChars", {
                        defaultValue: "Truncation length for each summary sent to the judge."
                      })}
                      style={{ flex: 1, minWidth: 240 }}
                    >
                      <InputNumber min={200} max={5000} step={50} style={{ width: "100%" }} />
                    </Form.Item>
                  </Space>

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeInstructions", {
                      defaultValue: "LLM judge instructions (optional)"
                    })}
                    name="llmJudgeInstructions"
                    extra={t("settings.newsDedupe.hints.llmJudgeInstructions", {
                      defaultValue:
                        "Extra system-level instructions appended to the dedupe judge prompt. Keep it short to avoid prompt injection and output-format issues."
                    })}
                  >
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="…" />
                  </Form.Item>

                  <Divider style={{ margin: "0.75rem 0" }} />

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgePromptVersion", {
                      defaultValue: "Prompt version"
                    })}
                    name="llmJudgePromptVersion"
                    extra={t("settings.newsDedupe.hints.llmJudgePromptVersion", {
                      defaultValue: "Saved to metadata for tracking prompt changes."
                    })}
                  >
                    <Input placeholder="news-dedupe-judge-v1" />
                  </Form.Item>

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeSystemPromptTemplate", {
                      defaultValue: "System prompt template"
                    })}
                    name="llmJudgeSystemPromptTemplate"
                    extra={t("settings.newsDedupe.hints.llmJudgeSystemPromptTemplate", {
                      defaultValue:
                        "Supports placeholders: {{language_hint}}, {{additional_instructions}}. Leave blank to reset to defaults."
                    })}
                  >
                    <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} />
                  </Form.Item>

                  <Form.Item
                    label={t("settings.newsDedupe.fields.llmJudgeUserPromptTemplate", {
                      defaultValue: "User prompt template"
                    })}
                    name="llmJudgeUserPromptTemplate"
                    extra={t("settings.newsDedupe.hints.llmJudgeUserPromptTemplate", {
                      defaultValue:
                        "Supports placeholders: {{threshold}}, {{title_a_section}}, {{summary_a}}, {{title_b_section}}, {{summary_b}}. Leave blank to reset to defaults."
                    })}
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
          title={t("settings.newsDedupe.sections.overrides", { defaultValue: "Per-topic overrides" })}
          style={{ marginBottom: "1rem" }}
        >
          <Form.Item
            label={t("settings.newsDedupe.fields.defaultThreshold", { defaultValue: "Default threshold" })}
            name="defaultThreshold"
            extra={t("settings.newsDedupe.hints.defaultThreshold", {
              defaultValue: "Used when no category/topics match. Range 0–1 (higher = stricter)."
            })}
            rules={[
              { required: true, message: t("settings.newsDedupe.validation.required", { defaultValue: "Required" }) }
            ]}
          >
            <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
          </Form.Item>

          <Divider style={{ margin: "0.75rem 0" }} />

          <Form.List name="categoryThresholds">
            {(fields, { add, remove }) => (
              <>
                <Space wrap style={{ marginBottom: "0.75rem" }}>
                  <Tag>
                    {t("settings.newsDedupe.fields.defaultThreshold", { defaultValue: "Default threshold" })}:{" "}
                    {formatThreshold(effectiveDefaultThreshold)}
                  </Tag>
                  <Tag>
                    {t("settings.newsDedupe.hints.normalizedCount", {
                      defaultValue: "Effective overrides: {{count}}",
                      count: normalizedPreview.length
                    })}
                  </Tag>
                </Space>

                {fields.length > 0 ? (
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <Typography.Text type="secondary" style={{ flex: 1, minWidth: 240 }}>
                      {t("settings.newsDedupe.fields.category", { defaultValue: "Category/topic" })}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ width: 220 }}>
                      {t("settings.newsDedupe.fields.threshold", { defaultValue: "Threshold" })}
                    </Typography.Text>
                    <div style={{ width: 32 }} />
                  </div>
                ) : null}

                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: "flex", marginBottom: 8 }}>
                    <Form.Item
                      {...field}
                      name={[field.name, "category"]}
                      rules={[
                        {
                          required: true,
                          message: t("settings.newsDedupe.validation.category", { defaultValue: "Required" })
                        }
                      ]}
                      style={{ flex: 1, minWidth: 240, marginBottom: 0 }}
                    >
                      <Input
                        placeholder={t("settings.newsDedupe.placeholders.category", {
                          defaultValue: "e.g. finance / 科技 / geopolitics"
                        })}
                      />
                    </Form.Item>

                    <Form.Item
                      {...field}
                      name={[field.name, "threshold"]}
                      rules={[
                        {
                          required: true,
                          message: t("settings.newsDedupe.validation.threshold", { defaultValue: "Required" })
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
                      aria-label={t("settings.newsDedupe.actions.remove", { defaultValue: "Remove" })}
                    />
                  </Space>
                ))}

                <Form.Item style={{ marginBottom: 0, marginTop: "0.5rem" }}>
                  <Button type="dashed" onClick={() => add({ category: "", threshold: 0.92 })} icon={<PlusOutlined />}>
                    {t("settings.newsDedupe.actions.add", { defaultValue: "Add override" })}
                  </Button>
                </Form.Item>
              </>
            )}
          </Form.List>
        </Card>

        <Card
          size="small"
          title={t("settings.newsDedupe.sections.preview", { defaultValue: "Effective config" })}
          extra={
            <Button onClick={handleCopyJson} disabled={loading}>
              {t("settings.newsDedupe.actions.copyJson", { defaultValue: "Copy JSON" })}
            </Button>
          }
          style={{ marginBottom: "1rem" }}
        >
          {normalizedPreview.length > 0 ? (
            <Table
              size="small"
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              dataSource={normalizedPreview}
              rowKey={(row) => row.category}
              columns={[
                {
                  title: t("settings.newsDedupe.fields.category", { defaultValue: "Category/topic" }),
                  dataIndex: "category",
                  key: "category"
                },
                {
                  title: t("settings.newsDedupe.fields.threshold", { defaultValue: "Threshold" }),
                  dataIndex: "threshold",
                  key: "threshold",
                  width: 140,
                  render: (value: number) => <Tag color="geekblue">{formatThreshold(value)}</Tag>
                }
              ]}
            />
          ) : (
            <Empty description={t("settings.newsDedupe.preview.empty", { defaultValue: "No overrides." })} />
          )}
        </Card>

        <Card
          size="small"
          title={t("settings.newsDedupe.sections.tester", { defaultValue: "Threshold preview" })}
          style={{ marginBottom: "1rem" }}
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
            {t("settings.newsDedupe.tester.hint", {
              defaultValue:
                "Use this to preview which override matches and what threshold is applied after length adjustments."
            })}
          </Typography.Paragraph>

          <Space direction="vertical" size="middle" style={{ display: "flex" }}>
            <Space wrap style={{ display: "flex" }}>
              <Form.Item
                label={t("settings.newsDedupe.tester.fields.category", { defaultValue: "Category" })}
                style={{ minWidth: 240, flex: 1, marginBottom: 0 }}
              >
                <Input
                  value={probeCategory}
                  onChange={(event) => setProbeCategory(event.target.value)}
                  placeholder={t("settings.newsDedupe.tester.placeholders.category", { defaultValue: "Optional" })}
                />
              </Form.Item>

              <Form.Item
                label={t("settings.newsDedupe.tester.fields.topics", { defaultValue: "Topics" })}
                style={{ minWidth: 260, flex: 1, marginBottom: 0 }}
              >
                <Select
                  mode="tags"
                  value={probeTopics}
                  onChange={(value) => setProbeTopics(value)}
                  tokenSeparators={[",", " ", "\n", "\t"]}
                  placeholder={t("settings.newsDedupe.tester.placeholders.topics", {
                    defaultValue: "Optional (comma / Enter separated)"
                  })}
                  options={(probeTopics ?? []).map((topic) => ({ label: topic, value: topic }))}
                />
              </Form.Item>

              <Form.Item
                label={t("settings.newsDedupe.tester.fields.summaryLength", { defaultValue: "Summary length" })}
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
                {t("settings.newsDedupe.tester.results.base", { defaultValue: "Base" })}:{" "}
                {formatThreshold(probeResult.threshold)}
                {probeResult.matchedCategory
                  ? ` (${t("settings.newsDedupe.tester.results.matched", { defaultValue: "matched" })}: ${
                      probeResult.matchedCategory
                    })`
                  : ` (${t("settings.newsDedupe.tester.results.default", { defaultValue: "default" })})`}
              </Tag>
              <Tag color="green">
                {t("settings.newsDedupe.tester.results.final", { defaultValue: "Final" })}:{" "}
                {formatThreshold(probeResult.finalThreshold)}
              </Tag>
            </Space>
          </Space>
        </Card>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
            {t("common.saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}

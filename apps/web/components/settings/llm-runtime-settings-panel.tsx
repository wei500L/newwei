"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type LlmRuntimeMode = "observe_only";
type LlmRuntimeDecision =
  | "allowed"
  | "warn_concurrency"
  | "warn_daily_budget"
  | "warn_monthly_budget"
  | "warn_multiple";

interface LlmRuntimeSettingsResponse {
  source: "default" | "db";
  mode: LlmRuntimeMode;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxConcurrency: number;
  alertCooldownSeconds: number;
  requestLeaseTtlSeconds: number;
}

interface LlmRuntimeStatusResponse extends LlmRuntimeSettingsResponse {
  currentConcurrency: number;
  peakConcurrency: {
    day: number;
    month: number;
  };
  spendUsd: {
    day: number;
    month: number;
  };
  budgetUtilization: {
    day: number | null;
    month: number | null;
  };
  warningState: {
    runtimeDecision: LlmRuntimeDecision;
    concurrencyExceeded: boolean;
    dailyBudgetExceeded: boolean;
    monthlyBudgetExceeded: boolean;
  };
  lastAlert: {
    at: string | null;
    decision: LlmRuntimeDecision | null;
    feature: string | null;
    requestType:
      | "completion"
      | "embedding"
      | "rerank"
      | "stream"
      | "responses"
      | null;
  };
}

interface LlmRuntimeSummaryTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  peakObservedConcurrency: number;
}

interface LlmRuntimeSummaryGroupRow extends LlmRuntimeSummaryTotals {
  key: string;
}

interface LlmRuntimeWarningBreakdownRow {
  decision: LlmRuntimeDecision;
  count: number;
}

interface LlmRuntimeSummaryResponse {
  window: "day" | "month";
  start: string;
  end: string;
  totals: LlmRuntimeSummaryTotals;
  byFeature: LlmRuntimeSummaryGroupRow[];
  byModel: LlmRuntimeSummaryGroupRow[];
  byRequestType: LlmRuntimeSummaryGroupRow[];
  warningBreakdown: LlmRuntimeWarningBreakdownRow[];
}

interface LlmRuntimeSettingsFormValues {
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxConcurrency: number;
  alertCooldownSeconds: number;
  requestLeaseTtlSeconds: number;
}

const EMPTY_SETTINGS: LlmRuntimeSettingsResponse = {
  source: "default",
  mode: "observe_only",
  dailyBudgetUsd: 25,
  monthlyBudgetUsd: 500,
  maxConcurrency: 16,
  alertCooldownSeconds: 300,
  requestLeaseTtlSeconds: 120,
};

const EMPTY_STATUS: LlmRuntimeStatusResponse = {
  ...EMPTY_SETTINGS,
  currentConcurrency: 0,
  peakConcurrency: {
    day: 0,
    month: 0,
  },
  spendUsd: {
    day: 0,
    month: 0,
  },
  budgetUtilization: {
    day: 0,
    month: 0,
  },
  warningState: {
    runtimeDecision: "allowed",
    concurrencyExceeded: false,
    dailyBudgetExceeded: false,
    monthlyBudgetExceeded: false,
  },
  lastAlert: {
    at: null,
    decision: null,
    feature: null,
    requestType: null,
  },
};

const EMPTY_TOTALS: LlmRuntimeSummaryTotals = {
  requestCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  avgLatencyMs: 0,
  peakObservedConcurrency: 0,
};

const EMPTY_SUMMARY: LlmRuntimeSummaryResponse = {
  window: "day",
  start: new Date(0).toISOString(),
  end: new Date(0).toISOString(),
  totals: EMPTY_TOTALS,
  byFeature: [],
  byModel: [],
  byRequestType: [],
  warningBreakdown: [],
};

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `$${value.toFixed(6)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function formatLatency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${Math.round(value)} ms`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return parsed.toLocaleString();
}

export function LlmRuntimeSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<LlmRuntimeSettingsFormValues>();
  const [settings, setSettings] =
    useState<LlmRuntimeSettingsResponse>(EMPTY_SETTINGS);
  const [status, setStatus] = useState<LlmRuntimeStatusResponse>(EMPTY_STATUS);
  const [summary, setSummary] =
    useState<LlmRuntimeSummaryResponse>(EMPTY_SUMMARY);
  const [summaryWindow, setSummaryWindow] = useState<"day" | "month">("day");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const applySettings = useCallback(
    (payload: LlmRuntimeSettingsResponse | null | undefined) => {
      const normalized = payload ?? EMPTY_SETTINGS;
      setSettings(normalized);
      form.setFieldsValue({
        dailyBudgetUsd: normalized.dailyBudgetUsd,
        monthlyBudgetUsd: normalized.monthlyBudgetUsd,
        maxConcurrency: normalized.maxConcurrency,
        alertCooldownSeconds: normalized.alertCooldownSeconds,
        requestLeaseTtlSeconds: normalized.requestLeaseTtlSeconds,
      });
    },
    [form],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<LlmRuntimeSettingsResponse>(
        "system-settings/llm-runtime",
      );
      applySettings(response.data);
    } catch (error) {
      captureClientError("Failed to load LLM runtime settings", error);
      messageApi.error(
        t("systemSettings.llmRuntime.errors.loadFailed", {
          defaultValue: "Failed to load LLM runtime settings.",
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, applySettings, messageApi, t]);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const response = await apiClient.get<LlmRuntimeStatusResponse>(
        "system-settings/llm-runtime/status",
      );
      setStatus(response.data ?? EMPTY_STATUS);
    } catch (error) {
      captureClientError("Failed to load LLM runtime status", error);
      messageApi.error(
        t("systemSettings.llmRuntime.errors.statusFailed", {
          defaultValue: "Failed to load LLM runtime status.",
        }),
      );
    } finally {
      setStatusLoading(false);
    }
  }, [apiClient, messageApi, t]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const response = await apiClient.get<LlmRuntimeSummaryResponse>(
        "system-settings/llm-runtime/summary",
        {
          params: { window: summaryWindow },
        },
      );
      setSummary(response.data ?? { ...EMPTY_SUMMARY, window: summaryWindow });
    } catch (error) {
      captureClientError("Failed to load LLM runtime summary", error);
      messageApi.error(
        t("systemSettings.llmRuntime.errors.summaryFailed", {
          defaultValue: "Failed to load LLM runtime summary.",
        }),
      );
    } finally {
      setSummaryLoading(false);
    }
  }, [apiClient, messageApi, summaryWindow, t]);

  useEffect(() => {
    void loadSettings();
    void loadStatus();
  }, [loadSettings, loadStatus]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleSubmit = async (values: LlmRuntimeSettingsFormValues) => {
    setSaving(true);
    try {
      const response = await apiClient.put<LlmRuntimeSettingsResponse>(
        "system-settings/llm-runtime",
        values,
      );
      applySettings(response.data);
      await loadStatus();
      await loadSummary();
      messageApi.success(
        t("systemSettings.llmRuntime.messages.saved", {
          defaultValue: "LLM runtime settings saved.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to save LLM runtime settings", error);
      messageApi.error(
        extractApiError(error).message ||
          t("systemSettings.llmRuntime.errors.saveFailed", {
            defaultValue: "Failed to save LLM runtime settings.",
          }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.llmRuntime.modal.resetTitle", {
        defaultValue: "Reset LLM runtime settings?",
      }),
      content: t("systemSettings.llmRuntime.modal.resetBody", {
        defaultValue:
          "This restores the default observe-only budgets, concurrency, and cooldown values.",
      }),
      okText: t("common.reset", { defaultValue: "Reset" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        try {
          const response = await apiClient.delete<LlmRuntimeSettingsResponse>(
            "system-settings/llm-runtime",
          );
          applySettings(response.data);
          await loadStatus();
          await loadSummary();
          messageApi.success(
            t("systemSettings.llmRuntime.messages.reset", {
              defaultValue: "LLM runtime settings reset.",
            }),
          );
        } catch (error) {
          captureClientError("Failed to reset LLM runtime settings", error);
          messageApi.error(
            t("systemSettings.llmRuntime.errors.resetFailed", {
              defaultValue: "Failed to reset LLM runtime settings.",
            }),
          );
        } finally {
          setResetting(false);
        }
      },
    });
  };

  const totalsColumns = useMemo<ColumnsType<LlmRuntimeSummaryGroupRow>>(
    () => [
      {
        title: t("systemSettings.llmRuntime.summary.columns.key", {
          defaultValue: "Key",
        }),
        dataIndex: "key",
        key: "key",
      },
      {
        title: t("systemSettings.llmRuntime.summary.columns.requests", {
          defaultValue: "Requests",
        }),
        dataIndex: "requestCount",
        key: "requestCount",
        width: 120,
      },
      {
        title: t("systemSettings.llmRuntime.summary.columns.cost", {
          defaultValue: "Cost",
        }),
        dataIndex: "costUsd",
        key: "costUsd",
        width: 140,
        render: (value: number) => formatCurrency(value),
      },
      {
        title: t("systemSettings.llmRuntime.summary.columns.tokens", {
          defaultValue: "Tokens",
        }),
        dataIndex: "totalTokens",
        key: "totalTokens",
        width: 140,
      },
      {
        title: t("systemSettings.llmRuntime.summary.columns.latency", {
          defaultValue: "Avg latency",
        }),
        dataIndex: "avgLatencyMs",
        key: "avgLatencyMs",
        width: 140,
        render: (value: number) => formatLatency(value),
      },
    ],
    [t],
  );

  const warningColumns = useMemo<ColumnsType<LlmRuntimeWarningBreakdownRow>>(
    () => [
      {
        title: t("systemSettings.llmRuntime.summary.warningDecision", {
          defaultValue: "Decision",
        }),
        dataIndex: "decision",
        key: "decision",
        render: (value: LlmRuntimeDecision) => renderDecisionTag(value, t),
      },
      {
        title: t("systemSettings.llmRuntime.summary.warningCount", {
          defaultValue: "Count",
        }),
        dataIndex: "count",
        key: "count",
        width: 140,
      },
    ],
    [t],
  );

  if (loading) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.llmRuntime.description", {
          defaultValue:
            "Observe global LiteLLM spend and concurrency from a single runtime layer. This version only warns and logs; it does not block requests.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "1rem" }}
        message={t("systemSettings.llmRuntime.notice.title", {
          defaultValue: "Observe-only runtime guardrails",
        })}
        description={t("systemSettings.llmRuntime.notice.body", {
          defaultValue:
            "Warnings are emitted when concurrency or day/month budget thresholds are exceeded. Existing gateway profile RPM limits remain unchanged.",
        })}
      />

      <Card
        size="small"
        style={{ marginBottom: "1rem" }}
        title={t("systemSettings.llmRuntime.statusCard.title", {
          defaultValue: "Current runtime state",
        })}
        extra={
          <Space>
            <Tag color={settings.source === "db" ? "blue" : "default"}>
              {settings.source === "db"
                ? t("systemSettings.llmRuntime.source.db", {
                    defaultValue: "Custom",
                  })
                : t("systemSettings.llmRuntime.source.default", {
                    defaultValue: "Default",
                  })}
            </Tag>
            <Tag>{settings.mode}</Tag>
            <Button
              onClick={() => void Promise.all([loadStatus(), loadSummary()])}
              loading={statusLoading || summaryLoading}
            >
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </Space>
        }
      >
        <Spin spinning={statusLoading}>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8} xl={4}>
              <Statistic
                title={t(
                  "systemSettings.llmRuntime.status.currentConcurrency",
                  {
                    defaultValue: "Current concurrency",
                  },
                )}
                value={status.currentConcurrency}
              />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Statistic
                title={t("systemSettings.llmRuntime.status.dayPeak", {
                  defaultValue: "Day peak",
                })}
                value={status.peakConcurrency.day}
              />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Statistic
                title={t("systemSettings.llmRuntime.status.monthPeak", {
                  defaultValue: "Month peak",
                })}
                value={status.peakConcurrency.month}
              />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <Statistic
                title={t("systemSettings.llmRuntime.status.daySpend", {
                  defaultValue: "Day spend",
                })}
                value={status.spendUsd.day}
                precision={6}
                prefix="$"
                suffix={`(${formatPercent(status.budgetUtilization.day)})`}
              />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <Statistic
                title={t("systemSettings.llmRuntime.status.monthSpend", {
                  defaultValue: "Month spend",
                })}
                value={status.spendUsd.month}
                precision={6}
                prefix="$"
                suffix={`(${formatPercent(status.budgetUtilization.month)})`}
              />
            </Col>
          </Row>

          <Space wrap style={{ display: "flex", marginTop: "1rem" }}>
            {renderDecisionTag(status.warningState.runtimeDecision, t)}
            {status.warningState.concurrencyExceeded ? (
              <Tag color="red">
                {t("systemSettings.llmRuntime.status.flags.concurrency", {
                  defaultValue: "Concurrency exceeded",
                })}
              </Tag>
            ) : null}
            {status.warningState.dailyBudgetExceeded ? (
              <Tag color="orange">
                {t("systemSettings.llmRuntime.status.flags.dayBudget", {
                  defaultValue: "Day budget exceeded",
                })}
              </Tag>
            ) : null}
            {status.warningState.monthlyBudgetExceeded ? (
              <Tag color="orange">
                {t("systemSettings.llmRuntime.status.flags.monthBudget", {
                  defaultValue: "Month budget exceeded",
                })}
              </Tag>
            ) : null}
          </Space>

          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: "1rem", marginBottom: 0 }}
          >
            {t("systemSettings.llmRuntime.status.lastAlert", {
              defaultValue:
                "Last alert: {{time}} | decision: {{decision}} | feature: {{feature}} | type: {{requestType}}",
              time: formatDateTime(status.lastAlert.at),
              decision: status.lastAlert.decision ?? "-",
              feature: status.lastAlert.feature ?? "-",
              requestType: status.lastAlert.requestType ?? "-",
            })}
          </Typography.Paragraph>
        </Spin>
      </Card>

      <Card
        size="small"
        style={{ marginBottom: "1rem" }}
        title={t("systemSettings.llmRuntime.settingsCard.title", {
          defaultValue: "Threshold settings",
        })}
      >
        <Form layout="vertical" form={form} onFinish={handleSubmit}>
          <Row gutter={16}>
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                label={t("systemSettings.llmRuntime.fields.dailyBudgetUsd", {
                  defaultValue: "Daily budget (USD)",
                })}
                name="dailyBudgetUsd"
                rules={[{ required: true }]}
              >
                <InputNumber
                  min={0}
                  max={1_000_000}
                  step={0.1}
                  precision={4}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                label={t("systemSettings.llmRuntime.fields.monthlyBudgetUsd", {
                  defaultValue: "Monthly budget (USD)",
                })}
                name="monthlyBudgetUsd"
                rules={[{ required: true }]}
              >
                <InputNumber
                  min={0}
                  max={1_000_000}
                  step={1}
                  precision={4}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                label={t("systemSettings.llmRuntime.fields.maxConcurrency", {
                  defaultValue: "Max concurrency",
                })}
                name="maxConcurrency"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={1_024} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                label={t(
                  "systemSettings.llmRuntime.fields.alertCooldownSeconds",
                  {
                    defaultValue: "Alert cooldown (s)",
                  },
                )}
                name="alertCooldownSeconds"
                rules={[{ required: true }]}
              >
                <InputNumber min={10} max={86_400} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                label={t(
                  "systemSettings.llmRuntime.fields.requestLeaseTtlSeconds",
                  {
                    defaultValue: "Request lease TTL (s)",
                  },
                )}
                name="requestLeaseTtlSeconds"
                rules={[{ required: true }]}
              >
                <InputNumber min={15} max={3_600} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t("common.saveChanges", { defaultValue: "Save changes" })}
            </Button>
            <Button danger onClick={handleReset} loading={resetting}>
              {t("common.reset", { defaultValue: "Reset" })}
            </Button>
          </Space>
        </Form>
      </Card>

      <Card
        size="small"
        title={t("systemSettings.llmRuntime.summary.title", {
          defaultValue: "Historical summary",
        })}
        extra={
          <Select<"day" | "month">
            value={summaryWindow}
            onChange={setSummaryWindow}
            style={{ width: 140 }}
            options={[
              {
                value: "day",
                label: t("systemSettings.llmRuntime.summary.window.day", {
                  defaultValue: "Day",
                }),
              },
              {
                value: "month",
                label: t("systemSettings.llmRuntime.summary.window.month", {
                  defaultValue: "Month",
                }),
              },
            ]}
          />
        }
      >
        <Spin spinning={summaryLoading}>
          <Row gutter={[16, 16]} style={{ marginBottom: "1rem" }}>
            <Col xs={24} md={8} xl={4}>
              <Statistic
                title={t("systemSettings.llmRuntime.summary.requests", {
                  defaultValue: "Requests",
                })}
                value={summary.totals.requestCount}
              />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Statistic
                title={t("systemSettings.llmRuntime.summary.cost", {
                  defaultValue: "Cost",
                })}
                value={summary.totals.costUsd}
                precision={6}
                prefix="$"
              />
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Statistic
                title={t("systemSettings.llmRuntime.summary.tokens", {
                  defaultValue: "Tokens",
                })}
                value={summary.totals.totalTokens}
              />
            </Col>
            <Col xs={24} md={8} xl={6}>
              <Statistic
                title={t("systemSettings.llmRuntime.summary.avgLatency", {
                  defaultValue: "Avg latency",
                })}
                value={summary.totals.avgLatencyMs}
                precision={0}
                suffix="ms"
              />
            </Col>
            <Col xs={24} md={8} xl={6}>
              <Statistic
                title={t(
                  "systemSettings.llmRuntime.summary.peakObservedConcurrency",
                  {
                    defaultValue: "Peak observed concurrency",
                  },
                )}
                value={summary.totals.peakObservedConcurrency}
              />
            </Col>
          </Row>

          <Typography.Paragraph type="secondary">
            {t("systemSettings.llmRuntime.summary.range", {
              defaultValue: "Window: {{start}} to {{end}}",
              start: formatDateTime(summary.start),
              end: formatDateTime(summary.end),
            })}
          </Typography.Paragraph>

          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}>
              <Card
                size="small"
                title={t("systemSettings.llmRuntime.summary.byFeature", {
                  defaultValue: "By feature",
                })}
              >
                <Table<LlmRuntimeSummaryGroupRow>
                  rowKey="key"
                  size="small"
                  pagination={false}
                  columns={totalsColumns}
                  dataSource={summary.byFeature}
                  scroll={{ x: 640 }}
                />
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card
                size="small"
                title={t("systemSettings.llmRuntime.summary.byModel", {
                  defaultValue: "By model",
                })}
              >
                <Table<LlmRuntimeSummaryGroupRow>
                  rowKey="key"
                  size="small"
                  pagination={false}
                  columns={totalsColumns}
                  dataSource={summary.byModel}
                  scroll={{ x: 640 }}
                />
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card
                size="small"
                title={t("systemSettings.llmRuntime.summary.byRequestType", {
                  defaultValue: "By request type",
                })}
              >
                <Table<LlmRuntimeSummaryGroupRow>
                  rowKey="key"
                  size="small"
                  pagination={false}
                  columns={totalsColumns}
                  dataSource={summary.byRequestType}
                  scroll={{ x: 640 }}
                />
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card
                size="small"
                title={t("systemSettings.llmRuntime.summary.warningBreakdown", {
                  defaultValue: "Warning breakdown",
                })}
              >
                <Table<LlmRuntimeWarningBreakdownRow>
                  rowKey={(row) => row.decision}
                  size="small"
                  pagination={false}
                  columns={warningColumns}
                  dataSource={summary.warningBreakdown}
                />
              </Card>
            </Col>
          </Row>
        </Spin>
      </Card>
    </>
  );
}

function renderDecisionTag(
  value: LlmRuntimeDecision | null,
  t: ReturnType<typeof useTranslation>["t"],
) {
  const decision = value ?? "allowed";
  if (decision === "warn_multiple") {
    return (
      <Tag color="red">
        {t("systemSettings.llmRuntime.decisions.warnMultiple", {
          defaultValue: "Multiple thresholds exceeded",
        })}
      </Tag>
    );
  }
  if (decision === "warn_concurrency") {
    return (
      <Tag color="red">
        {t("systemSettings.llmRuntime.decisions.warnConcurrency", {
          defaultValue: "Concurrency warning",
        })}
      </Tag>
    );
  }
  if (decision === "warn_daily_budget") {
    return (
      <Tag color="orange">
        {t("systemSettings.llmRuntime.decisions.warnDailyBudget", {
          defaultValue: "Daily budget warning",
        })}
      </Tag>
    );
  }
  if (decision === "warn_monthly_budget") {
    return (
      <Tag color="orange">
        {t("systemSettings.llmRuntime.decisions.warnMonthlyBudget", {
          defaultValue: "Monthly budget warning",
        })}
      </Tag>
    );
  }
  return (
    <Tag color="green">
      {t("systemSettings.llmRuntime.decisions.allowed", {
        defaultValue: "Allowed",
      })}
    </Tag>
  );
}

"use client";

import {
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Divider,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AlertMetricProvider } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";

import {
  DEFAULT_FILTER_STATE,
  type AlertDatePreset,
  type AlertFilterState,
} from "./alert-center.utils";
import type { useAlertCenterUrlState } from "./hooks/use-alert-center-url-state";

/**
 * Alert Center 筛选域（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - severity/status/provider Select、keyword 输入、today/7d/30d/custom
 *   Segmented、RangePicker、provider/时间快速标签、Reset；
 * - 220ms keyword debounce 与 URL 写回由 useAlertCenterUrlState 承载
 *   （本组件只消费 ruleKeywordInput / setRuleKeywordInput，不重写 codec）；
 * - `range=custom` 无日期瞬态与清空回退 30d 的行为由 codec + updateFilters
 *   保持（alert-center-url-state 契约测试锁定）；
 * - 筛选面板展开状态为组件内存态（不进 URL，既有行为）。
 */

const { CheckableTag } = Tag;

const PROVIDER_FILTER_OPTIONS = [
  AlertMetricProvider.EconomicAnomaly,
  AlertMetricProvider.EntitySentiment,
  AlertMetricProvider.EntityAssociation,
  AlertMetricProvider.EconomicData,
  AlertMetricProvider.SystemMetric,
  AlertMetricProvider.SystemEvent,
  AlertMetricProvider.PipelineJob,
  AlertMetricProvider.CrawlTask,
  AlertMetricProvider.RealtimeSignal,
];

const SEVERITY_OPTIONS = ["low", "medium", "high"];
const STATUS_OPTIONS = [
  "delivered",
  "pending",
  "failed",
  "confirmed",
  "ignored",
];

export interface AlertCenterFiltersProps {
  filterState: AlertFilterState;
  updateFilters: ReturnType<typeof useAlertCenterUrlState>["updateFilters"];
  ruleKeywordInput: string;
  setRuleKeywordInput: (value: string) => void;
  filteredCount: number;
  totalCount: number;
}

export function AlertCenterFilters({
  filterState,
  updateFilters,
  ruleKeywordInput,
  setRuleKeywordInput,
  filteredCount,
  totalCount,
}: AlertCenterFiltersProps) {
  const { t } = useTranslation();
  const [openFilterPanelKeys, setOpenFilterPanelKeys] = useState<string[]>(
    [],
  );

  const customRangeValue = useMemo<[Dayjs, Dayjs] | null>(() => {
    if (!filterState.customRangeMs) {
      return null;
    }
    const [start, end] = filterState.customRangeMs;
    if (typeof start !== "number" || typeof end !== "number") {
      return null;
    }
    return [dayjs(start), dayjs(end)] as [Dayjs, Dayjs];
  }, [filterState.customRangeMs]);

  const toggleProviderTag = (
    provider: (typeof PROVIDER_FILTER_OPTIONS)[number],
    checked: boolean,
  ) => {
    updateFilters({
      providers: checked
        ? [...new Set([...filterState.providers, provider])]
        : filterState.providers.filter((item) => item !== provider),
    });
  };

  const toggleTimeTag = (preset: AlertDatePreset, checked: boolean) => {
    if (checked) {
      updateFilters(
        preset === "custom"
          ? { datePreset: "custom" }
          : { datePreset: preset },
      );
      return;
    }
    if (filterState.datePreset === preset) {
      updateFilters({ datePreset: "today" });
    }
  };

  const handleResetFilters = () => {
    updateFilters({
      severities: [],
      statuses: [],
      providers: [],
      ruleKeyword: "",
      datePreset: DEFAULT_FILTER_STATE.datePreset,
      customRangeMs: null,
    });
    setRuleKeywordInput("");
  };

  return (
    <Card className="content-card">
      <Collapse
        bordered={false}
        activeKey={openFilterPanelKeys}
        onChange={(keys) =>
          setOpenFilterPanelKeys(
            Array.isArray(keys) ? keys : keys ? [keys] : [],
          )
        }
        items={[
          {
            key: "filters",
            label: t("alerts.center.filters.title"),
            children: (
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                <Row gutter={[12, 12]}>
                  <Col xs={24} md={12} xl={8}>
                    <Typography.Text type="secondary">
                      {t("alerts.center.filters.severity.label")}
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      allowClear
                      style={{ width: "100%" }}
                      value={filterState.severities}
                      onChange={(value) => updateFilters({ severities: value })}
                      options={SEVERITY_OPTIONS.map((severity) => ({
                        value: severity,
                        label: t(
                          `alerts.center.filters.severity.${severity}`,
                          {
                            defaultValue: severity,
                          },
                        ),
                      }))}
                    />
                  </Col>
                  <Col xs={24} md={12} xl={8}>
                    <Typography.Text type="secondary">
                      {t("alerts.center.filters.status.label")}
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      allowClear
                      style={{ width: "100%" }}
                      value={filterState.statuses}
                      onChange={(value) => updateFilters({ statuses: value })}
                      options={STATUS_OPTIONS.map((status) => ({
                        value: status,
                        label: t(`alerts.center.filters.status.${status}`, {
                          defaultValue: status,
                        }),
                      }))}
                    />
                  </Col>
                  <Col xs={24} md={12} xl={8}>
                    <Typography.Text type="secondary">
                      {t("alerts.center.filters.provider.label")}
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      allowClear
                      style={{ width: "100%" }}
                      value={filterState.providers}
                      onChange={(value) => updateFilters({ providers: value })}
                      options={PROVIDER_FILTER_OPTIONS.map((provider) => ({
                        value: provider,
                        label: t(`alerts.metricProviders.${provider}`, {
                          defaultValue: provider,
                        }),
                      }))}
                    />
                  </Col>
                  <Col xs={24} md={12} xl={12}>
                    <Typography.Text type="secondary">
                      {t("alerts.center.filters.ruleKeyword.label")}
                    </Typography.Text>
                    <Input
                      allowClear
                      value={ruleKeywordInput}
                      onChange={(event) =>
                        setRuleKeywordInput(event.target.value)
                      }
                      placeholder={t(
                        "alerts.center.filters.ruleKeyword.placeholder",
                      )}
                    />
                  </Col>
                  <Col xs={24} md={12} xl={12}>
                    <Typography.Text type="secondary">
                      {t("alerts.center.filters.time.label")}
                    </Typography.Text>
                    <Space
                      direction="vertical"
                      size={8}
                      style={{ width: "100%" }}
                    >
                      <Segmented
                        block
                        options={[
                          {
                            label: t("alerts.center.filters.time.today"),
                            value: "today",
                          },
                          {
                            label: t("alerts.center.filters.time.last7Days"),
                            value: "7d",
                          },
                          {
                            label: t(
                              "alerts.center.filters.time.last30Days",
                            ),
                            value: "30d",
                          },
                          {
                            label: t("alerts.center.filters.time.custom"),
                            value: "custom",
                          },
                        ]}
                        value={filterState.datePreset}
                        onChange={(value) =>
                          updateFilters(
                            value === "custom"
                              ? { datePreset: "custom" }
                              : { datePreset: value as AlertDatePreset },
                          )
                        }
                      />
                      <DatePicker.RangePicker
                        style={{ width: "100%" }}
                        value={customRangeValue}
                        disabled={filterState.datePreset !== "custom"}
                        onChange={(values) => {
                          const [start, end] = values ?? [];
                          updateFilters({
                            customRangeMs:
                              start && end
                                ? [start.valueOf(), end.valueOf()]
                                : [null, null],
                          });
                        }}
                      />
                    </Space>
                  </Col>
                </Row>

                <Space wrap>
                  <Button onClick={handleResetFilters}>
                    {t("common.reset")}
                  </Button>
                  <Typography.Text type="secondary">
                    {t("alerts.center.filters.resultCount", {
                      count: filteredCount,
                      total: totalCount,
                    })}
                  </Typography.Text>
                </Space>
              </Space>
            ),
          },
        ]}
      />

      <Divider style={{ margin: "12px 0" }} />

      <Space wrap size={[8, 8]}>
        <Typography.Text type="secondary">
          {t("alerts.center.quickTags.title")}
        </Typography.Text>
        <CheckableTag
          checked={filterState.providers.includes(
            AlertMetricProvider.EconomicAnomaly,
          )}
          onChange={(checked) =>
            toggleProviderTag(
              AlertMetricProvider.EconomicAnomaly,
              checked,
            )
          }
        >
          {t("alerts.center.quickTags.economicAnomaly")}
        </CheckableTag>
        <CheckableTag
          checked={filterState.providers.includes(
            AlertMetricProvider.EntitySentiment,
          )}
          onChange={(checked) => toggleProviderTag(
              AlertMetricProvider.EntitySentiment,
              checked,
            )}
        >
          {t("alerts.center.quickTags.entitySentiment")}
        </CheckableTag>
        <CheckableTag
          checked={filterState.providers.includes(
            AlertMetricProvider.EntityAssociation,
          )}
          onChange={(checked) =>
            toggleProviderTag(
              AlertMetricProvider.EntityAssociation,
              checked,
            )
          }
        >
          {t("alerts.center.quickTags.entityAssociation")}
        </CheckableTag>
        <CheckableTag
          checked={filterState.providers.includes(
            AlertMetricProvider.RealtimeSignal,
          )}
          onChange={(checked) =>
            toggleProviderTag(AlertMetricProvider.RealtimeSignal, checked)
          }
        >
          {t("alerts.center.quickTags.realtimeSignal")}
        </CheckableTag>
        <CheckableTag
          checked={filterState.datePreset === "7d"}
          onChange={(checked) => toggleTimeTag("7d", checked)}
        >
          {t("alerts.center.quickTags.last7Days")}
        </CheckableTag>
        <CheckableTag
          checked={filterState.datePreset === "30d"}
          onChange={(checked) => toggleTimeTag("30d", checked)}
        >
          {t("alerts.center.quickTags.last30Days")}
        </CheckableTag>
      </Space>
    </Card>
  );
}

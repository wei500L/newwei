"use client";

import { Button, Card, Empty, Form, InputNumber, List, Modal, Select, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

interface UserDigestPreferenceV1 {
  version: 1;
  focusEntities: string[];
  focusTopics: string[];
  windowDays: number;
  maxEvents: number;
  includeIndicators: boolean;
  maxIndicatorsPerEvent: number;
}

interface UserDigestSentimentSnapshotV1 {
  bucketStart: string;
  totalDocs: number;
  avgScore: number;
  negativeRatio: number;
}

interface UserDigestLatestBacktestV1 {
  createdAt: string;
  metrics?: unknown;
}

interface UserDigestIndicatorAssociationV1 {
  scopeType: "entity" | "topic";
  featureMetric: "volume" | "avg_score" | "negative_ratio";
  indicatorSlug: string;
  indicatorDisplayName: string;
  lagDays: number;
  correlation: number;
  pValue: number | null;
  latestBacktest?: UserDigestLatestBacktestV1 | null;
}

interface UserDigestEventV1 {
  eventId: string;
  title: string | null;
  summary: string | null;
  primaryTopic: string | null;
  primaryEntity: string | null;
  startAt: string;
  lastAt: string;
  itemCount: number;
  representativeUrl: string | null;
  topicSentiment?: UserDigestSentimentSnapshotV1 | null;
  entitySentiment?: UserDigestSentimentSnapshotV1 | null;
  indicatorAssociations?: UserDigestIndicatorAssociationV1[];
}

interface UserDigestV1 {
  version: 1;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  preference: UserDigestPreferenceV1;
  events: UserDigestEventV1[];
}

interface PreferenceFormValues {
  focusEntities: string[];
  focusTopics: string[];
  windowDays: number;
  maxEvents: number;
  includeIndicators: boolean;
  maxIndicatorsPerEvent: number;
}

const EMPTY_PREFERENCE: UserDigestPreferenceV1 = {
  version: 1,
  focusEntities: [],
  focusTopics: [],
  windowDays: 3,
  maxEvents: 8,
  includeIndicators: true,
  maxIndicatorsPerEvent: 5
};

const normalizeTagValues = (values: string[]) => {
  const trimmed = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(trimmed)).slice(0, 50);
};

function formatSigned(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

function percent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}

export function UserDigestPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session } = useSession();
  const apiClient = useMemo(() => createApiClient({ accessToken: session?.accessToken }), [session?.accessToken]);

  const [messageApi, contextHolder] = message.useMessage();
  const [loadingPreference, setLoadingPreference] = useState(false);
  const [loadingDigest, setLoadingDigest] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const [preference, setPreference] = useState<UserDigestPreferenceV1>(EMPTY_PREFERENCE);
  const [digest, setDigest] = useState<UserDigestV1 | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<PreferenceFormValues>();

  const loadPreference = useCallback(async () => {
    setLoadingPreference(true);
    try {
      const response = await apiClient.get<UserDigestPreferenceV1>("user-digest/preference");
      setPreference(response.data ?? EMPTY_PREFERENCE);
      form.setFieldsValue({
        focusEntities: response.data?.focusEntities ?? [],
        focusTopics: response.data?.focusTopics ?? [],
        windowDays: response.data?.windowDays ?? EMPTY_PREFERENCE.windowDays,
        maxEvents: response.data?.maxEvents ?? EMPTY_PREFERENCE.maxEvents,
        includeIndicators: response.data?.includeIndicators ?? EMPTY_PREFERENCE.includeIndicators,
        maxIndicatorsPerEvent: response.data?.maxIndicatorsPerEvent ?? EMPTY_PREFERENCE.maxIndicatorsPerEvent
      });
    } catch (err) {
      captureClientError("Failed to load user digest preference", err);
      setErrorMessage(t("pages.digest.preferenceLoadFailed", { defaultValue: "Failed to load digest preference." }));
    } finally {
      setLoadingPreference(false);
    }
  }, [apiClient, form, t]);

  const loadDigest = useCallback(async () => {
    setLoadingDigest(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<UserDigestV1>("user-digest");
      setDigest(response.data ?? null);
    } catch (err) {
      captureClientError("Failed to load user digest", err);
      setErrorMessage(t("pages.digest.loadFailed", { defaultValue: "Failed to generate digest." }));
      setDigest(null);
    } finally {
      setLoadingDigest(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void loadPreference();
    void loadDigest();
  }, [loadDigest, loadPreference]);

  const handleOpenModal = () => {
    form.setFieldsValue({
      focusEntities: preference.focusEntities,
      focusTopics: preference.focusTopics,
      windowDays: preference.windowDays,
      maxEvents: preference.maxEvents,
      includeIndicators: preference.includeIndicators,
      maxIndicatorsPerEvent: preference.maxIndicatorsPerEvent
    });
    setModalOpen(true);
  };

  const handleSavePreference = async (values: PreferenceFormValues) => {
    setSavingPreference(true);
    try {
      const payload: Partial<UserDigestPreferenceV1> = {
        focusEntities: normalizeTagValues(values.focusEntities ?? []),
        focusTopics: normalizeTagValues(values.focusTopics ?? []),
        windowDays: values.windowDays,
        maxEvents: values.maxEvents,
        includeIndicators: values.includeIndicators,
        maxIndicatorsPerEvent: values.maxIndicatorsPerEvent
      };
      const response = await apiClient.put<UserDigestPreferenceV1>("user-digest/preference", payload);
      const updated = response.data ?? preference;
      setPreference(updated);
      messageApi.success(t("pages.digest.saved", { defaultValue: "Saved." }));
      setModalOpen(false);
      await loadDigest();
    } catch (err) {
      captureClientError("Failed to save user digest preference", err);
      messageApi.error(t("pages.digest.saveFailed", { defaultValue: "Failed to save." }));
    } finally {
      setSavingPreference(false);
    }
  };

  const events = digest?.events ?? [];
  const generatedAt = digest?.generatedAt ?? null;

  const preferenceSummary = useMemo(() => {
    const focusBits: string[] = [];
    if (preference.focusTopics.length > 0) {
      focusBits.push(`${t("pages.digest.focusTopics", { defaultValue: "Topics" })}: ${preference.focusTopics.length}`);
    }
    if (preference.focusEntities.length > 0) {
      focusBits.push(`${t("pages.digest.focusEntities", { defaultValue: "Entities" })}: ${preference.focusEntities.length}`);
    }
    return focusBits.length > 0 ? focusBits.join(" · ") : null;
  }, [preference.focusEntities.length, preference.focusTopics.length, t]);

  const loading = loadingPreference || loadingDigest;

  return (
    <>
      {contextHolder}
      <Card
        className="content-card"
        title={t("pages.digest.title", { defaultValue: "Personalized Digest" })}
        extra={
          <Space>
            <Button onClick={() => loadDigest()} loading={loadingDigest}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Button onClick={handleOpenModal} disabled={loadingPreference}>
              {t("pages.digest.customize", { defaultValue: "Customize" })}
            </Button>
          </Space>
        }
      >
        {loading && !digest ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "1.5rem 0" }}>
            <Spin />
          </div>
        ) : errorMessage ? (
          <Typography.Text type="danger">{errorMessage}</Typography.Text>
        ) : digest ? (
          <div className="flex flex-col gap-3">
            <Space wrap size={[8, 8]}>
              <Tag>
                {t("pages.digest.window", { defaultValue: "Window" })}: {digest.preference.windowDays}d
              </Tag>
              <Tag>
                {t("pages.digest.maxEvents", { defaultValue: "Max events" })}: {digest.preference.maxEvents}
              </Tag>
              {digest.preference.includeIndicators ? (
                <Tag color="green">
                  {t("pages.digest.indicatorsOn", { defaultValue: "Indicators on" })}
                </Tag>
              ) : (
                <Tag color="default">{t("pages.digest.indicatorsOff", { defaultValue: "Indicators off" })}</Tag>
              )}
              {preferenceSummary ? <Tag>{preferenceSummary}</Tag> : null}
              {generatedAt ? (
                <Tag>
                  {t("pages.digest.generatedAt", { defaultValue: "Generated" })}:{" "}
                  {formatDateTime(generatedAt, locale, { dateStyle: "medium", timeStyle: "short" })}
                </Tag>
              ) : null}
            </Space>

            {events.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.digest.empty", {
                  defaultValue: "No digest events yet. Enable News Events ingestion and wait for it to backfill."
                })}
              >
                <Button type="primary" onClick={() => router.push("/events")}>
                  {t("pages.digest.emptyCta", { defaultValue: "View events" })}
                </Button>
              </Empty>
            ) : (
              <List
                dataSource={events}
                renderItem={(event) => {
                  const title =
                    event.title?.trim() ||
                    event.primaryEntity?.trim() ||
                    event.primaryTopic?.trim() ||
                    event.eventId;
                  const url = safeHttpUrl(event.representativeUrl ?? undefined);
                  const topic = event.primaryTopic?.trim() ?? "";
                  const entity = event.primaryEntity?.trim() ?? "";
                  const topicSentiment = event.topicSentiment ?? null;
                  const entitySentiment = event.entitySentiment ?? null;
                  const associations = event.indicatorAssociations ?? [];

                  return (
                    <List.Item
                      key={event.eventId}
                      extra={
                        url ? (
                          <a href={url} target="_blank" rel="noreferrer">
                            {t("pages.digest.openSource", { defaultValue: "Open" })}
                          </a>
                        ) : null
                      }
                    >
                      <List.Item.Meta
                        title={
                          <Space wrap size={[6, 6]}>
                            <Typography.Text strong>{title}</Typography.Text>
                            <Tag>{t("pages.digest.items", { defaultValue: "Items" })}: {event.itemCount}</Tag>
                            {topic ? <Tag color="geekblue">{topic}</Tag> : null}
                            {entity ? <Tag color="purple">{entity}</Tag> : null}
                            <Tag>
                              {formatDateTime(event.lastAt, locale, { dateStyle: "medium" })}
                            </Tag>
                          </Space>
                        }
                        description={
                          <div className="flex flex-col gap-2">
                            {event.summary ? (
                              <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                                {event.summary}
                              </Typography.Paragraph>
                            ) : null}

                            <Space wrap size={[6, 6]}>
                              {topicSentiment ? (
                                <Tag color="blue">
                                  {t("pages.digest.topicSentiment", { defaultValue: "Topic sentiment" })}:{" "}
                                  {formatSigned(topicSentiment.avgScore) ?? "-"} / {percent(topicSentiment.negativeRatio) ?? "-"}
                                </Tag>
                              ) : null}
                              {entitySentiment ? (
                                <Tag color="purple">
                                  {t("pages.digest.entitySentiment", { defaultValue: "Entity sentiment" })}:{" "}
                                  {formatSigned(entitySentiment.avgScore) ?? "-"} / {percent(entitySentiment.negativeRatio) ?? "-"}
                                </Tag>
                              ) : null}
                            </Space>

                            {associations.length > 0 ? (
                              <Space wrap size={[6, 6]}>
                                {associations.slice(0, 4).map((assoc) => (
                                  <Tag key={`${event.eventId}-${assoc.indicatorSlug}`} color="green">
                                    {assoc.indicatorDisplayName} ({formatSigned(assoc.correlation) ?? "-"}, {assoc.lagDays}d)
                                  </Tag>
                                ))}
                              </Space>
                            ) : null}
                          </div>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("pages.digest.empty", { defaultValue: "No digest yet." })}
          />
        )}
      </Card>

      <Modal
        open={modalOpen}
        title={t("pages.digest.preferences.title", { defaultValue: "Digest Preferences" })}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={savingPreference}
        okText={t("common.saveChanges", { defaultValue: "Save changes" })}
        cancelText={t("common.cancel", { defaultValue: "Cancel" })}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleSavePreference}>
          <Form.Item
            label={t("pages.digest.preferences.windowDays", { defaultValue: "Window days" })}
            name="windowDays"
            rules={[{ required: true, message: t("pages.digest.preferences.required", { defaultValue: "Required" }) }]}
          >
            <InputNumber min={1} max={30} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.preferences.maxEvents", { defaultValue: "Max events" })}
            name="maxEvents"
            rules={[{ required: true, message: t("pages.digest.preferences.required", { defaultValue: "Required" }) }]}
          >
            <InputNumber min={1} max={30} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.preferences.focusTopics", { defaultValue: "Focus topics" })}
            name="focusTopics"
            extra={t("pages.digest.preferences.focusTopicsHint", { defaultValue: "Optional; leave empty for global feed." })}
          >
            <Select
              mode="tags"
              tokenSeparators={[",", "\n", "\t"]}
              placeholder={t("pages.digest.preferences.focusTopicsPlaceholder", { defaultValue: "Enter topics" })}
            />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.preferences.focusEntities", { defaultValue: "Focus entities" })}
            name="focusEntities"
            extra={t("pages.digest.preferences.focusEntitiesHint", { defaultValue: "Optional; leave empty for global feed." })}
          >
            <Select
              mode="tags"
              tokenSeparators={[",", "\n", "\t"]}
              placeholder={t("pages.digest.preferences.focusEntitiesPlaceholder", { defaultValue: "Enter entities" })}
            />
          </Form.Item>

          <Form.Item label={t("pages.digest.preferences.includeIndicators", { defaultValue: "Include indicators" })} name="includeIndicators" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.preferences.maxIndicatorsPerEvent", { defaultValue: "Max indicators per event" })}
            name="maxIndicatorsPerEvent"
            rules={[{ required: true, message: t("pages.digest.preferences.required", { defaultValue: "Required" }) }]}
          >
            <InputNumber min={0} max={50} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

"use client";

import { MoreOutlined } from "@ant-design/icons";
import { Alert, Button, Dropdown, Form, InputNumber, List, Modal, Select, Switch, TimePicker, Typography, message } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DataStateBoundary, type DataStateBoundaryState } from "@/components/data-state-boundary";
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
  windowDays: number;
  maxEvents: number;
  includeIndicators: boolean;
  maxIndicatorsPerEvent: number;
}

interface UserDigestDeliverySettingsV1 {
  version: 1;
  enabled: boolean;
  time: string;
  timezone: string;
  targetEmail: string;
  emailVerified: boolean;
  nextRunAt: string | null;
  lastSentAt: string | null;
  lastStatus: "idle" | "sent" | "empty_notified" | "failed";
  lastStatusAt: string | null;
  lastError: string | null;
}

interface DeliveryFormValues {
  enabled: boolean;
  time: dayjs.Dayjs;
  timezone: string;
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

const DEFAULT_DELIVERY: UserDigestDeliverySettingsV1 = {
  version: 1,
  enabled: false,
  time: "09:00",
  timezone: "UTC",
  targetEmail: "",
  emailVerified: false,
  nextRunAt: null,
  lastSentAt: null,
  lastStatus: "idle",
  lastStatusAt: null,
  lastError: null
};

function getSupportedTimezones() {
  try {
    const values = (
      Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    return Array.isArray(values) && values.length > 0 ? values : ["UTC"];
  } catch {
    return ["UTC"];
  }
}

export function UserDigestPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const { data: session } = useSession();
  const apiClient = useMemo(() => createApiClient({ accessToken: session?.accessToken }), [session?.accessToken]);

  const [messageApi, contextHolder] = message.useMessage();
  const [deliveryForm] = Form.useForm<DeliveryFormValues>();
  const [loadingPreference, setLoadingPreference] = useState(false);
  const [loadingDigest, setLoadingDigest] = useState(false);
  const [loadingDelivery, setLoadingDelivery] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [preference, setPreference] = useState<UserDigestPreferenceV1>(EMPTY_PREFERENCE);
  const [digest, setDigest] = useState<UserDigestV1 | null>(null);
  const [delivery, setDelivery] = useState<UserDigestDeliverySettingsV1>(DEFAULT_DELIVERY);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deliveryErrorMessage, setDeliveryErrorMessage] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deliveryModalOpen, setDeliveryModalOpen] = useState(false);
  const [browserTimezone] = useState<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });
  const timezoneOptions = useMemo(
    () => getSupportedTimezones().map((value) => ({ label: value, value })),
    []
  );

  const loadPreference = useCallback(async () => {
    setLoadingPreference(true);
    try {
      const response = await apiClient.get<UserDigestPreferenceV1>("user-digest/preference");
      setPreference(response.data ?? EMPTY_PREFERENCE);
    } catch (err) {
      captureClientError("Failed to load user digest preference", err);
      setErrorMessage(t("pages.digest.preferenceLoadFailed"));
    } finally {
      setLoadingPreference(false);
    }
  }, [apiClient, t]);

  const loadDigest = useCallback(async () => {
    setLoadingDigest(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<UserDigestV1>("user-digest");
      setDigest(response.data ?? null);
    } catch (err) {
      captureClientError("Failed to load user digest", err);
      setErrorMessage(t("pages.digest.loadFailed"));
      setDigest(null);
    } finally {
      setLoadingDigest(false);
    }
  }, [apiClient, t]);

  const loadDelivery = useCallback(async () => {
    setLoadingDelivery(true);
    setDeliveryErrorMessage(null);
    try {
      const response = await apiClient.get<UserDigestDeliverySettingsV1>("user-digest/delivery");
      setDelivery(response.data ?? DEFAULT_DELIVERY);
    } catch (err) {
      captureClientError("Failed to load user digest delivery settings", err);
      setDeliveryErrorMessage(
        t("pages.digest.deliveryLoadFailed")
      );
    } finally {
      setLoadingDelivery(false);
    }
  }, [apiClient, t]);

  useEffect(() => {
    void loadPreference();
    void loadDigest();
    void loadDelivery();
  }, [loadDelivery, loadDigest, loadPreference]);

  const handleOpenModal = () => {
    setModalOpen(true);
  };

  const handleOpenDeliveryModal = () => {
    deliveryForm.setFieldsValue({
      enabled: delivery.enabled,
      time: dayjs(`2026-01-01T${delivery.time || "09:00"}:00`),
      timezone: delivery.timezone || browserTimezone,
    });
    setDeliveryModalOpen(true);
  };

  const handleSavePreference = async (values: PreferenceFormValues) => {
    setSavingPreference(true);
    try {
      const payload: Partial<UserDigestPreferenceV1> = {
        windowDays: values.windowDays,
        maxEvents: values.maxEvents,
        includeIndicators: values.includeIndicators,
        maxIndicatorsPerEvent: values.maxIndicatorsPerEvent
      };
      const response = await apiClient.put<UserDigestPreferenceV1>("user-digest/preference", payload);
      const updated = response.data ?? preference;
      setPreference(updated);
      messageApi.success(t("pages.digest.saved"));
      setModalOpen(false);
      await loadDigest();
    } catch (err) {
      captureClientError("Failed to save user digest preference", err);
      messageApi.error(t("pages.digest.saveFailed"));
    } finally {
      setSavingPreference(false);
    }
  };

  const handleSaveDelivery = async (values: DeliveryFormValues) => {
    setSavingDelivery(true);
    try {
      const response = await apiClient.put<UserDigestDeliverySettingsV1>(
        "user-digest/delivery",
        {
          enabled: values.enabled,
          time: values.time.format("HH:mm"),
          timezone: values.timezone.trim(),
        }
      );
      setDelivery(response.data ?? delivery);
      messageApi.success(t("pages.digest.deliverySaved"));
      setDeliveryModalOpen(false);
    } catch (err) {
      captureClientError("Failed to save user digest delivery settings", err);
      messageApi.error(t("pages.digest.deliverySaveFailed"));
    } finally {
      setSavingDelivery(false);
    }
  };

  const events = digest?.events ?? [];
  const generatedAt = digest?.generatedAt ?? null;

  const loading = loadingPreference || loadingDigest || loadingDelivery;
  const deliveryStatusLabel =
    delivery.lastStatus === "sent"
      ? t("pages.digest.deliveryStatus.sent")
      : delivery.lastStatus === "failed"
        ? t("pages.digest.deliveryStatus.failed")
        : delivery.lastStatus === "empty_notified"
          ? t("pages.digest.deliveryStatus.empty")
          : t("pages.digest.deliveryStatus.idle");

  const digestState: DataStateBoundaryState =
    loading && !digest
      ? { kind: "initialLoading" }
      : errorMessage
        ? {
            kind: "blockingError",
            error: errorMessage,
            errorStateOverride: {
              variant: "error",
              title: t("common.requestFailed"),
              description: errorMessage,
            },
          }
        : loading
          ? { kind: "refreshing" }
          : digest
            ? { kind: "ready" }
            : { kind: "empty" };

  return (
    <>
      {contextHolder}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-end gap-2">
          <Button onClick={handleOpenModal} disabled={loadingPreference} size="small" type="primary">
            {t("pages.digest.customize")}
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "refresh",
                  label: t("common.refresh"),
                  disabled: loadingDigest,
                  onClick: () => void loadDigest(),
                },
                {
                  key: "subscriptions",
                  label: t("pages.digest.manageSubscriptions"),
                  onClick: () => router.push("/subscriptions?tab=content"),
                },
                {
                  key: "delivery",
                  label: t("pages.digest.delivery.customize"),
                  disabled: loadingDelivery,
                  onClick: handleOpenDeliveryModal,
                },
              ],
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label={t("common.more")} />
          </Dropdown>
        </div>
        <DataStateBoundary
          state={digestState}
          emptyDescription={t("pages.digest.empty")}
        >
          {digest ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 font-mono text-xs text-muted-foreground">
              {digest.preference.windowDays}d · {t("pages.digest.maxEvents")} {digest.preference.maxEvents}
              {generatedAt ? ` · ${formatDateTime(generatedAt, locale, { dateStyle: "medium", timeStyle: "short" })}` : ""}
              {` · ${deliveryStatusLabel}`}
            </p>

            {!delivery.emailVerified ? (
              <Alert
                type="info"
                showIcon
                message={t("pages.digest.delivery.emailRequired")}
                action={
                  <Button size="small" onClick={() => router.push("/profile")}>
                    {t("pages.digest.delivery.openProfile")}
                  </Button>
                }
              />
            ) : null}

            {deliveryErrorMessage ? (
              <Alert
                type="warning"
                showIcon
                message={deliveryErrorMessage}
              />
            ) : null}

            {delivery.lastError ? (
              <Alert
                type="warning"
                showIcon
                message={t("pages.digest.delivery.lastError")}
                description={delivery.lastError}
              />
            ) : null}

            {events.length === 0 ? (
              <DataStateBoundary
                state={{ kind: "empty" }}
                emptyDescription={
                  <div className="flex flex-col items-center gap-2">
                    <span>{t("pages.digest.empty")}</span>
                    <Button size="small" onClick={() => router.push("/events")}>
                      {t("pages.digest.emptyCta")}
                    </Button>
                  </div>
                }
              />
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

                  return (
                    <List.Item key={event.eventId}>
                      <List.Item.Meta
                        title={<span className="text-sm font-semibold">{title}</span>}
                        description={
                          <div className="flex flex-col gap-1">
                            <p className="m-0 font-mono text-xs text-muted-foreground">
                              {[
                                `${t("pages.digest.items")} ${event.itemCount}`,
                                topic || null,
                                entity || null,
                                formatDateTime(event.lastAt, locale, { dateStyle: "medium" }),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                            {url ? (
                              <a href={url} target="_blank" rel="noreferrer" className="text-xs">
                                {t("pages.digest.openSource")}
                              </a>
                            ) : null}
                            {event.summary ? (
                              <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} className="!mb-0 text-sm">
                                {event.summary}
                              </Typography.Paragraph>
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
          ) : null}
        </DataStateBoundary>
      </div>

      <Modal
        open={modalOpen}
        title={t("pages.digest.preferences.title")}
        onCancel={() => setModalOpen(false)}
        confirmLoading={savingPreference}
        okButtonProps={{ htmlType: "submit", form: "user-digest-preference-form" }}
        okText={t("common.saveChanges")}
        cancelText={t("common.cancel")}
        destroyOnHidden
      >
        <Form
          id="user-digest-preference-form"
          layout="vertical"
          initialValues={{
            windowDays: preference.windowDays,
            maxEvents: preference.maxEvents,
            includeIndicators: preference.includeIndicators,
            maxIndicatorsPerEvent: preference.maxIndicatorsPerEvent
          }}
          onFinish={handleSavePreference}
        >
          <Typography.Paragraph type="secondary">
            {t("pages.digest.preferences.contentSubscriptionHint")}
          </Typography.Paragraph>

          <Form.Item
            label={t("pages.digest.preferences.windowDays")}
            name="windowDays"
            rules={[{ required: true, message: t("pages.digest.preferences.required") }]}
          >
            <InputNumber min={1} max={30} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.preferences.maxEvents")}
            name="maxEvents"
            rules={[{ required: true, message: t("pages.digest.preferences.required") }]}
          >
            <InputNumber min={1} max={30} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item label={t("pages.digest.preferences.includeIndicators")} name="includeIndicators" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.preferences.maxIndicatorsPerEvent")}
            name="maxIndicatorsPerEvent"
            rules={[{ required: true, message: t("pages.digest.preferences.required") }]}
          >
            <InputNumber min={0} max={50} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={deliveryModalOpen}
        title={t("pages.digest.delivery.title")}
        onCancel={() => setDeliveryModalOpen(false)}
        confirmLoading={savingDelivery}
        okButtonProps={{ htmlType: "submit", form: "user-digest-delivery-form" }}
        okText={t("common.saveChanges")}
        cancelText={t("common.cancel")}
        destroyOnHidden
      >
        <Form
          id="user-digest-delivery-form"
          layout="vertical"
          form={deliveryForm}
          onFinish={handleSaveDelivery}
          initialValues={{
            enabled: delivery.enabled,
            time: dayjs(`2026-01-01T${delivery.time}:00`),
            timezone: delivery.timezone || browserTimezone,
          }}
        >
          <Typography.Paragraph type="secondary">
            {t("pages.digest.delivery.description")}
          </Typography.Paragraph>

          <Form.Item
            label={t("pages.digest.delivery.targetEmail")}
          >
            <Typography.Text>{delivery.targetEmail || t("common.notAvailable")}</Typography.Text>
          </Form.Item>

          <Form.Item
            label={t("pages.digest.delivery.enabledLabel")}
            name="enabled"
            valuePropName="checked"
            extra={
              !delivery.emailVerified
                ? t("pages.digest.delivery.verifyFirst")
                : undefined
            }
          >
            <Switch disabled={!delivery.emailVerified} />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.delivery.time")}
            name="time"
            rules={[{ required: true, message: t("pages.digest.preferences.required") }]}
          >
            <TimePicker format="HH:mm" minuteStep={5} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item
            label={t("pages.digest.delivery.timezone")}
            name="timezone"
            rules={[{ required: true, message: t("pages.digest.preferences.required") }]}
          >
            <Select
              showSearch
              options={timezoneOptions}
              optionFilterProp="label"
              placeholder={t("pages.digest.delivery.timezonePlaceholder")}
            />
          </Form.Item>

          {delivery.lastSentAt ? (
            <Typography.Paragraph type="secondary" className="!mb-0">
              {t("pages.digest.delivery.lastSentAt")}:{" "}
              {formatDateTime(delivery.lastSentAt, locale, { dateStyle: "medium", timeStyle: "short" })}
            </Typography.Paragraph>
          ) : null}
        </Form>
      </Modal>
    </>
  );
}

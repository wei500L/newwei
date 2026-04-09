"use client";

import {
  App,
  Badge,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { FormProps } from "antd";
import type { Dayjs } from "dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import {
  AlertChannelType,
  NotificationType,
  useAlertEventsQuery,
  useAlertRulesQuery,
  useAlertChannelsQuery,
  useCreateAlertChannelMutation,
  useDeleteAlertChannelMutation,
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
  useUpdateAlertChannelMutation,
  useUpsertAlertRuleMutation,
  useUnreadNotificationCountQuery,
} from "@/graphql/generated";
import dayjs, { toUtcIsoString } from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  formatNotificationPresentation,
  resolveNotificationLink,
} from "@/lib/notifications";

import { ContentSubscriptionsTab } from "./content-subscriptions-tab";

const typeColor: Record<NotificationType, string> = {
  [NotificationType.CrawlCompleted]: "green",
  [NotificationType.CrawlFailed]: "red",
  [NotificationType.AnalysisCompleted]: "blue",
  [NotificationType.AnalysisFailed]: "red",
  [NotificationType.OrgInvite]: "purple",
  [NotificationType.AlertTriggered]: "orange",
  [NotificationType.System]: "geekblue",
};

const CHANNEL_MODAL_FORM_ID = "subscriptions-channel-form";

interface ChannelFormValues {
  id?: string;
  name: string;
  type: AlertChannelType.Email | AlertChannelType.Webhook;
  target: string;
  isActive?: boolean;
  muteUntil?: Dayjs | null;
  notifyIntervalSeconds?: number | null;
}

const buildThresholdSummary = (
  operator: string | null | undefined,
  thresholdValue: number | undefined,
  lower: number | undefined,
  upper: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) => {
  if (!operator) {
    return t("common.notAvailable");
  }
  const operatorSymbolMap: Record<string, string> = {
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    eq: "=",
  };
  if (operator === "outside_range" || operator === "within_range") {
    if (lower === undefined || upper === undefined) {
      return t("common.notAvailable");
    }
    const range = `${lower} - ${upper}`;
    return t(
      operator === "outside_range"
        ? "alerts.center.threshold.outside"
        : "alerts.center.threshold.within",
      {
        defaultValue: `${operator === "outside_range" ? "Outside" : "Within"} ${range}`,
        range,
      },
    );
  }
  if (operator === "change_up_pct" || operator === "change_down_pct") {
    if (thresholdValue === undefined) {
      return t("common.notAvailable");
    }
    const symbol = operator === "change_up_pct" ? ">=" : "<=";
    return t("alerts.center.threshold.changePct", {
      defaultValue: `Change ${symbol} ${thresholdValue}%`,
      symbol,
      value: thresholdValue,
    });
  }
  if (thresholdValue === undefined) {
    return t("common.notAvailable");
  }
  const symbol = operatorSymbolMap[operator] ?? operator;
  return `${symbol} ${thresholdValue}`;
};

const formatContextValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatContextValue(item))
      .filter(Boolean)
      .join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return undefined;
};

const parseDateValue = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed : null;
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const extractMuteUntil = (config: Record<string, unknown> | null) => {
  const raw =
    config?.muteUntil ??
    config?.mutedUntil ??
    config?.silenceUntil ??
    config?.silencedUntil ??
    config?.mute_until ??
    config?.muted_until ??
    null;
  return parseDateValue(raw);
};

const extractNotifyIntervalSeconds = (
  config: Record<string, unknown> | null,
) => {
  const rawSeconds =
    config?.notifyIntervalSeconds ??
    config?.notifyIntervalSec ??
    config?.notify_interval_seconds ??
    config?.notify_interval_sec ??
    config?.frequencySeconds ??
    config?.frequencySec ??
    config?.frequency_seconds ??
    config?.frequency_sec ??
    config?.minIntervalSeconds ??
    config?.minIntervalSec ??
    config?.min_interval_seconds ??
    config?.min_interval_sec ??
    null;
  const rawMinutes =
    config?.notifyIntervalMinutes ??
    config?.notifyIntervalMin ??
    config?.notify_interval_minutes ??
    config?.notify_interval_min ??
    config?.frequencyMinutes ??
    config?.frequencyMin ??
    config?.frequency_minutes ??
    config?.frequency_min ??
    null;

  const parsePositive = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 0 ? value : null;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  };

  const seconds = parsePositive(rawSeconds);
  if (seconds !== null) {
    return Math.max(1, Math.trunc(seconds));
  }
  const minutes = parsePositive(rawMinutes);
  if (minutes !== null) {
    return Math.max(1, Math.trunc(minutes * 60));
  }
  return null;
};

const extractAlertEventId = (
  payload: Record<string, unknown> | null | undefined,
): string | undefined => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const rawId = payload.alertEventId ?? payload.eventId;
  return typeof rawId === "string" && rawId.trim().length > 0
    ? rawId
    : undefined;
};

const extractRuleId = (
  payload: Record<string, unknown> | null | undefined,
): string | undefined => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const rawId = payload.ruleId;
  return typeof rawId === "string" && rawId.trim().length > 0
    ? rawId
    : undefined;
};

export default function SubscriptionsPage() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session, status: sessionStatus } = useSession();
  const authenticated = sessionStatus === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadAlerts = permissions.includes("alerts.read");
  const canManageAlerts = permissions.includes("alerts.manage");
  const activeTab = useMemo(() => {
    const value = searchParams.get("tab");
    return value === "rules" ||
      value === "channels" ||
      value === "notifications"
      ? value
      : "content";
  }, [searchParams]);
  const {
    data: rulesData,
    loading: rulesLoading,
    refetch: refetchRules,
  } = useAlertRulesQuery({
    skip: !authenticated || !canReadAlerts,
  });
  const {
    data: channelsData,
    loading: channelsLoading,
    refetch: refetchChannels,
  } = useAlertChannelsQuery({
    skip: !authenticated || !canReadAlerts,
  });
  const {
    data: eventsData,
    loading: eventsLoading,
    refetch: refetchEvents,
  } = useAlertEventsQuery({
    variables: { limit: 50 },
    skip: !authenticated || !canReadAlerts,
  });
  const {
    data: notificationsData,
    loading: notificationsLoading,
    refetch: refetchNotifications,
  } = useNotificationsQuery({ variables: { limit: 50 } });
  const { data: unreadData, refetch: refetchUnread } =
    useUnreadNotificationCountQuery();
  const [markRead] = useMarkNotificationReadMutation();
  const [markAll] = useMarkAllNotificationsReadMutation();
  const [createChannel, { loading: creatingChannel }] =
    useCreateAlertChannelMutation();
  const [updateChannel, { loading: updatingChannel }] =
    useUpdateAlertChannelMutation();
  const [deleteChannel, { loading: deletingChannel }] =
    useDeleteAlertChannelMutation();
  const [upsertRule, { loading: updatingRule }] = useUpsertAlertRuleMutation();

  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [channelModalMode, setChannelModalMode] = useState<"create" | "edit">(
    "create",
  );
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [channelForm] = Form.useForm();

  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [activeRuleId, setActiveRuleId] = useState<string | null>(null);
  const [ruleForm] = Form.useForm();

  const unreadCount = unreadData?.unreadNotificationCount ?? 0;
  const rules = rulesData?.alertRules ?? [];
  const channels = channelsData?.alertChannels ?? [];
  const events = eventsData?.alertEvents ?? [];
  const notifications = notificationsData?.notifications ?? [];
  const isRulesInitialLoading = rulesLoading && rules.length === 0;
  const isChannelsInitialLoading = channelsLoading && channels.length === 0;
  const isEventsInitialLoading = eventsLoading && events.length === 0;
  const isNotificationsInitialLoading =
    notificationsLoading && notifications.length === 0;

  const eventById = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events],
  );
  const alertNotifications = useMemo(
    () =>
      notifications.filter(
        (item) => item.type === NotificationType.AlertTriggered,
      ),
    [notifications],
  );
  const notificationsByRuleId = useMemo(() => {
    const grouped = new Map<string, typeof alertNotifications>();
    for (const notification of alertNotifications) {
      const payload = notification.data ?? null;
      const ruleId =
        extractRuleId(payload) ??
        eventById.get(extractAlertEventId(payload) ?? "")?.ruleId;
      if (!ruleId) {
        continue;
      }
      const list = grouped.get(ruleId) ?? [];
      list.push(notification);
      grouped.set(ruleId, list);
    }
    return grouped;
  }, [alertNotifications, eventById]);
  const orderedNotifications = useMemo(() => {
    return [...notifications].sort((a, b) => {
      const aUnread = !a.readAt;
      const bUnread = !b.readAt;
      if (aUnread !== bUnread) {
        return aUnread ? -1 : 1;
      }
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [notifications]);

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeChannelId) ?? null,
    [activeChannelId, channels],
  );
  const activeRule = useMemo(
    () => rules.find((rule) => rule.id === activeRuleId) ?? null,
    [activeRuleId, rules],
  );

  useEffect(() => {
    if (!channelModalOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (channelModalMode === "create") {
        channelForm.setFieldsValue({
          name: "",
          type: AlertChannelType.Webhook,
          target: "",
          isActive: true,
          muteUntil: null,
          notifyIntervalSeconds: null,
        });
        return;
      }
      if (!activeChannel) {
        return;
      }
      const config = toRecord(activeChannel.config);
      channelForm.setFieldsValue({
        id: activeChannel.id,
        name: activeChannel.name,
        type: activeChannel.type,
        target: activeChannel.target,
        isActive: activeChannel.isActive ?? true,
        muteUntil: extractMuteUntil(config),
        notifyIntervalSeconds: extractNotifyIntervalSeconds(config),
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [activeChannel, channelForm, channelModalMode, channelModalOpen]);

  useEffect(() => {
    if (!ruleModalOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!activeRule) {
        return;
      }
      const metadata = toRecord(activeRule.metadata);
      ruleForm.setFieldsValue({
        channelIds: (activeRule.channels ?? []).map((channel) => channel.id),
        muteUntil: parseDateValue(metadata?.muteUntil),
        notifyAllMembers:
          metadata?.notifyAllMembers === true ||
          metadata?.notifyAllUsers === true,
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [activeRule, ruleForm, ruleModalOpen]);

  const resolveAlertEvent = (notification: (typeof notifications)[number]) => {
    const payload = notification.data ?? null;
    const eventId = extractAlertEventId(payload);
    return eventId ? eventById.get(eventId) : undefined;
  };

  const renderAlertEvidence = (
    notification: (typeof notifications)[number],
  ) => {
    const event = resolveAlertEvent(notification);
    const presentation = formatNotificationPresentation(
      notification,
      locale,
      t,
    );
    const context =
      event?.context &&
      typeof event.context === "object" &&
      !Array.isArray(event.context)
        ? (event.context as Record<string, unknown>)
        : null;
    const source =
      toStringValue(context?.sourceName) ??
      toStringValue(context?.sourceEndpoint) ??
      toStringValue(context?.sourceFunction) ??
      toStringValue(context?.sourceField);
    const country = toStringValue(
      context?.countryName ?? context?.countryCode ?? context?.country,
    );
    const itemName = toStringValue(context?.itemName);
    const resource = toStringValue(context?.resource);
    const action = toStringValue(context?.action);
    const statusesValue = Array.isArray(context?.statuses)
      ? (context?.statuses as unknown[])
          .map((entry) => formatContextValue(entry))
          .filter(Boolean)
          .join(", ")
      : toStringValue(context?.statuses ?? context?.status);
    const formatEvidenceNumber = (value: number, maximumFractionDigits = 2) =>
      new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
    const evidenceTags = [
      typeof event?.metricValue === "number"
        ? t("notifications.evidence.value", {
            defaultValue: "Value: {{value}}",
            value: formatEvidenceNumber(event.metricValue),
          })
        : null,
      typeof event?.changePercent === "number"
        ? t("notifications.evidence.change", {
            defaultValue: "Change: {{value}}",
            value: `${formatEvidenceNumber(event.changePercent)}%`,
          })
        : null,
      source
        ? t("notifications.evidence.source", {
            defaultValue: "Source: {{value}}",
            value: source,
          })
        : null,
      itemName
        ? t("notifications.evidence.item", {
            defaultValue: "Item: {{value}}",
            value: itemName,
          })
        : null,
      country
        ? t("notifications.evidence.country", {
            defaultValue: "Country: {{value}}",
            value: country,
          })
        : null,
      resource
        ? t("notifications.evidence.resource", {
            defaultValue: "Resource: {{value}}",
            value: resource,
          })
        : null,
      action
        ? t("notifications.evidence.action", {
            defaultValue: "Action: {{value}}",
            value: action,
          })
        : null,
      statusesValue
        ? t("notifications.evidence.statuses", {
            defaultValue: "Statuses: {{value}}",
            value: statusesValue,
          })
        : null,
    ]
      .filter(Boolean)
      .slice(0, 4) as string[];
    const windowMinutes =
      event?.changeWindowMin ?? toNumber(context?.windowMinutes);
    const windowLabel =
      windowMinutes !== undefined && windowMinutes !== null
        ? t("notifications.evidence.windowMinutes", "{{count}} min", {
            count: Math.trunc(windowMinutes),
          })
        : t("common.notAvailable");
    const thresholdSummary = event
      ? buildThresholdSummary(
          event.operator,
          event.thresholdValue ?? toNumber(context?.threshold),
          event.thresholdLower ?? toNumber(context?.lower),
          event.thresholdUpper ?? toNumber(context?.upper),
          t,
        )
      : t("common.notAvailable");
    const fallbackTriggerReason =
      presentation.body ??
      event?.message ??
      notification.body ??
      t("alerts.events.triggered");

    return (
      <Space direction="vertical" size={2}>
        <Typography.Text type="secondary">
          {t("alerts.events.triggerReason", {
            defaultValue: "Trigger {{reason}}",
            reason: fallbackTriggerReason,
          })}
        </Typography.Text>
        {evidenceTags.length > 0 ? (
          <Space size={[4, 4]} wrap>
            {evidenceTags.map((entry) => (
              <Tag key={`${notification.id}-${entry}`} className="text-xs">
                {entry}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("alerts.events.evidenceEmpty", {
              defaultValue: "No evidence fields.",
            })}
          </Typography.Text>
        )}
        <Typography.Text type="secondary">
          {t("alerts.events.window", {
            defaultValue: "Window {{window}}",
            window: windowLabel,
          })}
          {" · "}
          {t("alerts.rules.threshold", {
            defaultValue: "Threshold {{threshold}}",
            threshold: thresholdSummary,
          })}
        </Typography.Text>
      </Space>
    );
  };

  const closeChannelModal = () => {
    setChannelModalOpen(false);
    setActiveChannelId(null);
    channelForm.resetFields();
  };

  const handleSubmitChannel = async (values: ChannelFormValues) => {
    const config = toRecord(activeChannel?.config) ?? {};
    const nextConfig: Record<string, unknown> = { ...config };
    if (values.muteUntil) {
      nextConfig.muteUntil = toUtcIsoString(values.muteUntil);
    } else {
      delete nextConfig.muteUntil;
      delete nextConfig.mutedUntil;
      delete nextConfig.silenceUntil;
      delete nextConfig.silencedUntil;
    }
    if (
      typeof values.notifyIntervalSeconds === "number" &&
      values.notifyIntervalSeconds > 0
    ) {
      nextConfig.notifyIntervalSeconds = Math.max(
        1,
        Math.trunc(values.notifyIntervalSeconds),
      );
    } else {
      delete nextConfig.notifyIntervalSeconds;
      delete nextConfig.notifyIntervalSec;
      delete nextConfig.notifyIntervalMinutes;
    }

    try {
      if (channelModalMode === "create") {
        await createChannel({
          variables: {
            input: {
              type: values.type,
              name: values.name,
              target: values.target,
              isActive: values.isActive ?? true,
              config: nextConfig,
            },
          },
        });
        message.success(
          t("subscriptions.channelCreated", {
            defaultValue: "Channel created",
          }),
        );
      } else {
        if (!values.id) {
          message.error(
            t("subscriptions.channelMissingId", {
              defaultValue: "Channel id is missing. Reopen the dialog and try again.",
            }),
          );
          return;
        }
        await updateChannel({
          variables: {
            input: {
              id: values.id,
              name: values.name,
              target: values.target,
              isActive: values.isActive,
              config: nextConfig,
            },
          },
        });
        message.success(
          t("subscriptions.channelUpdated", {
            defaultValue: "Channel updated",
          }),
        );
      }
      closeChannelModal();
      await refetchChannels();
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : t("common.error.unexpected"),
      );
    }
  };

  const handleChannelSubmitFailed: FormProps<ChannelFormValues>["onFinishFailed"] =
    ({ errorFields }) => {
      const firstError = errorFields[0];
      if (firstError) {
        channelForm.scrollToField(firstError.name, {
          block: "center",
        });
      }
      message.warning(
        t("subscriptions.channelValidationFailed", {
          defaultValue: "Fill in the required fields before saving.",
        }),
      );
    };

  const handleDeleteChannel = async (channelId: string) => {
    try {
      await deleteChannel({ variables: { channelId } });
      message.success(
        t("subscriptions.channelDeleted", { defaultValue: "Channel deleted" }),
      );
      await refetchChannels();
      await refetchRules();
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : t("common.error.unexpected"),
      );
    }
  };

  const handleToggleChannelActive = async (
    channelId: string,
    isActive: boolean,
  ) => {
    try {
      await updateChannel({
        variables: {
          input: {
            id: channelId,
            isActive,
          },
        },
      });
      await refetchChannels();
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : t("common.error.unexpected"),
      );
    }
  };

  const handleSubmitRuleSubscriptions = async (values: any) => {
    if (!activeRule) {
      return;
    }
    const metricSlug = activeRule.metricSlug.trim();
    if (!metricSlug) {
      message.error(
        t("alerts.config.errors.metricSlugRequired", {
          defaultValue: "Metric slug is required.",
        }),
      );
      return;
    }
    const existingMetadata = toRecord(activeRule.metadata) ?? {};
    const nextMetadata: Record<string, unknown> = { ...existingMetadata };
    if (values.muteUntil) {
      nextMetadata.muteUntil = toUtcIsoString(values.muteUntil);
    } else {
      delete nextMetadata.muteUntil;
      delete nextMetadata.mutedUntil;
    }
    if (values.notifyAllMembers) {
      nextMetadata.notifyAllMembers = true;
    } else {
      delete nextMetadata.notifyAllMembers;
      delete nextMetadata.notifyAllUsers;
    }

    try {
      await upsertRule({
        variables: {
          input: {
            id: activeRule.id,
            name: activeRule.name,
            description: activeRule.description ?? undefined,
            severity: activeRule.severity,
            status: activeRule.status,
            metricProvider: activeRule.metricProvider,
            metricSlug,
            operator: activeRule.operator,
            thresholdValue:
              typeof activeRule.thresholdValue === "number"
                ? activeRule.thresholdValue
                : undefined,
            thresholdLower:
              typeof activeRule.thresholdLower === "number"
                ? activeRule.thresholdLower
                : undefined,
            thresholdUpper:
              typeof activeRule.thresholdUpper === "number"
                ? activeRule.thresholdUpper
                : undefined,
            changeWindowMin:
              typeof activeRule.changeWindowMin === "number"
                ? activeRule.changeWindowMin
                : undefined,
            cooldownSeconds: activeRule.cooldownSeconds,
            checkIntervalSec: activeRule.checkIntervalSec,
            channelIds: Array.isArray(values.channelIds)
              ? values.channelIds
              : [],
            metadata: nextMetadata,
          },
        },
      });
      message.success(
        t("subscriptions.ruleUpdated", {
          defaultValue: "Rule subscriptions updated",
        }),
      );
      setRuleModalOpen(false);
      await Promise.all([
        refetchRules(),
        refetchChannels(),
        refetchEvents(),
        refetchNotifications(),
      ]);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : t("common.error.unexpected"),
      );
    }
  };

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (key === "content") {
      next.delete("tab");
    } else {
      next.set("tab", key);
    }
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  };

  const rulesTabContent = (
    <Card
      className="content-card"
      title={
        <Space size="middle" align="center">
          <Typography.Text strong>
            {t("subscriptions.rulesTitle", {
              defaultValue: "Rule Subscriptions",
            })}
          </Typography.Text>
        </Space>
      }
      extra={
        <Button
          size="small"
          onClick={async () => {
            const tasks: Promise<unknown>[] = [refetchNotifications()];
            if (canReadAlerts) {
              tasks.push(refetchRules(), refetchEvents());
            }
            await Promise.all(tasks);
          }}
        >
          {t("common.refresh")}
        </Button>
      }
    >
      {authenticated && !canReadAlerts ? (
        <ChartEmptyState
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("common.accessDeniedDescription", {
            defaultValue:
              "You don't have permission to view this data. Contact an administrator if you need access.",
          })}
        />
      ) : isRulesInitialLoading || isEventsInitialLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : (
        <List
          dataSource={rules}
          locale={{
            emptyText: t("subscriptions.rulesEmpty", {
              defaultValue: "No alert rules configured.",
            }),
          }}
          renderItem={(rule) => {
            const ruleMetadata = toRecord(rule.metadata);
            const ruleMuteUntil = parseDateValue(ruleMetadata?.muteUntil);
            const isRuleMuted =
              !!ruleMuteUntil && ruleMuteUntil.isAfter(dayjs());
            const ruleNotifications = notificationsByRuleId.get(rule.id) ?? [];
            const latestNotification = ruleNotifications[0];
            const latestNotificationTime = latestNotification
              ? formatDateTime(latestNotification.createdAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })
              : t("common.notAvailable");
            return (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space size="small">
                      <Typography.Text strong>{rule.name}</Typography.Text>
                      <Tag>{rule.severity}</Tag>
                      <Tag>{rule.operator}</Tag>
                      {isRuleMuted ? (
                        <Tag color="gold">
                          {t("subscriptions.mutedUntil", {
                            defaultValue: "Muted until {{time}}",
                            time: ruleMuteUntil?.format("YYYY-MM-DD HH:mm"),
                          })}
                        </Tag>
                      ) : null}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={2}>
                      <Typography.Text type="secondary">
                        {t("alerts.rules.threshold", {
                          defaultValue: "Threshold {{threshold}}",
                          threshold: buildThresholdSummary(
                            rule.operator,
                            rule.thresholdValue ?? undefined,
                            rule.thresholdLower ?? undefined,
                            rule.thresholdUpper ?? undefined,
                            t,
                          ),
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.window", {
                          defaultValue: "Window {{minutes}} min",
                          minutes:
                            rule.changeWindowMin ?? t("common.notAvailable"),
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t("subscriptions.ruleCooldown", {
                          defaultValue: "Cooldown {{seconds}}s",
                          seconds: rule.cooldownSeconds,
                        })}
                      </Typography.Text>
                      <Space size={[4, 4]} wrap>
                        {(rule.channels ?? []).length > 0 ? (
                          rule.channels.map((channel) => (
                            <Tag key={channel.id}>{channel.name}</Tag>
                          ))
                        ) : (
                          <Typography.Text type="secondary">
                            {t("subscriptions.channelsEmpty", {
                              defaultValue: "No alert channels configured.",
                            })}
                          </Typography.Text>
                        )}
                      </Space>
                      <Typography.Text type="secondary">
                        {t("subscriptions.ruleNotifications", {
                          defaultValue:
                            "Notifications {{count}} · Latest {{time}}",
                          count: ruleNotifications.length,
                          time: latestNotificationTime,
                        })}
                      </Typography.Text>
                    </Space>
                  }
                />
                {canManageAlerts ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setActiveRuleId(rule.id);
                      setRuleModalOpen(true);
                    }}
                  >
                    {t("subscriptions.manageRule", { defaultValue: "Manage" })}
                  </Button>
                ) : null}
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );

  const channelsTabContent = (
    <Card
      className="content-card"
      title={
        <Space size="middle" align="center">
          <Typography.Text strong>
            {t("subscriptions.channelsTitle", {
              defaultValue: "Alert Channels",
            })}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size="small">
          <Button
            size="small"
            onClick={() => {
              if (canReadAlerts) {
                void refetchChannels();
              }
            }}
            disabled={!canReadAlerts}
          >
            {t("common.refresh")}
          </Button>
          {canManageAlerts && canReadAlerts ? (
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setChannelModalMode("create");
                setActiveChannelId(null);
                setChannelModalOpen(true);
              }}
            >
              {t("subscriptions.addChannel", { defaultValue: "Add channel" })}
            </Button>
          ) : null}
        </Space>
      }
    >
      {authenticated && !canReadAlerts ? (
        <ChartEmptyState
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("common.accessDeniedDescription", {
            defaultValue:
              "You don't have permission to view this data. Contact an administrator if you need access.",
          })}
        />
      ) : isChannelsInitialLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <List
          dataSource={channels}
          locale={{
            emptyText: t("subscriptions.channelsEmpty", {
              defaultValue: "No alert channels configured.",
            }),
          }}
          renderItem={(channel) => (
            <List.Item
              actions={
                canManageAlerts
                  ? [
                      <Switch
                        key="active"
                        size="small"
                        checked={channel.isActive ?? true}
                        onChange={(checked) =>
                          void handleToggleChannelActive(channel.id, checked)
                        }
                      />,
                      <Button
                        key="edit"
                        size="small"
                        onClick={() => {
                          setChannelModalMode("edit");
                          setActiveChannelId(channel.id);
                          setChannelModalOpen(true);
                        }}
                      >
                        {t("common.edit")}
                      </Button>,
                      <Popconfirm
                        key="delete"
                        title={t("subscriptions.deleteChannelConfirm", {
                          defaultValue: "Delete this channel?",
                        })}
                        onConfirm={() => void handleDeleteChannel(channel.id)}
                      >
                        <Button size="small" danger loading={deletingChannel}>
                          {t("common.delete")}
                        </Button>
                      </Popconfirm>,
                    ]
                  : undefined
              }
            >
              <List.Item.Meta
                title={
                  <Space size="small">
                    <Typography.Text strong>{channel.name}</Typography.Text>
                    <Tag>{channel.type}</Tag>
                    {channel.isActive ? (
                      <Tag color="green">{t("common.enabled")}</Tag>
                    ) : (
                      <Tag color="default">{t("common.disabled")}</Tag>
                    )}
                  </Space>
                }
                description={(() => {
                  const config = toRecord(channel.config);
                  const muteUntil = extractMuteUntil(config);
                  const isMuted = !!muteUntil && muteUntil.isAfter(dayjs());
                  const intervalSeconds = extractNotifyIntervalSeconds(config);
                  const intervalLabel = intervalSeconds
                    ? t("subscriptions.notifyEvery", {
                        defaultValue: "Every {{minutes}} min",
                        minutes: Math.max(1, Math.round(intervalSeconds / 60)),
                      })
                    : t("subscriptions.notifyImmediate", {
                        defaultValue: "Immediate",
                      });
                  return (
                    <Space direction="vertical" size={0}>
                      <Typography.Text type="secondary">
                        {channel.target}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t("subscriptions.channelFrequency", {
                          defaultValue: "Frequency: {{frequency}}",
                          frequency: intervalLabel,
                        })}
                        {isMuted
                          ? ` · ${t("subscriptions.mutedUntil", {
                              defaultValue: "Muted until {{time}}",
                              time: muteUntil?.format("YYYY-MM-DD HH:mm"),
                            })}`
                          : ""}
                      </Typography.Text>
                    </Space>
                  );
                })()}
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );

  const notificationsTabContent = (
    <Card
      className="content-card"
      title={
        <Space size="middle" align="center">
          <Typography.Text strong>
            {t("subscriptions.notificationsTitle", {
              defaultValue: "Notifications",
            })}
          </Typography.Text>
          <Badge count={unreadCount} size="small" />
        </Space>
      }
      extra={
        <Space size="small">
          <Button size="small" onClick={() => void refetchNotifications()}>
            {t("common.refresh")}
          </Button>
          <Button
            size="small"
            onClick={async () => {
              await markAll();
              await Promise.all([refetchNotifications(), refetchUnread()]);
            }}
          >
            {t("notifications.markAllRead")}
          </Button>
        </Space>
      }
    >
      {isNotificationsInitialLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : (
        <List
          dataSource={orderedNotifications}
          locale={{ emptyText: t("notifications.empty") }}
          renderItem={(item) => {
            const action = resolveNotificationLink(item.data ?? null, t, {
              canReadAlerts,
            });
            const isAlertNotification =
              item.type === NotificationType.AlertTriggered;
            const presentation = formatNotificationPresentation(
              item,
              locale,
              t,
            );
            return (
              <List.Item
                onClick={async () => {
                  if (!item.readAt) {
                    await markRead({ variables: { id: item.id } });
                    await Promise.all([
                      refetchNotifications(),
                      refetchUnread(),
                    ]);
                  }
                }}
                style={{ cursor: "pointer" }}
                className={
                  !item.readAt
                    ? "rounded-md bg-slate-100/80 transition-colors dark:bg-slate-800/50"
                    : "transition-colors hover:bg-slate-50/60 dark:hover:bg-slate-800/35"
                }
              >
                <List.Item.Meta
                  title={
                    <Space size="small" align="center">
                      <Tag color={typeColor[item.type] ?? "default"}>
                        {t(`notifications.type.${item.type}`)}
                      </Tag>
                      <Typography.Text strong>
                        {presentation.title}
                      </Typography.Text>
                      {!item.readAt ? <Badge status="processing" /> : null}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      {presentation.body ? (
                        <Typography.Paragraph
                          style={{ marginBottom: 6 }}
                          ellipsis={{ rows: 2, expandable: false }}
                        >
                          {presentation.body}
                        </Typography.Paragraph>
                      ) : null}
                      {isAlertNotification ? renderAlertEvidence(item) : null}
                      <Space size="small" align="center">
                        <Typography.Text type="secondary">
                          {formatDateTime(item.createdAt, locale, {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hour12: false,
                          })}
                        </Typography.Text>
                        {action ? (
                          <Button
                            type="link"
                            size="small"
                            onClick={async (event) => {
                              event.stopPropagation();
                              if (!item.readAt) {
                                await markRead({ variables: { id: item.id } });
                                await Promise.all([
                                  refetchNotifications(),
                                  refetchUnread(),
                                ]);
                              }
                              router.push(action.href);
                            }}
                            className="px-0"
                          >
                            {action.label}
                          </Button>
                        ) : null}
                      </Space>
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("subscriptions.title", { defaultValue: "My Subscriptions" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("subscriptions.subtitle", {
            defaultValue:
              "Review content subscriptions, alert rules, channels, and notification history in one place.",
          })}
        </Typography.Text>
      </Space>

      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: "content",
            label: t("subscriptions.content.tabTitle", {
              defaultValue: "Content subscriptions",
            }),
            children: (
              <ContentSubscriptionsTab
                accessToken={session?.accessToken}
                active={activeTab === "content"}
              />
            ),
          },
          {
            key: "rules",
            label: t("subscriptions.rulesTitle", {
              defaultValue: "Rule Subscriptions",
            }),
            children: rulesTabContent,
          },
          {
            key: "channels",
            label: t("subscriptions.channelsTitle", {
              defaultValue: "Alert Channels",
            }),
            children: channelsTabContent,
          },
          {
            key: "notifications",
            label: t("subscriptions.notificationsTitle", {
              defaultValue: "Notifications",
            }),
            children: notificationsTabContent,
          },
        ]}
      />

      <Modal
        title={
          channelModalMode === "create"
            ? t("subscriptions.addChannel", { defaultValue: "Add channel" })
            : t("subscriptions.editChannel", { defaultValue: "Edit channel" })
        }
        open={channelModalOpen}
        onCancel={closeChannelModal}
        okText={t("common.save")}
        cancelText={t("common.cancel", { defaultValue: "Cancel" })}
        okButtonProps={{
          htmlType: "submit",
          form: CHANNEL_MODAL_FORM_ID,
        }}
        confirmLoading={creatingChannel || updatingChannel}
        destroyOnHidden
      >
        <Form
          id={CHANNEL_MODAL_FORM_ID}
          form={channelForm}
          autoComplete="off"
          layout="vertical"
          onFinish={handleSubmitChannel}
          onFinishFailed={handleChannelSubmitFailed}
        >
          <Form.Item name="id" hidden>
            <Input type="hidden" />
          </Form.Item>
          <Form.Item
            label={t("alerts.channels.fields.name", { defaultValue: "Name" })}
            name="name"
            rules={[
              {
                required: true,
                message: t("alerts.channels.validation.nameRequired", {
                  defaultValue: "Enter a channel name.",
                }),
              },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label={t("alerts.channels.fields.type", { defaultValue: "Type" })}
            name="type"
            rules={[
              {
                required: true,
                message: t("alerts.channels.validation.typeRequired", {
                  defaultValue: "Select a channel type.",
                }),
              },
            ]}
          >
            <Select
              disabled={channelModalMode === "edit"}
              options={[
                {
                  label: t("alerts.channels.types.webhook", {
                    defaultValue: "Webhook",
                  }),
                  value: "webhook",
                },
                {
                  label: t("alerts.channels.types.email", {
                    defaultValue: "Email",
                  }),
                  value: "email",
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            label={t("alerts.channels.fields.target", {
              defaultValue: "Target",
            })}
            name="target"
            rules={[
              {
                required: true,
                message: t("alerts.channels.validation.targetRequired", {
                  defaultValue: "Enter a delivery target.",
                }),
              },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label={t("subscriptions.channelActive", {
              defaultValue: "Enabled",
            })}
            name="isActive"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t("subscriptions.channelMuteUntil", {
              defaultValue: "Mute until",
            })}
            name="muteUntil"
          >
            <DatePicker showTime allowClear style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("subscriptions.channelNotifyInterval", {
              defaultValue: "Notification frequency",
            })}
            name="notifyIntervalSeconds"
          >
            <Select
              allowClear
              placeholder={t("subscriptions.notifyImmediate", {
                defaultValue: "Immediate",
              })}
              options={[
                {
                  value: 300,
                  label: t("subscriptions.notifyEvery", {
                    defaultValue: "Every {{minutes}} min",
                    minutes: 5,
                  }),
                },
                {
                  value: 900,
                  label: t("subscriptions.notifyEvery", {
                    defaultValue: "Every {{minutes}} min",
                    minutes: 15,
                  }),
                },
                {
                  value: 3600,
                  label: t("subscriptions.notifyEvery", {
                    defaultValue: "Every {{minutes}} min",
                    minutes: 60,
                  }),
                },
                {
                  value: 21600,
                  label: t("subscriptions.notifyEvery", {
                    defaultValue: "Every {{minutes}} min",
                    minutes: 360,
                  }),
                },
                {
                  value: 86400,
                  label: t("subscriptions.notifyEvery", {
                    defaultValue: "Every {{minutes}} min",
                    minutes: 1440,
                  }),
                },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Form
        form={ruleForm}
        layout="vertical"
        onFinish={handleSubmitRuleSubscriptions}
        component={false}
      >
        <Modal
          title={t("subscriptions.manageRule", { defaultValue: "Manage rule" })}
          open={ruleModalOpen}
          onCancel={() => setRuleModalOpen(false)}
          okText={t("common.save")}
          onOk={() => ruleForm.submit()}
          confirmLoading={updatingRule}
          destroyOnHidden
        >
          <Form.Item
            label={t("alerts.config.fields.channels", {
              defaultValue: "Channels",
            })}
            name="channelIds"
          >
            <Select
              mode="multiple"
              placeholder={t("alerts.config.fields.channelsPlaceholder", {
                defaultValue: "Select channels",
              })}
              options={channels.map((channel) => ({
                label: `${channel.name}${channel.isActive ? "" : ` (${t("common.disabled")})`}`,
                value: channel.id,
              }))}
            />
          </Form.Item>
          <Form.Item
            label={t("alerts.config.fields.muteUntil", {
              defaultValue: "Mute until",
            })}
            name="muteUntil"
          >
            <DatePicker showTime allowClear style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("alerts.config.fields.notifyAllMembers", {
              defaultValue: "Notify all members",
            })}
            name="notifyAllMembers"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
        </Modal>
      </Form>
    </div>
  );
}

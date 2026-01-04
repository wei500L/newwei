export interface NotificationLink {
  href: string;
  label: string;
}

type Translate = (key: string, options?: { defaultValue?: string }) => string;

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const resolveNotificationLink = (
  payload: Record<string, unknown> | null | undefined,
  t: Translate
): NotificationLink | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const directLink = toStringValue(payload.link ?? payload.href ?? payload.url);
  if (directLink) {
    return {
      href: directLink,
      label: t("notifications.openLink", { defaultValue: "Open" })
    };
  }

  const taskId = toStringValue(payload.taskId);
  if (taskId) {
    return {
      href: `/crawl/${taskId}`,
      label: t("notifications.openTask", { defaultValue: "Open task" })
    };
  }

  const itemId = toStringValue(payload.itemId ?? payload.itemMetaId ?? payload.processedItemId);
  if (itemId) {
    return {
      href: `/items/${itemId}`,
      label: t("notifications.openItem", { defaultValue: "Open item" })
    };
  }

  const analysisId = toStringValue(payload.analysisId);
  if (analysisId) {
    return {
      href: `/dashboard?panel=analysis&analysisId=${encodeURIComponent(analysisId)}`,
      label: t("notifications.openAnalysis", { defaultValue: "Open analysis" })
    };
  }

  const alertEventId = toStringValue(payload.alertEventId ?? payload.eventId);
  if (alertEventId) {
    return {
      href: `/alerts?eventId=${encodeURIComponent(alertEventId)}`,
      label: t("notifications.openAlert", { defaultValue: "Open alert" })
    };
  }

  return null;
};

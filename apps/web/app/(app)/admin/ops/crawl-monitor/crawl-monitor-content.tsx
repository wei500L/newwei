"use client";

import { Alert, Button, Card, Space, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

interface CrawlMonitorContentProps {
  dashboardUrl: string;
}

export function CrawlMonitorContent({ dashboardUrl }: CrawlMonitorContentProps) {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();

  const normalizedDashboardUrl = dashboardUrl?.trim();

  const handleOpen = () => {
    if (!normalizedDashboardUrl) {
      return;
    }
    window.open(normalizedDashboardUrl, "_blank", "noopener,noreferrer");
  };

  const handleCopy = async () => {
    if (!normalizedDashboardUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(normalizedDashboardUrl);
      messageApi.success(t("crawl.monitor.copied", { defaultValue: "Copied dashboard URL." }));
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : t("crawl.monitor.copyFailed", { defaultValue: "Copy failed." })
      );
    }
  };

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Typography.Text type="secondary">{t("common.loading", { defaultValue: "Loading..." })}</Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("crawl.monitor.title", { defaultValue: "Crawl Monitor" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("crawl.monitor.title", { defaultValue: "Crawl4AI Monitor" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("crawl.monitor.subtitle", {
            defaultValue: "Interactive dashboard with live system metrics and browser pool visibility."
          })}
        </Typography.Text>
      </Space>

      <Card
        className="content-card"
        title={t("crawl.monitor.dashboardTitle", { defaultValue: "Monitoring Dashboard" })}
        extra={
          <Space>
            <Button onClick={handleCopy} disabled={!normalizedDashboardUrl}>
              {t("crawl.monitor.copyLink", { defaultValue: "Copy link" })}
            </Button>
            <Button type="primary" onClick={handleOpen} disabled={!normalizedDashboardUrl}>
              {t("crawl.monitor.openInNewTab", { defaultValue: "Open in new tab" })}
            </Button>
          </Space>
        }
      >
        {!normalizedDashboardUrl ? (
          <Alert
            type="warning"
            message={t("crawl.monitor.missingUrl.title", { defaultValue: "Dashboard URL not configured" })}
            description={t("crawl.monitor.missingUrl.description", {
              defaultValue:
                "Set CRAWL4AI_DASHBOARD_URL (recommended in Docker) or CRAWL4AI_BASE_URL, then reload this page."
            })}
          />
        ) : (
          <>
            <Typography.Paragraph style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary">
                {t("crawl.monitor.currentUrl", { defaultValue: "Current dashboard URL:" })}{" "}
              </Typography.Text>
              <Typography.Link href={normalizedDashboardUrl} target="_blank" rel="noreferrer">
                {normalizedDashboardUrl}
              </Typography.Link>
            </Typography.Paragraph>
            <iframe
              title="crawl4ai-monitor-dashboard"
              src={normalizedDashboardUrl}
              style={{
                width: "100%",
                height: "78vh",
                border: "1px solid #f0f0f0",
                borderRadius: 8
              }}
              referrerPolicy="no-referrer"
            />
          </>
        )}
      </Card>
    </div>
  );
}


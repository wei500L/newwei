"use client";

import { Card, List, Space, Typography } from "antd";
import Link from "next/link";
import { useTranslation } from "react-i18next";

export default function AdminPage() {
  const { t } = useTranslation();

  const adminLinks = [
    {
      title: t("adminConsole.links.orgs.title", { defaultValue: "Organizations" }),
      description: t("adminConsole.links.orgs.description", {
        defaultValue: "Manage orgs and memberships"
      }),
      href: "/admin/orgs"
    },
    {
      title: t("adminConsole.links.errors.title", { defaultValue: "Error Events" }),
      description: t("adminConsole.links.errors.description", {
        defaultValue: "Inspect recent system errors"
      }),
      href: "/admin/errors"
    },
    {
      title: t("adminConsole.links.storage.title", { defaultValue: "Storage Settings" }),
      description: t("adminConsole.links.storage.description", {
        defaultValue: "Configure storage backends"
      }),
      href: "/admin/storage"
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("adminConsole.title", { defaultValue: "Admin Console" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("adminConsole.subtitle", {
            defaultValue: "Manage organizations, storage, and system errors."
          })}
        </Typography.Text>
      </Space>
      <Card className="content-card">
        <List
          dataSource={adminLinks}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Link href={item.href}>{item.title}</Link>}
                description={item.description}
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
}

"use client";

import { Card, List, Space, Typography } from "antd";
import Link from "next/link";

const adminLinks = [
  { title: "Organizations", description: "Manage orgs and memberships", href: "/admin/orgs" },
  { title: "Error Events", description: "Inspect recent system errors", href: "/admin/errors" },
  { title: "Storage Settings", description: "Configure storage backends", href: "/admin/storage" }
];

export default function AdminPage() {
  return (
    <div className="flex flex-col gap-6">
      <Typography.Title level={4}>Admin Console</Typography.Title>
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

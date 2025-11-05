"use client";

import { Card, Empty, List, Spin, Tabs, Tag, Typography } from "antd";
import { useRbacOverviewQuery } from "@/graphql/generated";

export function SettingsContent() {
  const { data, loading } = useRbacOverviewQuery();

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  const roles = data?.roles ?? [];
  const permissions = data?.permissions ?? [];
  const memberships = data?.memberships ?? [];

  return (
    <Card className="content-card" title="Organization Settings">
      <Tabs
        defaultActiveKey="roles"
        items={[
          {
            key: "roles",
            label: "Roles",
            children: roles.length > 0 ? (
              <List
                dataSource={roles}
                renderItem={(role) => (
                  <List.Item>
                    <List.Item.Meta
                      title={role.name}
                      description={
                        <div>
                          <Typography.Paragraph type="secondary">
                            {role.description || "No description provided."}
                          </Typography.Paragraph>
                          <div>
                            {role.permissions.map((permission) => (
                              <Tag key={permission.id}>{permission.name}</Tag>
                            ))}
                          </div>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="No roles configured yet" />
            )
          },
          {
            key: "permissions",
            label: "Permissions",
            children: permissions.length > 0 ? (
              <List
                dataSource={permissions}
                renderItem={(permission) => (
                  <List.Item>
                    <List.Item.Meta
                      title={permission.name}
                      description={permission.description || "Pending documentation."}
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="No permissions found" />
            )
          },
          {
            key: "members",
            label: "Members",
            children: memberships.length > 0 ? (
              <List
                dataSource={memberships}
                renderItem={(member) => (
                  <List.Item>
                    <List.Item.Meta
                      title={`${member.user.firstName} ${member.user.lastName}`}
                      description={`${member.user.email} • ${member.role.name}`}
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="No members assigned" />
            )
          }
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: "1.5rem" }}>
        TODO: add inline editing for role assignments and permission bundles. Hook into audit trail to
        visualize configuration drift over time.
      </Typography.Paragraph>
    </Card>
  );
}

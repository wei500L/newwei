"use client";

import { Card, Empty, List, Spin, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";

interface SettingsContentProps {
  accessToken: string;
}

interface Permission {
  id: string;
  name: string;
  description?: string;
}

interface Role {
  id: string;
  name: string;
  description?: string | null;
  permissions: Array<{ permission: Permission }>;
}

interface Member {
  id: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  role: {
    id: string;
    name: string;
  };
}

export function SettingsContent({ accessToken }: SettingsContentProps) {
  const client = createApiClient({ accessToken });

  const permissionsQuery = useQuery<Permission[]>({
    queryKey: ["rbac", "permissions"],
    queryFn: async () => {
      const response = await client.get<Permission[]>("/rbac/permissions");
      return response.data;
    }
  });

  const rolesQuery = useQuery<Role[]>({
    queryKey: ["rbac", "roles"],
    queryFn: async () => {
      const response = await client.get<Role[]>("/rbac/roles");
      return response.data;
    }
  });

  const membersQuery = useQuery<Member[]>({
    queryKey: ["rbac", "members"],
    queryFn: async () => {
      const response = await client.get<Member[]>("/rbac/members");
      return response.data;
    }
  });

  const loading = permissionsQuery.isLoading || rolesQuery.isLoading || membersQuery.isLoading;

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Card className="content-card" title="Organization Settings">
      <Tabs
        defaultActiveKey="roles"
        items={[
          {
            key: "roles",
            label: "Roles",
            children: rolesQuery.data && rolesQuery.data.length > 0 ? (
              <List
                dataSource={rolesQuery.data}
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
                            {role.permissions.map((rp) => (
                              <Tag key={rp.permission.id}>{rp.permission.name}</Tag>
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
            children: permissionsQuery.data && permissionsQuery.data.length > 0 ? (
              <List
                dataSource={permissionsQuery.data}
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
            children: membersQuery.data && membersQuery.data.length > 0 ? (
              <List
                dataSource={membersQuery.data}
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

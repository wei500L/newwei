'use client';

import {
  AlertOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  CloudSyncOutlined,
  DashboardOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  LineChartOutlined,
  RightOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined
} from '@ant-design/icons';
import { Alert, Card, Collapse, Empty, Space, Spin, Typography } from 'antd';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ADMIN_GROUP_ORDER,
  canViewAdmin,
  filterVisibleAdminLinks,
  groupAdminLinksBySection,
  type AdminGroupKey,
  type AdminLinkPermission
} from './admin-content.utils';

interface AdminLinkItem {
  key: string;
  title: string;
  description: string;
  href: string;
  permission?: AdminLinkPermission;
  group: AdminGroupKey;
  icon: ComponentType<{ className?: string }>;
}

interface AdminGroupItem {
  key: AdminGroupKey;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

interface GroupTone {
  sectionClassName: string;
  iconShellClassName: string;
  iconClassName: string;
  counterClassName: string;
}

const GROUP_TONES: Record<AdminGroupKey, GroupTone> = {
  operations: {
    sectionClassName: 'border-sky-200/70 bg-sky-50/50',
    iconShellClassName: 'bg-sky-100',
    iconClassName: 'text-sky-700',
    counterClassName: 'bg-sky-100 text-sky-700'
  },
  monitoring: {
    sectionClassName: 'border-emerald-200/70 bg-emerald-50/50',
    iconShellClassName: 'bg-emerald-100',
    iconClassName: 'text-emerald-700',
    counterClassName: 'bg-emerald-100 text-emerald-700'
  },
  governance: {
    sectionClassName: 'border-amber-200/70 bg-amber-50/50',
    iconShellClassName: 'bg-amber-100',
    iconClassName: 'text-amber-700',
    counterClassName: 'bg-amber-100 text-amber-700'
  },
  platform: {
    sectionClassName: 'border-slate-200/90 bg-slate-50/60',
    iconShellClassName: 'bg-slate-200/80',
    iconClassName: 'text-slate-700',
    counterClassName: 'bg-slate-200/80 text-slate-700'
  }
};

export function AdminContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const isAdminVisible = canViewAdmin(permissions);

  const adminGroups: AdminGroupItem[] = [
    {
      key: 'operations',
      title: t('adminConsole.groups.operations.title', { defaultValue: 'Operations & Delivery' }),
      description: t('adminConsole.groups.operations.description', {
        defaultValue: 'Run content pipelines, dashboards, and alert routing.'
      }),
      icon: AppstoreOutlined
    },
    {
      key: 'monitoring',
      title: t('adminConsole.groups.monitoring.title', { defaultValue: 'Monitoring & Quality' }),
      description: t('adminConsole.groups.monitoring.description', {
        defaultValue: 'Track failures, data quality, and knowledge-review backlogs.'
      }),
      icon: LineChartOutlined
    },
    {
      key: 'governance',
      title: t('adminConsole.groups.governance.title', { defaultValue: 'Governance & Access' }),
      description: t('adminConsole.groups.governance.description', {
        defaultValue: 'Control organizations, permissions, and auditability.'
      }),
      icon: TeamOutlined
    },
    {
      key: 'platform',
      title: t('adminConsole.groups.platform.title', { defaultValue: 'Platform & Infrastructure' }),
      description: t('adminConsole.groups.platform.description', {
        defaultValue: 'Manage storage, runtime defaults, and core system behavior.'
      }),
      icon: SettingOutlined
    }
  ];

  const adminLinks: AdminLinkItem[] = [
    {
      key: 'ops',
      title: t('adminConsole.links.ops.title', { defaultValue: 'Operations' }),
      description: t('adminConsole.links.ops.description', {
        defaultValue: 'Manage crawl tasks and source scheduling'
      }),
      href: '/admin/ops',
      permission: 'crawl.read',
      group: 'operations',
      icon: AppstoreOutlined
    },
    {
      key: 'dashboards',
      title: t('adminConsole.links.dashboards.title', { defaultValue: 'Dashboard Config' }),
      description: t('adminConsole.links.dashboards.description', {
        defaultValue: 'Edit dashboard layouts and metrics'
      }),
      href: '/admin/dashboards',
      permission: 'dashboards.write',
      group: 'operations',
      icon: DashboardOutlined
    },
    {
      key: 'alerts',
      title: t('adminConsole.links.alerts.title', { defaultValue: 'Alert Rules' }),
      description: t('adminConsole.links.alerts.description', {
        defaultValue: 'Configure alert rules and channels'
      }),
      href: '/admin/alerts',
      permission: 'alerts.manage',
      group: 'operations',
      icon: AlertOutlined
    },
    {
      key: 'errors',
      title: t('adminConsole.links.errors.title', { defaultValue: 'Error Events' }),
      description: t('adminConsole.links.errors.description', {
        defaultValue: 'Inspect recent system errors'
      }),
      href: '/admin/errors',
      permission: 'settings.manage',
      group: 'monitoring',
      icon: ExclamationCircleOutlined
    },
    {
      key: 'quality',
      title: t('adminConsole.links.quality.title', { defaultValue: 'Data Quality' }),
      description: t('adminConsole.links.quality.description', {
        defaultValue: 'Monitor pipeline success, latency, and source reliability'
      }),
      href: '/admin/quality',
      permission: 'settings.manage',
      group: 'monitoring',
      icon: LineChartOutlined
    },
    {
      key: 'knowledgeGraphReview',
      title: t('adminConsole.links.knowledgeGraphReview.title', {
        defaultValue: 'Knowledge Graph Review'
      }),
      description: t('adminConsole.links.knowledgeGraphReview.description', {
        defaultValue: 'Review low-confidence knowledge graph relations and record human feedback'
      }),
      href: '/admin/system?tab=knowledgeGraphReview',
      permission: 'knowledgegraph.review',
      group: 'monitoring',
      icon: ClusterOutlined
    },
    {
      key: 'orgs',
      title: t('adminConsole.links.orgs.title', { defaultValue: 'Organizations' }),
      description: t('adminConsole.links.orgs.description', {
        defaultValue: 'Manage orgs and memberships'
      }),
      href: '/admin/orgs',
      permission: 'org.write',
      group: 'governance',
      icon: TeamOutlined
    },
    {
      key: 'audit',
      title: t('adminConsole.links.audit.title', { defaultValue: 'Audit Logs' }),
      description: t('adminConsole.links.audit.description', {
        defaultValue: 'Review configuration and access events'
      }),
      href: '/admin/audit-logs',
      permission: 'settings.manage',
      group: 'governance',
      icon: FileSearchOutlined
    },
    {
      key: 'settings',
      title: t('adminConsole.links.settings.title', { defaultValue: 'Access Settings' }),
      description: t('adminConsole.links.settings.description', {
        defaultValue: 'Manage roles, permissions, and memberships'
      }),
      href: '/admin/settings',
      permission: 'settings.manage',
      group: 'governance',
      icon: UserOutlined
    },
    {
      key: 'storage',
      title: t('adminConsole.links.storage.title', { defaultValue: 'Storage Settings' }),
      description: t('adminConsole.links.storage.description', {
        defaultValue: 'Configure storage backends'
      }),
      href: '/admin/storage',
      permission: 'settings.manage',
      group: 'platform',
      icon: CloudSyncOutlined
    },
    {
      key: 'system',
      title: t('adminConsole.links.system.title', { defaultValue: 'System Settings' }),
      description: t('adminConsole.links.system.description', {
        defaultValue: 'Tune cache, rate limits, and crawl defaults'
      }),
      href: '/admin/system',
      permission: 'settings.manage',
      group: 'platform',
      icon: SettingOutlined
    }
  ];

  const visibleLinks = filterVisibleAdminLinks(adminLinks, permissions);
  const groupedLinks = groupAdminLinksBySection(visibleLinks);
  const visibleGroupOrder = ADMIN_GROUP_ORDER.filter((group) => groupedLinks[group].length > 0);

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '3rem' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!isAdminVisible) {
    return (
      <Card className="content-card" title={t('adminConsole.title', { defaultValue: 'Admin Console' })}>
        <Alert
          type="warning"
          message={t('settings.adminOnly.title')}
          description={t('settings.adminOnly.description')}
        />
      </Card>
    );
  }

  const renderGroupGrid = (group: AdminGroupItem) => {
    const tone = GROUP_TONES[group.key];
    const links = groupedLinks[group.key];

    if (links.length === 0) {
      return null;
    }

    const GroupIcon = group.icon;

    return (
      <section key={group.key} className={`rounded-xl border p-4 ${tone.sectionClassName}`}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.iconShellClassName}`}>
              <GroupIcon className={`text-base ${tone.iconClassName}`} />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900">{group.title}</h3>
              <p className="text-xs text-slate-600">{group.description}</p>
            </div>
          </div>
          <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone.counterClassName}`}>
            {t('adminConsole.group.itemCount', {
              count: links.length,
              defaultValue: '{{count}} items'
            })}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {links.map((item) => {
            const LinkIcon = item.icon;

            return (
              <Link
                key={item.key}
                href={item.href}
                className="group block h-full rounded-xl border border-slate-200/80 bg-white/95 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_24px_rgba(15,23,42,0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <div className="flex items-start gap-3">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone.iconShellClassName}`}>
                    <LinkIcon className={`text-sm ${tone.iconClassName}`} />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-slate-900">{item.title}</h4>
                    <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-slate-600">
                      {item.description}
                    </p>
                  </div>
                </div>
                <div className="mt-3 inline-flex items-center text-xs font-medium text-slate-500 transition-colors group-hover:text-slate-700">
                  {t('adminConsole.card.enter', { defaultValue: 'Open' })}
                  <RightOutlined className="ml-1 text-[10px]" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('adminConsole.title', { defaultValue: 'Admin Console' })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t('adminConsole.subtitle', {
            defaultValue: 'Manage operations, organizations, dashboards, alerts, and system settings.'
          })}
        </Typography.Text>
      </Space>

      <Card className="content-card">
        {visibleLinks.length ? (
          <>
            <div className="hidden flex-col gap-4 md:flex">
              {visibleGroupOrder.map((groupKey) => {
                const group = adminGroups.find((item) => item.key === groupKey);
                return group ? renderGroupGrid(group) : null;
              })}
            </div>

            <div className="md:hidden">
              <Collapse
                size="large"
                className="bg-transparent"
                items={visibleGroupOrder.map((groupKey) => {
                  const group = adminGroups.find((item) => item.key === groupKey);
                  if (!group) {
                    return {
                      key: groupKey,
                      label: groupKey,
                      children: null
                    };
                  }

                  const tone = GROUP_TONES[group.key];
                  const GroupIcon = group.icon;

                  return {
                    key: group.key,
                    label: (
                      <div className="flex w-full items-center justify-between gap-3 pr-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${tone.iconShellClassName}`}>
                            <GroupIcon className={`text-sm ${tone.iconClassName}`} />
                          </span>
                          <span className="truncate text-sm font-semibold text-slate-900">{group.title}</span>
                        </div>
                        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone.counterClassName}`}>
                          {groupedLinks[group.key].length}
                        </span>
                      </div>
                    ),
                    children: (
                      <div className="grid grid-cols-1 gap-3 pt-1">
                        {groupedLinks[group.key].map((item) => {
                          const LinkIcon = item.icon;

                          return (
                            <Link
                              key={item.key}
                              href={item.href}
                              className="group block rounded-xl border border-slate-200/80 bg-white/95 p-4 transition-all duration-200 hover:border-slate-300 hover:shadow-[0_10px_20px_rgba(15,23,42,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                            >
                              <div className="flex items-start gap-3">
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone.iconShellClassName}`}>
                                  <LinkIcon className={`text-sm ${tone.iconClassName}`} />
                                </span>
                                <div className="min-w-0">
                                  <h4 className="text-sm font-semibold text-slate-900">{item.title}</h4>
                                  <p className="mt-1 text-xs leading-5 text-slate-600">{item.description}</p>
                                </div>
                              </div>
                              <div className="mt-3 inline-flex items-center text-xs font-medium text-slate-500 transition-colors group-hover:text-slate-700">
                                {t('adminConsole.card.enter', { defaultValue: 'Open' })}
                                <RightOutlined className="ml-1 text-[10px]" />
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    )
                  };
                })}
              />
            </div>
          </>
        ) : (
          <Empty description={t('common.empty')} />
        )}
      </Card>
    </div>
  );
}

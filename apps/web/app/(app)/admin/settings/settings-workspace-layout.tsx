'use client';

import { Alert, Card, Select, Spin, Tag, Typography } from 'antd';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useMemo, type PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getVisibleAdminSettingsPages,
  getAdminSettingsPageDescriptionKey,
  resolveAdminSettingsPageIdFromPathname,
  resolveAdminSettingsPagePath,
  type AdminSettingsPageId,
} from './settings-navigation';

function NavButton({
  active,
  description,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
        active
          ? 'border-[var(--primary)] bg-[rgba(17,24,39,0.04)] text-slate-900'
          : 'border-[var(--border)] bg-white/70 text-slate-700 hover:border-slate-300 hover:bg-slate-50'
      }`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="mt-1 text-xs leading-5 text-slate-500">
        {description}
      </div>
    </button>
  );
}

export function AdminSettingsWorkspaceLayout({
  children,
}: PropsWithChildren) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const visiblePages = useMemo(
    () => getVisibleAdminSettingsPages(permissions),
    [permissions],
  );
  const activePageId = resolveAdminSettingsPageIdFromPathname(pathname);
  const activeSelectValue = activePageId ?? 'overview';

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '3rem' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (visiblePages.length === 0) {
    return (
      <Card
        className="content-card"
        title={t('adminSettings.workspace.title', {
          defaultValue: 'Settings Workspace',
        })}
      >
        <Alert
          type="warning"
          message={t('settings.adminOnly.title')}
          description={t('settings.adminOnly.description')}
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="xl:hidden">
        <Card className="content-card">
          <Typography.Text strong>
            {t('adminSettings.workspace.title', {
              defaultValue: 'Settings Workspace',
            })}
          </Typography.Text>
          <div className="mt-3">
            <Select
              className="w-full"
              value={activeSelectValue}
              onChange={(value) =>
                router.push(
                  value === 'overview'
                    ? '/admin/settings'
                    : resolveAdminSettingsPagePath(value as AdminSettingsPageId),
                )
              }
              options={[
                {
                  value: 'overview',
                  label: t('adminSettings.workspace.overview', {
                    defaultValue: 'Overview',
                  }),
                },
                ...visiblePages.map((page) => ({
                  value: page.id,
                  label: t(page.titleKey, { defaultValue: page.defaultTitle }),
                })),
              ]}
            />
          </div>
        </Card>
      </div>

      <aside className="hidden xl:block xl:w-[280px] xl:shrink-0">
        <div className="sticky top-6">
          <Card className="content-card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {t('adminSettings.workspace.title', {
                    defaultValue: 'Settings Workspace',
                  })}
                </Typography.Title>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0, marginTop: 8 }}
                >
                  {t('adminSettings.workspace.description', {
                    defaultValue:
                      'Browse settings by domain instead of navigating a single oversized tab strip.',
                  })}
                </Typography.Paragraph>
              </div>
              <Tag>{visiblePages.length}</Tag>
            </div>

            <div className="mt-5 flex flex-col gap-2">
              <NavButton
                active={activePageId === null}
                label={t('adminSettings.workspace.overview', {
                  defaultValue: 'Overview',
                })}
                description={t('adminSettings.workspace.overviewDescription', {
                  defaultValue:
                    'See available domains, common shortcuts, and quick entry points.',
                })}
                onClick={() => router.push('/admin/settings')}
              />
              {visiblePages.map((page) => (
                <NavButton
                  key={page.id}
                  active={activePageId === page.id}
                  label={t(page.titleKey, { defaultValue: page.defaultTitle })}
                  description={t(getAdminSettingsPageDescriptionKey(page.id), {
                    defaultValue: page.defaultDescription,
                  })}
                  onClick={() => router.push(resolveAdminSettingsPagePath(page.id))}
                />
              ))}
            </div>
          </Card>
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

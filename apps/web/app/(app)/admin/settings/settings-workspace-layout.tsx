'use client';

import { Alert, Card, Select, Spin, Tag, Typography } from 'antd';
import Link from 'next/link';
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
  href,
  label,
}: {
  active: boolean;
  description: string;
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`settings-nav-button block w-full rounded-2xl px-4 py-3 text-left no-underline ${
        active ? 'settings-nav-button--active' : ''
      }`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="settings-nav-button__description mt-1 text-xs leading-5">
        {description}
      </div>
    </Link>
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
        title={t('adminSettings.workspace.title')}
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
            {t('adminSettings.workspace.title')}
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
                  label: t('adminSettings.workspace.overview'),
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
                  {t('adminSettings.workspace.title')}
                </Typography.Title>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0, marginTop: 8 }}
                >
                  {t('adminSettings.workspace.description')}
                </Typography.Paragraph>
              </div>
              <Tag>{visiblePages.length}</Tag>
            </div>

            <div className="mt-5 flex flex-col gap-2">
              <NavButton
                active={activePageId === null}
                href="/admin/settings"
                label={t('adminSettings.workspace.overview')}
                description={t('adminSettings.workspace.overviewDescription')}
              />
              {visiblePages.map((page) => (
                <NavButton
                  key={page.id}
                  active={activePageId === page.id}
                  href={resolveAdminSettingsPagePath(page.id)}
                  label={t(page.titleKey, { defaultValue: page.defaultTitle })}
                  description={t(getAdminSettingsPageDescriptionKey(page.id), {
                    defaultValue: page.defaultDescription,
                  })}
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

'use client';

import { Alert, Button, Card, Spin, Typography } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '@/components/page-header';
import { SectionHeader } from '@/components/section-header';

import {
  buildAdminSettingsPanelSelectionHref,
  getAdminSettingsPageDescriptionKey,
  getAdminSettingsPanelDescriptionKey,
  type AdminSettingsPageId,
  type AdminSettingsPanelDefinition,
  type AdminSettingsPanelId,
} from './settings-navigation';
import { getAdminSettingsPanelComponent } from './settings-registry';
import { resolveAdminSettingsSectionState } from './settings-workspace-model';

function usePanelRefs(): MutableRefObject<
  Partial<Record<AdminSettingsPanelId, HTMLElement | null>>
> {
  return useRef<Partial<Record<AdminSettingsPanelId, HTMLElement | null>>>({});
}

export function AdminSettingsSectionContent({
  pageId,
}: {
  pageId: AdminSettingsPageId;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const panelRefs = usePanelRefs();
  const { page, visiblePanels, selectedPanelId } = resolveAdminSettingsSectionState(
    {
      pageId,
      permissions,
      panelId: searchParams.get('panel'),
    },
  );

  useEffect(() => {
    if (!selectedPanelId) {
      return;
    }

    const target = panelRefs.current[selectedPanelId];
    if (!target) {
      return;
    }

    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);

    return () => window.clearTimeout(timer);
  }, [selectedPanelId, panelRefs]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (visiblePanels.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          kicker={t('nav.groups.admin')}
          title={t(page.titleKey, { defaultValue: page.defaultTitle })}
        />
        <Alert
          type="warning"
          showIcon
          message={t('settings.adminOnly.title')}
          description={t('settings.adminOnly.description')}
        />
      </div>
    );
  }

  const handlePanelSelect = (panelId: AdminSettingsPanelId) => {
    router.replace(
      buildAdminSettingsPanelSelectionHref(pathname, searchParams, panelId),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t('nav.groups.admin')}
        title={t(page.titleKey, { defaultValue: page.defaultTitle })}
        description={t(getAdminSettingsPageDescriptionKey(page.id), {
          defaultValue: page.defaultDescription,
        })}
      />
      <Card className="content-card">
        <div className="flex flex-wrap gap-2">
          {visiblePanels.map((panel) => (
            <Button
              key={panel.id}
              size="small"
              type={selectedPanelId === panel.id ? 'primary' : 'default'}
              onClick={() => handlePanelSelect(panel.id)}
            >
              {t(panel.titleKey, { defaultValue: panel.defaultTitle })}
            </Button>
          ))}
        </div>
      </Card>

      {visiblePanels.map((panel) => (
        <SettingsPanelSection
          key={panel.id}
          panel={panel}
          active={selectedPanelId === panel.id}
          sectionRef={(node) => {
            panelRefs.current[panel.id] = node;
          }}
        />
      ))}
    </div>
  );
}

function SettingsPanelSection({
  active,
  panel,
  sectionRef,
}: {
  active: boolean;
  panel: AdminSettingsPanelDefinition;
  sectionRef: (node: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const PanelComponent = getAdminSettingsPanelComponent(panel.id);

  if (!PanelComponent) {
    return null;
  }

  return (
    <section
      id={panel.id}
      ref={sectionRef}
      className={`settings-section-shell scroll-mt-28 rounded-lg p-5 ${
        active ? 'settings-section-shell--active' : ''
      }`}
    >
      <div className="mb-5">
        <SectionHeader
          title={t(panel.titleKey, { defaultValue: panel.defaultTitle })}
        />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t(getAdminSettingsPanelDescriptionKey(panel.id), {
            defaultValue: panel.defaultDescription,
          })}
        </Typography.Paragraph>
      </div>
      <PanelComponent />
    </section>
  );
}

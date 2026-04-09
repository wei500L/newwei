'use client';

import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

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
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '3rem' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (visiblePanels.length === 0) {
    return (
      <Card className="content-card" title={t(page.titleKey, { defaultValue: page.defaultTitle })}>
        <Alert
          type="warning"
          message={t('settings.adminOnly.title')}
          description={t('settings.adminOnly.description')}
        />
      </Card>
    );
  }

  const handlePanelSelect = (panelId: AdminSettingsPanelId) => {
    router.replace(
      buildAdminSettingsPanelSelectionHref(pathname, searchParams, panelId),
    );
  };

  return (
    <div className="space-y-6">
      <Card className="content-card">
        <Space direction="vertical" size={10}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t(page.titleKey, { defaultValue: page.defaultTitle })}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t(getAdminSettingsPageDescriptionKey(page.id), {
              defaultValue: page.defaultDescription,
            })}
          </Typography.Paragraph>
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
        </Space>
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
      className={`settings-section-shell scroll-mt-28 rounded-[28px] p-5 ${
        active ? 'settings-section-shell--active' : ''
      }`}
    >
      <div className="mb-5">
        <Typography.Title level={5} style={{ marginBottom: 6 }}>
          {t(panel.titleKey, { defaultValue: panel.defaultTitle })}
        </Typography.Title>
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

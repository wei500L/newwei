'use client';

import { ArrowRightOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Empty, Row, Space, Tag, Typography } from 'antd';
import { useSession } from 'next-auth/react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  buildAdminSettingsHref,
  getAdminSettingsPageDescriptionKey,
  getAdminSettingsPanelDescriptionKey,
} from './settings-navigation';
import {
  getAdminSettingsFeaturedLinks,
  getAdminSettingsPageCards,
} from './settings-workspace-model';

export function AdminSettingsOverviewContent() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const pageCards = useMemo(
    () => getAdminSettingsPageCards(permissions),
    [permissions],
  );
  const featuredLinks = useMemo(
    () => getAdminSettingsFeaturedLinks(permissions),
    [permissions],
  );

  if (pageCards.length === 0) {
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
    <div className="space-y-6">
      <Card className="content-card">
        <Space direction="vertical" size={8}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('adminSettings.workspace.title', {
              defaultValue: 'Settings Workspace',
            })}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('adminSettings.workspace.summary', {
              defaultValue:
                'Administrative settings are grouped by domain so high-risk controls are easier to find and operate.',
            })}
          </Typography.Paragraph>
        </Space>
      </Card>

      <div>
        <Typography.Title level={5}>
          {t('adminSettings.workspace.quickLinks', {
            defaultValue: 'Quick links',
          })}
        </Typography.Title>
        {featuredLinks.length === 0 ? (
          <Card className="content-card">
            <Empty description={t('common.empty')} />
          </Card>
        ) : (
          <Row gutter={[16, 16]}>
            {featuredLinks.map((item) => {
              const href = buildAdminSettingsHref({
                page: item.page,
                panel: item.panel,
              });

              return (
                <Col key={`${item.page}:${item.panel}`} xs={24} md={12}>
                  <Card className="content-card h-full">
                    <Space direction="vertical" size={10} className="w-full">
                      <Tag>
                        {t('adminSettings.workspace.quickLinkTag', {
                          defaultValue: 'Shortcut',
                        })}
                      </Tag>
                      <div>
                        <Typography.Title level={5} style={{ marginBottom: 6 }}>
                          {t(item.panelDefinition.titleKey, {
                            defaultValue: item.panelDefinition.defaultTitle,
                          })}
                        </Typography.Title>
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                          {t(getAdminSettingsPanelDescriptionKey(item.panel), {
                            defaultValue: item.panelDefinition.defaultDescription,
                          })}
                        </Typography.Paragraph>
                      </div>
                      <Button type="link" className="!px-0" href={href}>
                        {t('adminSettings.workspace.open', {
                          defaultValue: 'Open',
                        })}
                        <ArrowRightOutlined />
                      </Button>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </div>

      <div>
        <Typography.Title level={5}>
          {t('adminSettings.workspace.domains', {
            defaultValue: 'Settings domains',
          })}
        </Typography.Title>
        <Row gutter={[16, 16]}>
          {pageCards.map(({ page, panels }) => {
            const href = buildAdminSettingsHref({ page: page.id });

            return (
              <Col key={page.id} xs={24} md={12} xl={8}>
                <Card className="content-card h-full">
                  <Space direction="vertical" size={12} className="w-full">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Typography.Title level={5} style={{ marginBottom: 6 }}>
                          {t(page.titleKey, { defaultValue: page.defaultTitle })}
                        </Typography.Title>
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                          {t(getAdminSettingsPageDescriptionKey(page.id), {
                            defaultValue: page.defaultDescription,
                          })}
                        </Typography.Paragraph>
                      </div>
                      <Tag>{panels.length}</Tag>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {panels.slice(0, 3).map((panel) => (
                        <Tag key={panel.id}>
                          {t(panel.titleKey, { defaultValue: panel.defaultTitle })}
                        </Tag>
                      ))}
                    </div>
                    <Button type="primary" href={href}>
                      {t('adminSettings.workspace.enterDomain', {
                        defaultValue: 'Open domain',
                      })}
                    </Button>
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      </div>
    </div>
  );
}

'use client';

import { Badge, Button, Card, Col, List, Row, Skeleton, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { AlertConfigForm } from '@/app/(app)/dashboard/alert-config-form';
import { AlertPanel } from '@/app/(app)/dashboard/alert-panel';
import {
  NotificationType,
  useAlertChannelsQuery,
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
  useUnreadNotificationCountQuery
} from '@/graphql/generated';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

const typeColor: Record<NotificationType, string> = {
  [NotificationType.CrawlCompleted]: 'green',
  [NotificationType.CrawlFailed]: 'red',
  [NotificationType.AnalysisCompleted]: 'blue',
  [NotificationType.AnalysisFailed]: 'red',
  [NotificationType.OrgInvite]: 'purple',
  [NotificationType.AlertTriggered]: 'orange',
  [NotificationType.System]: 'geekblue'
};

export default function SubscriptionsPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: channelsData, loading: channelsLoading, refetch: refetchChannels } = useAlertChannelsQuery();
  const {
    data: notificationsData,
    loading: notificationsLoading,
    refetch: refetchNotifications
  } = useNotificationsQuery({ variables: { limit: 50 } });
  const { data: unreadData, refetch: refetchUnread } = useUnreadNotificationCountQuery();
  const [markRead] = useMarkNotificationReadMutation();
  const [markAll] = useMarkAllNotificationsReadMutation();

  const unreadCount = unreadData?.unreadNotificationCount ?? 0;
  const channels = channelsData?.alertChannels ?? [];
  const notifications = notificationsData?.notifications ?? [];
  const isChannelsInitialLoading = channelsLoading && channels.length === 0;
  const isNotificationsInitialLoading = notificationsLoading && notifications.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <Typography.Title level={4}>Subscription Center</Typography.Title>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <AlertPanel />
        </Col>
        <Col xs={24} xl={10}>
          <AlertConfigForm />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={
              <Space size="middle" align="center">
                <Typography.Text strong>Alert Channels</Typography.Text>
              </Space>
            }
            extra={
              <Button size="small" onClick={() => void refetchChannels()}>
                {t('common.refresh')}
              </Button>
            }
          >
            {isChannelsInitialLoading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : (
              <List
                dataSource={channels}
                locale={{ emptyText: 'No alert channels configured.' }}
                renderItem={(channel) => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space size="small">
                          <Typography.Text strong>{channel.name}</Typography.Text>
                          <Tag>{channel.type}</Tag>
                        </Space>
                      }
                      description={<Typography.Text type="secondary">{channel.target}</Typography.Text>}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card
            className="content-card"
            title={
              <Space size="middle" align="center">
                <Typography.Text strong>Notifications</Typography.Text>
                <Badge count={unreadCount} size="small" />
              </Space>
            }
            extra={
              <Space size="small">
                <Button size="small" onClick={() => void refetchNotifications()}>
                  {t('common.refresh')}
                </Button>
                <Button
                  size="small"
                  onClick={async () => {
                    await markAll();
                    await Promise.all([refetchNotifications(), refetchUnread()]);
                  }}
                >
                  {t('notifications.markAllRead')}
                </Button>
              </Space>
            }
          >
            {isNotificationsInitialLoading ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : (
              <List
                dataSource={notifications}
                locale={{ emptyText: t('notifications.empty') }}
                renderItem={(item) => (
                  <List.Item
                    onClick={async () => {
                      if (!item.readAt) {
                        await markRead({ variables: { id: item.id } });
                        await Promise.all([refetchNotifications(), refetchUnread()]);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small" align="center">
                          <Tag color={typeColor[item.type] ?? 'default'}>
                            {t(`notifications.type.${item.type}`)}
                          </Tag>
                          <Typography.Text strong>{item.title}</Typography.Text>
                          {!item.readAt ? <Badge status="processing" /> : null}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          {item.body ? (
                            <Typography.Paragraph
                              style={{ marginBottom: 6 }}
                              ellipsis={{ rows: 2, expandable: false }}
                            >
                              {item.body}
                            </Typography.Paragraph>
                          ) : null}
                          <Typography.Text type="secondary">
                            {formatDateTime(item.createdAt, locale, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                              hour12: false
                            })}
                          </Typography.Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

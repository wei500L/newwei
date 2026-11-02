'use client';

import {
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SectionHeader } from '@/components/section-header';

export interface ApprovalProgress {
  orgCreated: boolean;
  inviteSaved: boolean;
  deliveryStatus: 'none' | 'sent' | 'failed' | 'unknown';
  deliveryAttempts: number;
  lastDeliveryAt?: string | null;
  lastDeliveryError?: string | null;
  associationComplete: boolean;
  needsRecovery: boolean;
  needsDeliveryRetry: boolean;
  inviteStatus?: string | null;
}

export interface RegistrationApplicationItem {
  id: string;
  type: 'new_org' | 'join_org';
  status: 'pending' | 'approved' | 'rejected';
  email: string;
  firstName: string;
  lastName: string;
  orgId?: string | null;
  requestedOrgName?: string | null;
  requestedOrgSlug?: string | null;
  decisionReason?: string | null;
  generatedInviteId?: string | null;
  org?: { id: string; name: string; slug: string } | null;
  approvalProgress?: ApprovalProgress | null;
}

export interface RecoverOrgInput {
  targetOrgId?: string;
  reason?: string;
}

export interface ApplicationsPanelProps {
  applications: {
    orgApplications: RegistrationApplicationItem[];
    platformApplications: RegistrationApplicationItem[];
  };
  loading: boolean;
  canManagePlatform: boolean;
  /** Application ids whose invite resend request is currently in flight. */
  pendingResendApplicationIds?: string[];
  onApproveJoin: (application: RegistrationApplicationItem) => void;
  onRejectJoin: (application: RegistrationApplicationItem) => void;
  onApproveOrg: (application: RegistrationApplicationItem) => void;
  onRejectOrg: (application: RegistrationApplicationItem) => void;
  onRecoverOrg: (
    application: RegistrationApplicationItem,
    input: RecoverOrgInput,
  ) => Promise<void> | void;
  onResendOrgInvite: (
    application: RegistrationApplicationItem,
  ) => Promise<void> | void;
}

type PlatformApplicationStageKind =
  | 'pending'
  | 'rejected'
  | 'needs-recovery'
  | 'delivery-failed'
  | 'delivery-unknown'
  | 'delivery-pending'
  | 'delivered'
  | 'approved';

interface PlatformApplicationStage {
  kind: PlatformApplicationStageKind;
  progressText: string;
  deliveryError?: string | null;
  inviteStatus?: string | null;
  canResend: boolean;
}

interface RecoverOrgFormValues {
  targetOrgId?: string;
  reason?: string;
}

const STATUS_TAG_COLORS: Record<RegistrationApplicationItem['status'], string> = {
  pending: 'gold',
  approved: 'green',
  rejected: 'red',
};

// Derive the platform application's next step from its approval progress and
// status. Approved rows that are only half-recorded must still surface as
// needs-recovery instead of being filtered out.
export function getPlatformApplicationStage(
  application: RegistrationApplicationItem,
): PlatformApplicationStage {
  if (application.status === 'rejected') {
    return { kind: 'rejected', progressText: 'Rejected', canResend: false };
  }

  if (application.status === 'pending') {
    return { kind: 'pending', progressText: 'Not started', canResend: false };
  }

  const progress = application.approvalProgress ?? null;
  if (!progress) {
    return { kind: 'approved', progressText: 'Approved', canResend: false };
  }

  if (progress.needsRecovery || !progress.associationComplete) {
    return {
      kind: 'needs-recovery',
      progressText: 'Needs recovery — organization/invite association missing',
      canResend: false,
    };
  }

  switch (progress.deliveryStatus) {
    case 'failed':
      return {
        kind: 'delivery-failed',
        progressText: 'Database complete — invitation delivery failed',
        deliveryError: progress.lastDeliveryError ?? null,
        canResend: true,
      };
    case 'unknown':
      return {
        kind: 'delivery-unknown',
        progressText: 'Database complete — delivery status unknown',
        canResend: true,
      };
    case 'none':
      // Committed database stage but the first send never ran (a crash between
      // the commit and the send). An explicit resend performs that first send.
      return {
        kind: 'delivery-pending',
        progressText: 'Database complete — invitation not yet delivered',
        canResend: true,
      };
    case 'sent':
      return {
        kind: 'delivered',
        progressText: 'Approved — invite delivered',
        inviteStatus: progress.inviteStatus ?? null,
        // Accepted / revoked invites must not be resent; only a pending one may.
        canResend: progress.inviteStatus === 'pending',
      };
    default:
      if (progress.needsDeliveryRetry) {
        return {
          kind: 'delivery-unknown',
          progressText: 'Database complete — invitation delivery needs attention',
          canResend: true,
        };
      }
      return { kind: 'approved', progressText: 'Approved', canResend: false };
  }
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function ApplicationsPanel({
  applications,
  loading,
  canManagePlatform,
  pendingResendApplicationIds = [],
  onApproveJoin,
  onRejectJoin,
  onApproveOrg,
  onRejectOrg,
  onRecoverOrg,
  onResendOrgInvite,
}: ApplicationsPanelProps) {
  const { t } = useTranslation();
  const [recoverTarget, setRecoverTarget] =
    useState<RegistrationApplicationItem | null>(null);
  const [recoverForm] = Form.useForm<RecoverOrgFormValues>();
  const [recovering, setRecovering] = useState(false);
  const pendingResendIds = new Set(pendingResendApplicationIds);

  useEffect(() => {
    if (recoverTarget) {
      recoverForm.resetFields();
    }
  }, [recoverForm, recoverTarget]);

  const handleRecoverSubmit = async () => {
    if (!recoverTarget) {
      return;
    }

    setRecovering(true);
    try {
      const values = await recoverForm.validateFields();
      await onRecoverOrg(recoverTarget, {
        targetOrgId: normalizeOptionalText(values.targetOrgId),
        reason: normalizeOptionalText(values.reason),
      });
      setRecoverTarget(null);
      recoverForm.resetFields();
    } catch {
      // Keep the modal open on validation or recover failure; the caller
      // surfaces the server error message.
    } finally {
      setRecovering(false);
    }
  };

  const platformColumns: TableColumnsType<RegistrationApplicationItem> = [
    { title: t('settings.applications.columns.email'), dataIndex: 'email', key: 'email' },
    {
      title: t('settings.applications.columns.organization'),
      key: 'org',
      render: (_, row) =>
        `${row.requestedOrgName ?? '-'} (${row.requestedOrgSlug ?? '-'})`,
    },
    {
      title: t('settings.applications.columns.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: RegistrationApplicationItem['status']) => (
        <Tag color={STATUS_TAG_COLORS[status]}>{status}</Tag>
      ),
    },
    {
      title: t('settings.applications.columns.progress'),
      key: 'progress',
      render: (_, row) => {
        const stage = getPlatformApplicationStage(row);
        return (
          <Space direction="vertical" size="small">
            <span>{stage.progressText}</span>
            {stage.deliveryError ? (
              <Typography.Text type="secondary">
                {stage.deliveryError}
              </Typography.Text>
            ) : null}
            {stage.inviteStatus ? (
              <Typography.Text type="secondary">
                {t('settings.applications.inviteStatus', { status: stage.inviteStatus })}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: t('settings.applications.columns.actions'),
      key: 'actions',
      render: (_, row) => {
        const stage = getPlatformApplicationStage(row);

        if (stage.kind === 'pending') {
          return (
            <Space>
              <Button size="small" onClick={() => onApproveOrg(row)}>
                {t('settings.applications.actions.approve')}
              </Button>
              <Button size="small" danger onClick={() => onRejectOrg(row)}>
                {t('settings.applications.actions.reject')}
              </Button>
            </Space>
          );
        }

        if (stage.kind === 'needs-recovery') {
          return (
            <Button size="small" onClick={() => setRecoverTarget(row)}>
              {t('settings.applications.actions.recover')}
            </Button>
          );
        }

        if (stage.canResend) {
          const isPending = pendingResendIds.has(row.id);
          return (
            <Button
              size="small"
              loading={isPending}
              disabled={isPending}
              onClick={() => {
                if (isPending) {
                  return;
                }
                void onResendOrgInvite(row);
              }}
            >
              {t('settings.applications.actions.resend')}
            </Button>
          );
        }

        return null;
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <SectionHeader title={t('settings.applications.joinRequests')} rule />
        <Table
          scroll={{ x: "max-content" }}
          rowKey="id"
          loading={loading}
          dataSource={applications.orgApplications}
          pagination={false}
          columns={[
            { title: t('settings.applications.columns.email'), dataIndex: 'email', key: 'email' },
            {
              title: t('settings.applications.columns.name'),
              key: 'name',
              render: (_, row) => `${row.firstName} ${row.lastName}`,
            },
            { title: t('settings.applications.columns.status'), dataIndex: 'status', key: 'status' },
            {
              title: t('settings.applications.columns.actions'),
              key: 'actions',
              render: (_, row) => (
                <Space>
                  <Button size="small" onClick={() => onApproveJoin(row)}>
                    {t('settings.applications.actions.approve')}
                  </Button>
                  <Button size="small" danger onClick={() => onRejectJoin(row)}>
                    {t('settings.applications.actions.reject')}
                  </Button>
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: <Empty description={t('settings.applications.emptyJoin')} /> }}
        />
      </section>

      {canManagePlatform ? (
        <section className="flex flex-col gap-3">
          <SectionHeader title={t('settings.applications.newOrgRequests')} rule />
          <Table
            scroll={{ x: "max-content" }}
            rowKey="id"
            loading={loading}
            dataSource={applications.platformApplications}
            pagination={false}
            columns={platformColumns}
            locale={{
              emptyText: <Empty description={t('settings.applications.emptyOrg')} />,
            }}
          />
        </section>
      ) : null}

      <Modal
        open={Boolean(recoverTarget)}
        title={
          recoverTarget
            ? t('settings.applications.recoverModal.titleNamed', {
                name: recoverTarget.requestedOrgName ?? recoverTarget.email,
              })
            : t('settings.applications.recoverModal.title')
        }
        okText={t('settings.applications.actions.recover')}
        confirmLoading={recovering}
        onOk={() => void handleRecoverSubmit()}
        onCancel={() => {
          if (!recovering) {
            setRecoverTarget(null);
          }
        }}
      >
        <Form form={recoverForm} layout="vertical">
          <Typography.Paragraph type="secondary">
            {t('settings.applications.recoverModal.description')}
          </Typography.Paragraph>
          <Form.Item
            label={t('settings.applications.recoverModal.targetOrgId')}
            name="targetOrgId"
          >
            <Input placeholder={t('settings.applications.recoverModal.placeholder')} allowClear />
          </Form.Item>
          <Form.Item label={t('settings.applications.recoverModal.reason')} name="reason">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

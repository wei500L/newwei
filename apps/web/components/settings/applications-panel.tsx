'use client';

import {
  Button,
  Card,
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
    { title: 'Email', dataIndex: 'email', key: 'email' },
    {
      title: 'Organization',
      key: 'org',
      render: (_, row) =>
        `${row.requestedOrgName ?? '-'} (${row.requestedOrgSlug ?? '-'})`,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: RegistrationApplicationItem['status']) => (
        <Tag color={STATUS_TAG_COLORS[status]}>{status}</Tag>
      ),
    },
    {
      title: 'Progress',
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
                Invite: {stage.inviteStatus}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, row) => {
        const stage = getPlatformApplicationStage(row);

        if (stage.kind === 'pending') {
          return (
            <Space>
              <Button size="small" onClick={() => onApproveOrg(row)}>
                Approve
              </Button>
              <Button size="small" danger onClick={() => onRejectOrg(row)}>
                Reject
              </Button>
            </Space>
          );
        }

        if (stage.kind === 'needs-recovery') {
          return (
            <Button size="small" onClick={() => setRecoverTarget(row)}>
              Recover
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
              Resend invite
            </Button>
          );
        }

        return null;
      },
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Card size="small" title="Join requests">
        <Table
          rowKey="id"
          loading={loading}
          dataSource={applications.orgApplications}
          pagination={false}
          columns={[
            { title: 'Email', dataIndex: 'email', key: 'email' },
            {
              title: 'Name',
              key: 'name',
              render: (_, row) => `${row.firstName} ${row.lastName}`,
            },
            { title: 'Status', dataIndex: 'status', key: 'status' },
            {
              title: 'Actions',
              key: 'actions',
              render: (_, row) => (
                <Space>
                  <Button size="small" onClick={() => onApproveJoin(row)}>
                    Approve
                  </Button>
                  <Button size="small" danger onClick={() => onRejectJoin(row)}>
                    Reject
                  </Button>
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: <Empty description="No join requests" /> }}
        />
      </Card>

      {canManagePlatform ? (
        <Card size="small" title="New organization requests">
          <Table
            rowKey="id"
            loading={loading}
            dataSource={applications.platformApplications}
            pagination={false}
            columns={platformColumns}
            locale={{
              emptyText: <Empty description="No organization requests" />,
            }}
          />
        </Card>
      ) : null}

      <Modal
        open={Boolean(recoverTarget)}
        title={
          recoverTarget
            ? `Recover ${recoverTarget.requestedOrgName ?? recoverTarget.email}`
            : 'Recover application'
        }
        okText="Recover"
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
            Leave the target organization ID empty to let the server create the
            organization when the requested slug is free. Only enter an ID to
            adopt an orphaned organization that already exists; the server
            verifies the target before linking it.
          </Typography.Paragraph>
          <Form.Item
            label="Target organization ID (optional)"
            name="targetOrgId"
          >
            <Input placeholder="org_..." allowClear />
          </Form.Item>
          <Form.Item label="Reason (optional)" name="reason">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

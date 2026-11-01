import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import {
  ApplicationsPanel,
  type ApplicationsPanelProps,
  type ApprovalProgress,
  type RegistrationApplicationItem,
} from './applications-panel';

function buildProgress(overrides: Partial<ApprovalProgress> = {}): ApprovalProgress {
  return {
    orgCreated: true,
    inviteSaved: true,
    deliveryStatus: 'none',
    deliveryAttempts: 0,
    lastDeliveryAt: null,
    lastDeliveryError: null,
    associationComplete: true,
    needsRecovery: false,
    needsDeliveryRetry: false,
    inviteStatus: null,
    ...overrides,
  };
}

function buildApplication(
  overrides: Partial<RegistrationApplicationItem> = {},
): RegistrationApplicationItem {
  return {
    id: 'app-1',
    type: 'new_org',
    status: 'pending',
    email: 'applicant@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    requestedOrgName: 'Analytical Engine',
    requestedOrgSlug: 'analytical-engine',
    ...overrides,
  };
}

function createProps(
  overrides: Partial<ApplicationsPanelProps> = {},
): ApplicationsPanelProps {
  return {
    applications: { orgApplications: [], platformApplications: [] },
    loading: false,
    canManagePlatform: true,
    pendingResendApplicationIds: [],
    onApproveJoin: vi.fn(),
    onRejectJoin: vi.fn(),
    onApproveOrg: vi.fn(),
    onRejectOrg: vi.fn(),
    onRecoverOrg: vi.fn().mockResolvedValue(undefined),
    onResendOrgInvite: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function platformApplications(
  platformApplications: RegistrationApplicationItem[],
) {
  return { orgApplications: [], platformApplications };
}

describe('ApplicationsPanel', () => {
  it('keeps a half-complete approved record visible and offers a recover action', () => {
    const props = createProps({
      applications: platformApplications([
        buildApplication({
          id: 'app-recovery',
          status: 'approved',
          approvalProgress: buildProgress({
            orgCreated: false,
            inviteSaved: true,
            associationComplete: false,
            needsRecovery: true,
            deliveryStatus: 'none',
          }),
        }),
      ]),
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    // Approved record is not filtered out of the platform list.
    expect(screen.getByText('applicant@example.com')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Needs recovery — organization/invite association missing',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Recover' }),
    ).toBeInTheDocument();
  });

  it('shows the delivery failure reason and resends at most once while pending', async () => {
    const user = userEvent.setup();
    let resolveResend: (() => void) | undefined;
    const onResendOrgInvite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResend = resolve;
        }),
    );
    const application = buildApplication({
      id: 'app-failed',
      status: 'approved',
      approvalProgress: buildProgress({
        deliveryStatus: 'failed',
        lastDeliveryError: 'SMTP 550 mailbox unavailable',
        needsDeliveryRetry: true,
      }),
    });
    const props = createProps({
      applications: platformApplications([application]),
      pendingResendApplicationIds: [],
      onResendOrgInvite,
    });

    const { rerender } = renderWithProviders(<ApplicationsPanel {...props} />);

    expect(
      screen.getByText('Database complete — invitation delivery failed'),
    ).toBeInTheDocument();
    expect(screen.getByText('SMTP 550 mailbox unavailable')).toBeInTheDocument();

    const resendButton = screen.getByRole('button', { name: 'Resend invite' });
    await user.click(resendButton);
    expect(onResendOrgInvite).toHaveBeenCalledTimes(1);
    expect(onResendOrgInvite).toHaveBeenCalledWith(application);

    // The parent marks the row pending after the first click; the action is
    // disabled and any further click is ignored.
    rerender(
      <ApplicationsPanel
        {...props}
        pendingResendApplicationIds={['app-failed']}
      />,
    );
    const pendingButton = screen.getByRole('button', { name: 'Resend invite' });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(onResendOrgInvite).toHaveBeenCalledTimes(1);

    resolveResend?.();
  });

  it('opens the recover modal and submits the entered target org id and reason', async () => {
    const user = userEvent.setup();
    const onRecoverOrg = vi.fn().mockResolvedValue(undefined);
    const application = buildApplication({
      id: 'app-recovery',
      status: 'approved',
      approvalProgress: buildProgress({
        associationComplete: false,
        needsRecovery: true,
      }),
    });
    const props = createProps({
      applications: platformApplications([application]),
      onRecoverOrg,
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    await user.click(screen.getByRole('button', { name: 'Recover' }));

    const dialog = await screen.findByRole('dialog');
    const targetInput = within(dialog).getByPlaceholderText('org_...');
    const reasonInput = within(dialog).getAllByRole('textbox')[1]!;
    await user.type(targetInput, 'org-123');
    await user.type(reasonInput, 'adopt orphaned org');
    await user.click(within(dialog).getByRole('button', { name: 'Recover' }));

    await waitFor(() => {
      expect(onRecoverOrg).toHaveBeenCalledWith(application, {
        targetOrgId: 'org-123',
        reason: 'adopt orphaned org',
      });
    });
  });

  it('submits undefined target org id and reason when the recover form is empty', async () => {
    const user = userEvent.setup();
    const onRecoverOrg = vi.fn().mockResolvedValue(undefined);
    const application = buildApplication({
      id: 'app-recovery',
      status: 'approved',
      approvalProgress: buildProgress({
        associationComplete: false,
        needsRecovery: true,
      }),
    });
    const props = createProps({
      applications: platformApplications([application]),
      onRecoverOrg,
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    await user.click(screen.getByRole('button', { name: 'Recover' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Recover' }));

    await waitFor(() => {
      expect(onRecoverOrg).toHaveBeenCalledWith(application, {
        targetOrgId: undefined,
        reason: undefined,
      });
    });
  });

  it('does not offer a resend action for accepted or revoked invites', () => {
    const props = createProps({
      applications: platformApplications([
        buildApplication({
          id: 'app-accepted',
          status: 'approved',
          approvalProgress: buildProgress({
            deliveryStatus: 'sent',
            inviteStatus: 'accepted',
          }),
        }),
        buildApplication({
          id: 'app-revoked',
          status: 'approved',
          approvalProgress: buildProgress({
            deliveryStatus: 'sent',
            inviteStatus: 'revoked',
          }),
        }),
      ]),
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    expect(
      screen.getAllByText('Approved — invite delivered'),
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: 'Resend invite' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Invite: accepted')).toBeInTheDocument();
    expect(screen.getByText('Invite: revoked')).toBeInTheDocument();
  });

  it('offers a resend action when a delivered invite is still pending', () => {
    const props = createProps({
      applications: platformApplications([
        buildApplication({
          id: 'app-pending-invite',
          status: 'approved',
          approvalProgress: buildProgress({
            deliveryStatus: 'sent',
            inviteStatus: 'pending',
          }),
        }),
      ]),
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    expect(
      screen.getByRole('button', { name: 'Resend invite' }),
    ).toBeInTheDocument();
  });

  it('does not render the platform card when canManagePlatform is false', () => {
    const props = createProps({
      canManagePlatform: false,
      applications: platformApplications([
        buildApplication({ id: 'app-pending', status: 'pending' }),
      ]),
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    expect(
      screen.queryByText('New organization requests'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Join requests')).toBeInTheDocument();
  });

  it('shows approve and reject actions for a pending organization request', () => {
    const props = createProps({
      applications: platformApplications([
        buildApplication({ id: 'app-pending', status: 'pending' }),
      ]),
    });

    renderWithProviders(<ApplicationsPanel {...props} />);

    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reject' }),
    ).toBeInTheDocument();
  });
});

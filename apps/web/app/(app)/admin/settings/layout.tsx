import type { ReactNode } from 'react';

import { AdminSettingsWorkspaceLayout } from './settings-workspace-layout';

export default function AdminSettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <AdminSettingsWorkspaceLayout>{children}</AdminSettingsWorkspaceLayout>;
}

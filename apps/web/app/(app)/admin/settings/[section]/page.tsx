import { notFound, redirect } from 'next/navigation';

import { AccessSettingsContent } from '@/components/settings/access-settings-content';
import { auth } from '@/lib/auth';

import { AdminSettingsSectionContent } from '../settings-section-content';
import { isAdminSettingsPageId } from '../settings-navigation';

interface AdminSettingsSectionPageParams {
  section: string;
}

export default async function AdminSettingsSectionPage({
  params,
}: {
  params: Promise<AdminSettingsSectionPageParams>;
}) {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const { section } = await params;
  if (!isAdminSettingsPageId(section)) {
    notFound();
  }

  if (section === 'access') {
    return <AccessSettingsContent />;
  }

  return <AdminSettingsSectionContent pageId={section} />;
}

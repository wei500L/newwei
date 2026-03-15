import { notFound, redirect } from "next/navigation";

import { AccessSettingsContent } from "@/components/settings/access-settings-content";
import { auth } from "@/lib/auth";

import { AdminSettingsSectionContent } from "../settings-section-content";
import { isAdminSettingsPageId } from "../settings-navigation";

export default async function AdminSettingsSectionPage({
  params,
}: {
  params: { section: string };
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const { section } = params;
  if (!isAdminSettingsPageId(section)) {
    notFound();
  }

  if (section === "access") {
    return <AccessSettingsContent />;
  }

  return <AdminSettingsSectionContent pageId={section} />;
}

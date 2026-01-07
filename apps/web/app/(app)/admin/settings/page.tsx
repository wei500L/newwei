import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { SettingsContent } from "@/app/(app)/settings/settings-content";

export default async function AdminSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SettingsContent />;
}

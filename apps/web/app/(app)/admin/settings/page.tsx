import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AdminSettingsOverviewContent } from "./settings-overview-content";

export default async function AdminSettingsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AdminSettingsOverviewContent />;
}

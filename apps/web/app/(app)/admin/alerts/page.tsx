import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AlertsConfigContent } from "./alerts-config-content";

export default async function AdminAlertsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AlertsConfigContent />;
}

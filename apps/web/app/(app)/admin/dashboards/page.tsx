import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { DashboardsContent } from "./dashboards-content";

export default async function AdminDashboardsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <DashboardsContent />;
}

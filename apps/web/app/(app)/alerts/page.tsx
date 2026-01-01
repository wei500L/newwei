import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AlertCenterContent } from "./alert-center";

export default async function AlertsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AlertCenterContent />;
}

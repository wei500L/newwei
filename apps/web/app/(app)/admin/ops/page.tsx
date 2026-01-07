import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { OpsContent } from "./ops-content";

export default async function OpsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <OpsContent />;
}

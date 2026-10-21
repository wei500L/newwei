import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { QueueOpsContent } from "./queue-ops-content";

export default async function AdminQueueOpsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <QueueOpsContent />;
}

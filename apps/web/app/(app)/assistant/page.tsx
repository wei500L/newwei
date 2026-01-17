import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AssistantContent } from "./assistant-content";

export default async function AssistantPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AssistantContent />;
}


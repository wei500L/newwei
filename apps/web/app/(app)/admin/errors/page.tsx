import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { ErrorsContent } from "./errors-content";

export default async function ErrorsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ErrorsContent />;
}


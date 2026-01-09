import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { QualityContent } from "./quality-content";

export default async function AdminQualityPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <QualityContent />;
}

